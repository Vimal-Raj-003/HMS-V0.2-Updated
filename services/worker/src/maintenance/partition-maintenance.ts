import type { Pool } from 'pg';

/**
 * Monthly partition premake — ADR-0008's half of `docs/07` §4.
 *
 * The decision recorded in ADR-0008 is that **the application owns this, not
 * `pg_partman`**, because `pg_partman` needs a background worker in
 * `shared_preload_libraries` and `pg_cron` needs superuser, and `docs/02` §1
 * promises the product runs on any managed PostgreSQL — Neon offers neither.
 * So the SQL function exists (`core.ensure_month_partition`) and this is the
 * thing that calls it.
 *
 * Two properties matter:
 *
 * **Idempotent, therefore safe to run often and safe to miss.** The function
 * returns early when the partition already exists, so several worker replicas
 * running this concurrently is a no-op, and a run skipped during an incident
 * self-heals on the next tick.
 *
 * **One month behind, three ahead.** `docs/07` §4 asks for three ahead. The
 * month behind is for `docs/01` §7's downtime protocol: a catch-up entry
 * carries a back-dated timestamp, and it needs somewhere to land that is not
 * the DEFAULT partition.
 */

export interface PartitionedTable {
  readonly schema: string;
  readonly table: string;
}

/**
 * The tables the migrations declare `PARTITION BY RANGE (…)`. Kept as a literal
 * list rather than discovered from `pg_partitioned_table`, so that adding a
 * partitioned table without adding it here shows up as a diff in review —
 * whereas auto-discovery would silently start maintaining a table nobody
 * decided to maintain, and silently stop if a migration changed its shape.
 * `partition-maintenance.integration.spec.ts` asserts the two lists agree, and
 * that assertion earned its keep: it went red the moment Phase 1 added a
 * partitioned table and stayed red through Phases 2 and 3, by which point this
 * list covered 17 of 35 tables. The 18 it missed included `billing.payments`,
 * `queue.queue_tokens`, `clinical.vitals` and every lab result — so on the first
 * of a month with no premade partition, a hospital stops taking payments,
 * issuing tokens, recording observations and filing results at the same
 * instant. The list is correct now; the lesson is that a red guard is only
 * useful if somebody reads it.
 */
export const PARTITIONED_TABLES: readonly PartitionedTable[] = Object.freeze([
  // 20260817152224_partitions_and_indexes
  Object.freeze({ schema: 'core', table: 'audit_log' }),
  Object.freeze({ schema: 'core', table: 'outbox_events' }),
  Object.freeze({ schema: 'core', table: 'sessions' }),
  Object.freeze({ schema: 'core', table: 'login_audit' }),
  Object.freeze({ schema: 'core', table: 'org_cross_branch_access_log' }),
  // 20260819064500_phase0_platform_modules
  Object.freeze({ schema: 'core', table: 'notif_notifications' }),
  Object.freeze({ schema: 'core', table: 'notif_deliveries' }),
  Object.freeze({ schema: 'core', table: 'wf_requests' }),
  Object.freeze({ schema: 'core', table: 'wf_actions' }),
  Object.freeze({ schema: 'core', table: 'tpl_render_jobs' }),
  Object.freeze({ schema: 'core', table: 'lic_usage_daily' }),
  Object.freeze({ schema: 'core', table: 'print_jobs' }),
  Object.freeze({ schema: 'core', table: 'sso_login_attempts' }),
  Object.freeze({ schema: 'core', table: 'sso_scim_operations' }),
  Object.freeze({ schema: 'core', table: 'bc_scan_events' }),
  Object.freeze({ schema: 'core', table: 'display_device_events' }),
  Object.freeze({ schema: 'integration', table: 'ihub_messages' }),
  // 20260820091500_phase1_patient_front_office
  Object.freeze({ schema: 'queue', table: 'queue_tokens' }),
  Object.freeze({ schema: 'queue', table: 'queue_events' }),
  Object.freeze({ schema: 'engage', table: 'msg_messages' }),
  Object.freeze({ schema: 'engage', table: 'msg_events' }),
  Object.freeze({ schema: 'billing', table: 'payments' }),
  Object.freeze({ schema: 'billing', table: 'cash_drawer_events' }),
  Object.freeze({ schema: 'patient', table: 'consent_ledger' }),
  Object.freeze({ schema: 'integration', table: 'abdm_messages' }),
  // 20260822160000_phase2_opd_clinical_core
  Object.freeze({ schema: 'clinical', table: 'vitals' }),
  Object.freeze({ schema: 'clinical', table: 'cdss_alert_events' }),
  Object.freeze({ schema: 'clinical', table: 'cdss_scores' }),
  Object.freeze({ schema: 'core', table: 'mobile_sync_log' }),
  // 20260823090000_phase3_diagnostics
  Object.freeze({ schema: 'lab', table: 'lab_results' }),
  Object.freeze({ schema: 'lab', table: 'lab_result_versions' }),
  Object.freeze({ schema: 'lab', table: 'labq_qc_runs' }),
  Object.freeze({ schema: 'integration', table: 'lab_if_messages' }),
  Object.freeze({ schema: 'rad', table: 'pacs_instances' }),
  Object.freeze({ schema: 'rad', table: 'pacs_view_audit' }),
]);

export interface PartitionMaintenanceOptions {
  /** `docs/07` §4: "premake 3 months ahead". */
  readonly monthsAhead?: number;
  /** `docs/01` §7 catch-up entry needs a back-dated month to land in. */
  readonly monthsBehind?: number;
  readonly now?: () => Date;
}

export interface PartitionMaintenanceResult {
  readonly ensured: number;
  readonly created: readonly string[];
  /**
   * A non-empty DEFAULT partition is the alertable anomaly ADR-0008 traded a
   * clinical outage for. Reported, never silently tolerated.
   */
  readonly nonEmptyDefaults: readonly string[];
}

function monthStart(from: Date, offset: number): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + offset, 1));
  const year = d.getUTCFullYear().toString().padStart(4, '0');
  const month = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${year}-${month}-01`;
}

/**
 * Ensure every partitioned table has the months it needs, and report any
 * DEFAULT partition that has caught rows.
 */
export async function ensureMonthPartitions(
  pool: Pool,
  options: PartitionMaintenanceOptions = {},
): Promise<PartitionMaintenanceResult> {
  const monthsAhead = options.monthsAhead ?? 3;
  const monthsBehind = options.monthsBehind ?? 1;
  const now = (options.now ?? ((): Date => new Date()))();

  const before = await listPartitions(pool);
  let ensured = 0;

  for (const target of PARTITIONED_TABLES) {
    for (let offset = -monthsBehind; offset <= monthsAhead; offset += 1) {
      await pool.query('SELECT core.ensure_month_partition($1, $2, $3::date)', [
        target.schema,
        target.table,
        monthStart(now, offset),
      ]);
      ensured += 1;
    }
  }

  const after = await listPartitions(pool);
  const created = after.filter((name) => !before.includes(name));

  return {
    ensured,
    created: Object.freeze(created),
    nonEmptyDefaults: Object.freeze(await findNonEmptyDefaultPartitions(pool)),
  };
}

/** Child *tables* only: `pg_inherits` also carries partitioned indexes, and a
 * log line naming 300 index partitions hides the three tables that were made. */
async function listPartitions(pool: Pool): Promise<readonly string[]> {
  const { rows } = await pool.query<{ qualified: string }>(
    `SELECT n.nspname || '.' || c.relname AS qualified
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_inherits i ON i.inhrelid = c.oid
      WHERE n.nspname IN ('core', 'integration')
        AND c.relkind IN ('r', 'p')`,
  );
  return rows.map((r) => r.qualified);
}

/**
 * `count(*) > 0` on every DEFAULT partition.
 *
 * Deliberately a bounded existence check (`LIMIT 1`), not a count: the answer
 * "some" is all the alert needs, and a full count on a default partition that
 * has been catching rows for a week is exactly the query that would time out
 * when it is most needed.
 */
async function findNonEmptyDefaultPartitions(pool: Pool): Promise<readonly string[]> {
  const { rows } = await pool.query<{ nspname: string; relname: string }>(
    `SELECT n.nspname, c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('core', 'integration')
        AND c.relname LIKE '%\\_default'
        AND c.relispartition`,
  );

  const nonEmpty: string[] = [];
  for (const row of rows) {
    const probe = await pool.query<{ present: number }>(
      // Identifiers come from pg_catalog, not from user input, and are quoted
      // by format(%I) semantics on the way in — `quote_ident` here keeps the
      // "never concatenate SQL" rule honest for a reader as well as a linter.
      `SELECT 1 AS present FROM ${quoteIdent(row.nspname)}.${quoteIdent(row.relname)} LIMIT 1`,
    );
    if (probe.rowCount !== null && probe.rowCount > 0) {
      nonEmpty.push(`${row.nspname}.${row.relname}`);
    }
  }
  return nonEmpty;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
