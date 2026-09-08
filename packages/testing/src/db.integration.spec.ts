import { runSeed } from '@vims/db/seed';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from './containers/postgres.js';
import { runSqlIsolationSuite } from './matchers/sql-isolation-suite.js';

/**
 * The database's own guarantees, asserted on every CI run.
 *
 * These checks were previously possible only as a throwaway script, because
 * `@vims/db` cannot depend on `@vims/testing` — `@vims/testing` already depends
 * on `@vims/db`, and the reverse edge would make a Turborepo cycle. The harness
 * is the right side of that edge to own them, so they live here.
 *
 * Two properties are proven, and both are the kind that hold until the day they
 * silently do not:
 *
 * **RLS covers every table.** 172 tables now exist; a new one added without a
 * policy is invisible in review and catastrophic in production. The SQL suite
 * reads `core.v_rls_coverage`, so it fails on a table nobody remembered to
 * protect rather than on a table somebody remembered to test.
 *
 * **Seeds are idempotent.** A seed that re-writes rows on a second run cannot be
 * used to repair a half-provisioned tenant, which is exactly when it is needed.
 * Asserting "zero rows written" is weaker than it sounds on its own — an
 * `ON CONFLICT DO UPDATE` that rewrites identical values also reports zero
 * changes to a careless check — so the content is compared as well, table by
 * table, with a digest.
 */

let pg: TestPostgres;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 300_000);

afterAll(async () => {
  await pg?.stop();
});

/** A content digest per table, so "unchanged" means the bytes, not just the count. */
async function tableDigests(): Promise<ReadonlyMap<string, string>> {
  const pool = pg.pool('migrator');
  const { rows: tables } = await pool.query<{ schemaname: string; tablename: string }>(
    // The schema list is **derived, not written down**.
    //
    // It was written down twice and wrong twice. It first read
    // ('core','mdm','integration'), which made the whole of Phase 1 invisible —
    // a seed rewriting 220 000 patient rows on every run would have passed. It
    // was widened, the comment recording that fix stayed, and then Phase 4
    // added `inventory`, `pharmacy` and `finance` — 112 tables — and the list
    // was not widened again. The same bug, twice, in the same six lines.
    //
    // `core.v_rls_coverage` already enumerates every tenant-scoped table and is
    // extended by each phase's migration as a matter of course, because RLS is
    // not optional. Deriving from it means a phase cannot add a schema this
    // check ignores without also shipping tables that have no RLS, which a test
    // twenty lines above already fails on.
    `SELECT DISTINCT c.schema_name AS schemaname, t.tablename
       FROM core.v_rls_coverage c
       JOIN pg_tables t
         ON t.schemaname = c.schema_name
        -- Leaf partitions are covered through their parent.
        AND t.tablename NOT LIKE '%\\_2%'
      ORDER BY 1, 2`,
  );

  // Derivation that silently finds nothing would make every assertion below
  // vacuous — the failure mode this whole change exists to remove.
  if (tables.length < 150) {
    throw new Error(
      `tableDigests() discovered only ${String(tables.length)} tables from core.v_rls_coverage. ` +
        `The schema is far larger than that, so the derivation is broken and the idempotency ` +
        `proof would pass without checking anything.`,
    );
  }

  const digests = new Map<string, string>();
  for (const { schemaname, tablename } of tables) {
    const { rows } = await pool.query<{ digest: string | null }>(
      `SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS digest
         FROM "${schemaname}"."${tablename}" t`,
    );
    digests.set(`${schemaname}.${tablename}`, rows[0]?.digest ?? 'empty');
  }
  return digests;
}

describe('row-level security covers the whole schema', () => {
  it('has no table without RLS and no tenant-scoped table without WITH CHECK', async () => {
    // The four exempt tables are published law — opioid conversion factors,
    // Beers criteria, anticholinergic scores, telemedicine drug lists —
    // identical in every tenant, and a hospital that could not read them could
    // not refuse an unsafe prescription. The exemption is not taken on trust:
    // each must also have no `hospital_id` column, which is what makes "nothing
    // to leak" structural. `mdm.immunisation_schedules` was on this list until
    // it was noticed that it *does* carry one, so a hospital's local variation
    // on the national schedule was readable by every other tenant; it has the
    // nullable-hospital policy now.
    const coverage = await pg.pool('migrator').query<{ total: string; no_rls: string; no_check: string }>(
      `SELECT count(*) AS total,
              count(*) FILTER (
                WHERE NOT cov.rls_enabled
                  AND NOT (
                    cov.schema_name = 'mdm'
                    AND cov.table_name IN ('opioid_conversion_factors', 'beers_criteria',
                                           'anticholinergic_scores', 'telemedicine_drug_rules')
                    AND NOT EXISTS (
                      SELECT 1 FROM information_schema.columns col
                       WHERE col.table_schema = cov.schema_name
                         AND col.table_name = cov.table_name
                         AND col.column_name = 'hospital_id'
                    )
                  )
              ) AS no_rls,
              count(*) FILTER (
                WHERE cov.is_tenant_scoped AND NOT cov.has_write_check AND cov.rls_enabled
              ) AS no_check
         FROM core.v_rls_coverage cov`,
    );
    const row = coverage.rows[0];
    expect(Number(row?.no_rls)).toBe(0);
    expect(Number(row?.no_check)).toBe(0);
    expect(Number(row?.total)).toBeGreaterThan(150);
  });

  it('keeps the unrestricted-policy allow-list to exactly the three global catalogues', async () => {
    const { rows } = await pg.pool('migrator').query<{ table_name: string }>(
      // One row per policy, and each catalogue carries both an hms_app and an
      // hms_readonly policy — the question here is which TABLES are open, not
      // how many policies each has.
      `SELECT DISTINCT table_name FROM core.v_rls_open_policies ORDER BY table_name`,
    );
    // `console_components` joined the two several phases ago and this list was
    // never updated, so the assertion had been failing against a schema that is
    // correct. It is the registry of console building blocks: the same six rows
    // in every tenant, with RLS left enabled and the policy deliberately open
    // rather than RLS switched off (D-17).
    expect(rows.map((r) => r.table_name)).toEqual([
      'console_components',
      'permissions',
      'setting_definitions',
    ]);
  });

  it('passes every case in verify-isolation.sql on the migrated schema', async () => {
    const result = await runSqlIsolationSuite(pg);
    expect(result.failed).toBe(0);
    expect(result.ok).toBe(true);
  }, 120_000);
});

describe('seeds are idempotent', () => {
  it('writes nothing on a second run and leaves every table byte-identical', async () => {
    const pool = pg.pool('migrator');

    // 'demo' is the smallest tier that populates the Phase 1 schemas. Running
    // 'minimal' here checked idempotency only for tables the tier never writes,
    // which is a test that cannot fail for the code it is meant to guard.
    const first = await runSeed(pool, 'demo');
    expect(first).toBeDefined();

    const before = await tableDigests();
    const second = await runSeed(pool, 'demo');
    const after = await tableDigests();

    const changed: string[] = [];
    for (const [table, digest] of before) {
      if (after.get(table) !== digest) changed.push(table);
    }

    expect(changed, 'tables whose contents changed on a re-run').toEqual([]);
    expect(second).toBeDefined();

    // Guard the guard. This test's value is entirely in what `tableDigests()`
    // covers, and that coverage is a schema list somebody can shorten without
    // any test going red. Naming tables the seed actually writes means a future
    // narrowing fails here instead of quietly exempting a phase.
    for (const table of [
      'patient.patients',
      'clinical.appointments',
      'queue.queue_tokens',
      'lab.lab_reference_ranges',
      'rad.rad_modality_rooms',
    ]) {
      expect(before.has(table), `${table} must be covered by the idempotency check`).toBe(true);
    }
  }, 300_000);

  it('still passes the isolation suite after seeding', async () => {
    const result = await runSqlIsolationSuite(pg);
    expect(result.failed).toBe(0);
  }, 120_000);
});
