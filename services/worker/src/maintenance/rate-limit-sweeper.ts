import type { Pool } from 'pg';

/**
 * PE-009 §C · Removing callers who stopped calling.
 *
 * `engage.public_rate_limits` holds one row per (hospital, bucket, caller) and
 * rolls its own window in place, so it is bounded by *distinct callers* rather
 * than by traffic — it cannot run away. What it does accumulate is a row for
 * every address that asked one question a year ago and never came back.
 *
 * ── Why this is a job and not a dice roll on the request path ──────────────
 *
 * The first version swept opportunistically: `if (Math.random() < 0.02)` inside
 * the chat handler. The lint rule that forbids `Math.random()` outside a seeded
 * generator caught it, and the rule was right for a reason beyond
 * reproducibility — a housekeeping delete that fires on 2% of visitors is a
 * delete nobody can test, nobody can schedule and nobody can turn off, sitting
 * in front of the one page a stranger loads on a phone.
 *
 * It belongs here, on the same lane as the audit sealer and the partition
 * premake: periodic regardless of load, cross-tenant, on the maintenance
 * connection.
 *
 * Cross-tenant by nature, so it runs on the maintenance role rather than
 * `hms_app` — which is also why it can delete for every hospital in one
 * statement instead of once per tenant.
 */
export interface RateLimitSweepResult {
  readonly deleted: number;
}

/**
 * Deletes counters whose window closed more than `staleAfterSeconds` ago.
 *
 * The default is deliberately many multiples of the limiter's own window: a row
 * removed while its window is still open would hand a caller a fresh budget,
 * which is the one failure mode a sweep must not have.
 */
export async function sweepPublicRateLimits(
  pool: Pool,
  options: { readonly staleAfterSeconds?: number } = {},
): Promise<RateLimitSweepResult> {
  const staleAfterSeconds = options.staleAfterSeconds ?? 60 * 60 * 24;
  const result = await pool.query(
    `DELETE FROM engage.public_rate_limits
      WHERE window_start < now() - make_interval(secs => $1)`,
    [staleAfterSeconds],
  );
  return { deleted: result.rowCount ?? 0 };
}
