import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../../../core/config/env.js';
import { DatabaseService } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';

/**
 * PE-009 §C · The counter in front of the unauthenticated endpoints.
 *
 * ── Why it opens its own transaction ───────────────────────────────────────
 *
 * This is the whole reason the service exists as a separate object. Counting
 * inside the request's transaction produces a limiter that does not limit: the
 * attacker sends requests that fail, the transaction rolls back, and the
 * increment rolls back with it — so an endpoint that errors is unmetered, which
 * is precisely the endpoint an attacker will aim at.
 *
 * `withHospitalScope` here therefore commits before the work begins.
 *
 * ── Why Postgres ───────────────────────────────────────────────────────────
 *
 * `core.idempotency_keys` made the same call and gave the reasons: two API pods
 * share a database and not a mutex, and `CLAUDE.md` §8 prefers Postgres to a new
 * dependency. The row rolls its own window, so the table is bounded by distinct
 * callers rather than by traffic.
 *
 * ── Why the address is hashed ──────────────────────────────────────────────
 *
 * Telling two callers apart does not require knowing where either lives. The
 * table has no column that could hold an address, so no future query can start
 * logging them.
 *
 * ── And why there is no sweep here ─────────────────────────────────────────
 *
 * There was one, fired on 2% of requests by `Math.random()`. A housekeeping
 * delete nobody can test, schedule or turn off, sitting in front of the one
 * page a stranger loads on a phone. It is now `sweepPublicRateLimits` on the
 * worker's maintenance lane, beside the audit sealer and the partition
 * premake — which is where periodic cross-tenant work belongs. The table is
 * bounded by distinct callers in any case: one row each, rolled in place.
 */
@Injectable()
export class PublicRateLimitService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Counts one hit and throws 429 once `max` is exceeded in the window.
   *
   * A caller with no resolvable address (a proxy that strips it) is bucketed
   * under a single shared key rather than waved through. That is deliberately
   * the pessimistic reading: an unattributable flood is exactly what a limiter
   * is for.
   */
  async consume(hospitalId: string, bucket: string, ip: string | null, max: number): Promise<void> {
    const subject = createHash('sha256')
      .update(ip ?? 'unattributed')
      .digest();
    const windowSeconds = this.env.ASSISTANT_RATE_WINDOW_SECONDS;

    const hits = await this.db.withHospitalScope(hospitalId, async (tx) => {
      // One statement, so two concurrent requests cannot both read 9 and both
      // write 10. The window rolls inside the UPDATE for the same reason.
      const result = await tx.query<{ hits: number }>(
        `INSERT INTO engage.public_rate_limits (hospital_id, bucket, subject_hash, window_start, hits)
              VALUES ($1, $2, $3, now(), 1)
         ON CONFLICT (hospital_id, bucket, subject_hash) DO UPDATE
            SET window_start = CASE
                  WHEN engage.public_rate_limits.window_start < now() - make_interval(secs => $4)
                  THEN now() ELSE engage.public_rate_limits.window_start END,
                hits = CASE
                  WHEN engage.public_rate_limits.window_start < now() - make_interval(secs => $4)
                  THEN 1 ELSE engage.public_rate_limits.hits + 1 END
          RETURNING hits`,
        [hospitalId, bucket, subject, windowSeconds],
      );
      return result.rows[0]?.hits ?? 1;
    });

    if (hits > max) {
      throw AppError.rateLimited(
        'You have sent a lot of messages in a short time. Please wait a few minutes and try again — or call the hospital directly if this is urgent.',
      );
    }
  }
}
