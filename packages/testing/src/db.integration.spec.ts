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
    `SELECT schemaname, tablename
       FROM pg_tables
      WHERE schemaname IN ('core', 'mdm', 'integration')
        -- Leaf partitions are covered through their parent.
        AND tablename NOT LIKE '%\\_2%'
      ORDER BY schemaname, tablename`,
  );

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
    const coverage = await pg.pool('migrator').query<{ total: string; no_rls: string; no_check: string }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE NOT rls_enabled) AS no_rls,
              count(*) FILTER (WHERE is_tenant_scoped AND NOT has_write_check) AS no_check
         FROM core.v_rls_coverage`,
    );
    const row = coverage.rows[0];
    expect(Number(row?.no_rls)).toBe(0);
    expect(Number(row?.no_check)).toBe(0);
    expect(Number(row?.total)).toBeGreaterThan(150);
  });

  it('keeps the unrestricted-policy allow-list to exactly the two global catalogues', async () => {
    const { rows } = await pg.pool('migrator').query<{ table_name: string }>(
      // One row per policy, and each catalogue carries both an hms_app and an
      // hms_readonly policy — the question here is which TABLES are open, not
      // how many policies each has.
      `SELECT DISTINCT table_name FROM core.v_rls_open_policies ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(['permissions', 'setting_definitions']);
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

    const first = await runSeed(pool, 'minimal');
    expect(first).toBeDefined();

    const before = await tableDigests();
    const second = await runSeed(pool, 'minimal');
    const after = await tableDigests();

    const changed: string[] = [];
    for (const [table, digest] of before) {
      if (after.get(table) !== digest) changed.push(table);
    }

    expect(changed, 'tables whose contents changed on a re-run').toEqual([]);
    expect(second).toBeDefined();
  }, 300_000);

  it('still passes the isolation suite after seeding', async () => {
    const result = await runSqlIsolationSuite(pg);
    expect(result.failed).toBe(0);
  }, 120_000);
});
