import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import { DatabaseService } from '../db/database.service.js';
import { getContext } from '../context/request-context.js';
import { currentTenantContext } from '../tenancy/tenant-context.js';

/**
 * The store behind `@Idempotent()` — `core.idempotency_keys`, which has existed
 * since the Phase-0 platform migration and was never used.
 *
 * **Why Postgres and not Redis.** Two API pods do not share a mutex, but they do
 * share a row lock. The whole correctness argument below rests on
 * `INSERT … ON CONFLICT DO UPDATE` taking a row-level lock on the conflicting
 * tuple: the second of two simultaneous requests blocks until the first has
 * committed its reservation, then re-evaluates against the committed row and
 * loses. Redis could do this with a Lua script, but it would put the
 * "did this already run?" answer in a store that is allowed to be evicted, and
 * `docs/01` §3 is explicit that a money-moving decision belongs in the database
 * that also holds the money.
 *
 * **Why each call is its own transaction.** The reservation must be *visible* to
 * a competing request before the handler runs. If it were written inside the
 * handler's transaction, the competitor would block for the whole duration of
 * the handler and then be admitted, which is the opposite of the intent.
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  /**
   * Claim the key for this attempt, or explain why this attempt may not run.
   *
   * Exactly one caller can receive `proceed` for a given (hospital, key, route)
   * while an attempt is live. Every other outcome is a refusal or a replay.
   */
  async reserve(input: ReserveInput): Promise<Reservation> {
    const ctx = getContext();
    const id = newId();
    const tenant = currentTenantContext();

    return this.db.withTenant(tenant, async (tx) => {
      // The `WHERE` on the DO UPDATE is the entire admission policy, and it is
      // deliberately narrow. A row may be taken over only when it is:
      //   - past its TTL, in which case it is not a live key at all; or
      //   - the *same* request that previously failed, so a retry after a
      //     rolled-back handler is allowed rather than being wedged forever; or
      //   - the *same* request whose lock has elapsed, i.e. the pod that held it
      //     died mid-flight.
      // Anything else falls through to the classification read below.
      const claimed = await tx.maybeOne<{ id: string }>(
        `INSERT INTO core.idempotency_keys AS ik
           (id, hospital_id, key, user_id, route, method, request_hash,
            status, locked_until, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'in_flight',
                 now() + make_interval(secs => $8::int),
                 now(),
                 now() + make_interval(hours => $9::int))
         ON CONFLICT (hospital_id, key, route) DO UPDATE
            SET user_id         = EXCLUDED.user_id,
                method          = EXCLUDED.method,
                request_hash    = EXCLUDED.request_hash,
                status          = 'in_flight',
                locked_until    = EXCLUDED.locked_until,
                created_at      = now(),
                completed_at    = NULL,
                response_status = NULL,
                response_body   = NULL,
                expires_at      = EXCLUDED.expires_at
          WHERE ik.expires_at <= now()
             OR (ik.request_hash = EXCLUDED.request_hash
                 AND (ik.status = 'failed'
                      OR (ik.status = 'in_flight' AND ik.locked_until <= now())))
         RETURNING ik.id`,
        [
          id,
          ctx.hospitalId,
          input.key,
          ctx.userId,
          input.route,
          input.method,
          input.requestHash,
          input.lockSeconds,
          input.ttlHours,
        ],
      );

      if (claimed !== undefined) return { kind: 'proceed', id: claimed.id } as const;

      // No row came back, so the key exists and this attempt is not allowed to
      // take it. Read it to say *why* — the distinction between "you already
      // sent this" and "you sent something else under the same key" is the whole
      // point of storing the fingerprint.
      const existing = await tx.maybeOne<ExistingRow>(
        `SELECT status, request_hash, response_status, response_body
           FROM core.idempotency_keys
          WHERE hospital_id = $1 AND key = $2 AND route = $3`,
        [ctx.hospitalId, input.key, input.route],
      );

      if (existing === undefined) {
        // The row was purged between the two statements. Treating it as in
        // flight costs the caller one retry; treating it as absent would let a
        // duplicate through, which is the failure this class exists to prevent.
        return { kind: 'in_flight' } as const;
      }

      if (existing.request_hash !== input.requestHash) {
        return { kind: 'fingerprint_mismatch' } as const;
      }

      if (existing.status === 'completed') {
        return {
          kind: 'replay',
          status: existing.response_status ?? 200,
          body: existing.response_body,
        } as const;
      }

      return { kind: 'in_flight' } as const;
    });
  }

  /** Record the answer, so every later repeat of this key gets the same one. */
  async complete(reservationId: string, status: number, body: unknown): Promise<void> {
    await this.db.withTenant(currentTenantContext(), async (tx) => {
      await tx.query(
        `UPDATE core.idempotency_keys
            SET status = 'completed',
                response_status = $2,
                response_body = $3::jsonb,
                completed_at = now(),
                locked_until = NULL
          WHERE id = $1`,
        [reservationId, status, JSON.stringify(body ?? null)],
      );
    });
  }

  /**
   * Release the key after a failed attempt.
   *
   * Nothing was committed: every handler in this service runs inside
   * `DatabaseService.withTenant`, which rolls back on any throw, so a failed
   * attempt left no row behind and the same request may safely be run again.
   * The row is kept rather than deleted so the attempt is visible to whoever
   * investigates, and so a retry with a *different* body still meets the
   * fingerprint check.
   */
  async abandon(reservationId: string): Promise<void> {
    try {
      await this.db.withTenant(currentTenantContext(), async (tx) => {
        await tx.query(
          `UPDATE core.idempotency_keys
              SET status = 'failed', locked_until = NULL, completed_at = now()
            WHERE id = $1`,
          [reservationId],
        );
      });
    } catch {
      // Swallowed on purpose: this runs on the error path, and letting it throw
      // would replace the error the caller actually needs to see with a database
      // error about bookkeeping. The lock expires by itself.
    }
  }

  /**
   * Delete this tenant's expired keys.
   *
   * The documented schedule is hourly, from the worker (`services/worker`), and
   * it matters for more than table size: a stored response can carry PHI — the
   * registration reply contains a patient's name and UHID — so `docs/04` §3
   * makes its 24-hour lifetime a retention obligation, not a housekeeping
   * preference. A cross-tenant sweep is the retention role's
   * `core.purge_expired_idempotency_keys()`, because this call is confined to
   * one hospital by row-level security exactly like every other application read.
   */
  async purgeExpired(): Promise<number> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const result = await tx.query(`DELETE FROM core.idempotency_keys WHERE expires_at <= now()`);
      return result.rowCount ?? 0;
    });
  }
}

export interface ReserveInput {
  readonly key: string;
  readonly route: string;
  readonly method: string;
  readonly requestHash: string;
  readonly ttlHours: number;
  readonly lockSeconds: number;
}

export type Reservation =
  /** This attempt owns the key and must run the handler. */
  | { readonly kind: 'proceed'; readonly id: string }
  /** The same request already completed; answer with what it answered. */
  | { readonly kind: 'replay'; readonly status: number; readonly body: unknown }
  /** The same request is running right now, elsewhere. */
  | { readonly kind: 'in_flight' }
  /** The key is in use for a *different* request. A client bug. */
  | { readonly kind: 'fingerprint_mismatch' };

interface ExistingRow {
  readonly status: string;
  readonly request_hash: string;
  readonly response_status: number | null;
  readonly response_body: unknown;
}
