import type { Pool } from 'pg';

/**
 * Seals the audit hash chain.
 *
 * Decision D-16: `core.audit_log.seq`, `prev_hash` and `row_hash` are NULL when a
 * row is written, and this pass stamps them afterwards. Assigning a gapless
 * per-hospital sequence inline would need a row lock held until the writing
 * transaction commits, so one slow clinical transaction would block every other
 * audit write for that hospital — and because `EN-024` §5 rolls back a mutation
 * whose audit fails, that stall becomes a nurse unable to chart.
 *
 * `core.seal_audit_chain()` takes an advisory lock so only one writer per tenant
 * seals at a time; running this on several replicas is therefore safe.
 *
 * An unsealed backlog is an alertable anomaly, not a cosmetic one: until a row is
 * sealed it is not yet covered by the tamper-evidence the §65B evidence chain
 * depends on. `core.v_audit_seal_backlog` exists to be watched.
 */
export interface SealResult {
  readonly hospitalId: string;
  readonly sealed: number;
}

export async function sealAuditChains(pool: Pool): Promise<readonly SealResult[]> {
  const { rows: tenants } = await pool.query<{ hospital_id: string }>(
    `SELECT DISTINCT hospital_id FROM core.audit_log WHERE sealed_at IS NULL`,
  );

  const results: SealResult[] = [];
  for (const { hospital_id } of tenants) {
    const { rows } = await pool.query<{ sealed: number }>(
      // Explicit cast: a bare $1 arrives as `unknown` and Postgres cannot pick
      // an overload for it.
      `SELECT core.seal_audit_chain($1::uuid) AS sealed`,
      [hospital_id],
    );
    results.push({ hospitalId: hospital_id, sealed: Number(rows[0]?.sealed ?? 0) });
  }
  return results;
}

/**
 * Verifies a tenant's chain and returns every discrepancy the database can
 * detect: sequence gaps, broken linkage, post-seal modification and back-dated
 * insertion.
 *
 * Returning findings rather than throwing is deliberate — the caller decides
 * whether this is an alert, a ticket or an incident, and a verification job that
 * dies on the first finding never reports the other three.
 */
export async function verifyAuditChain(
  pool: Pool,
  hospitalId: string,
  window: { readonly from?: Date; readonly to?: Date } = {},
): Promise<readonly Record<string, unknown>[]> {
  // The function verifies a window rather than the whole table: at 8-15 M audit
  // rows a day (EN-024 §13) a full-history verification is a nightly job, while
  // the hourly integrity check only needs to cover what has just been sealed.
  const from = window.from ?? new Date(0);
  const to = window.to ?? new Date(Date.now() + 60_000);
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT * FROM core.verify_audit_chain($1::uuid, $2::timestamptz, $3::timestamptz)`,
    [hospitalId, from.toISOString(), to.toISOString()],
  );
  return rows;
}
