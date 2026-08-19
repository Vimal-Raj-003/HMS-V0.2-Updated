import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '@vims/db/tenancy';
import { startTestPostgres, type TestPostgres } from './containers/postgres.js';
import { asMigrator, asTenant, asUnscoped, withRollback } from './fixtures/database.js';
import { createTenantFixture, type TenantFixture } from './factories/tenancy.js';
import { assertTenantIsolation, checkTenantIsolation } from './matchers/tenant-isolation.js';
import { runSqlIsolationSuite } from './matchers/sql-isolation-suite.js';
import { generatePatient } from './generators/indian-patient.js';

/**
 * Proves the harness itself.
 *
 * A test harness that is merely *believed* to isolate is worse than none: every
 * suite built on it inherits the belief. So this file asserts the three
 * properties everything else will assume — the container is the real image, a
 * test cannot leak into the next one, and RLS is actually in force for the role
 * the application uses.
 */

let pg: TestPostgres;
let tenants: TenantFixture;
let userId: string;

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg);
  userId = generatePatient(1).seed.toString().padStart(8, '0');
  // A UUID-shaped acting user; no user row is needed for RLS on these tables.
  userId = `00000000-0000-7000-8000-${userId.slice(0, 12).padStart(12, '0')}`;
}, 300_000);

afterAll(async () => {
  await pg?.stop();
});

const ctx = (hospitalId: string): TenantContext => ({ hospitalId, userId, scope: 'branch' });

describe('container is the image we actually ship', () => {
  it('runs PostgreSQL 17', async () => {
    const version = await withRollback(pg.pool('migrator'), (c) => c.scalar<string>('SHOW server_version'));
    expect(version).toMatch(/^17\./);
  });

  // Read as `hms_app`, not as the owner. `infra/docker/postgres/init/01-extensions.sql`
  // grants SELECT on this table to the application and analytics roles only,
  // because the application is what reads it at boot to decide whether the
  // worker must own partition maintenance (ADR-0008). Asserting through the
  // app role therefore proves the grant that production actually depends on.
  it('has every required extension from docs/03 installed', async () => {
    const rows = await withRollback(pg.pool('app'), (c) =>
      c.rows<{ extension: string; installed: boolean }>(
        'SELECT extension, installed FROM ext.db_capabilities WHERE required ORDER BY extension',
      ),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => !r.installed)).toEqual([]);
  });

  it('has the optional extensions the on-prem image promises', async () => {
    const installed = await withRollback(pg.pool('app'), (c) =>
      c.rows<{ extension: string }>(
        'SELECT extension FROM ext.db_capabilities WHERE installed ORDER BY extension',
      ),
    );
    const names = installed.map((r) => r.extension);
    for (const expected of ['pgcrypto', 'citext', 'pg_trgm', 'btree_gist', 'ltree', 'vector', 'pg_partman']) {
      expect(names).toContain(expected);
    }
  });

  it('created the four least-privilege roles', async () => {
    const roles = await withRollback(pg.pool('migrator'), (c) =>
      c.rows<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
        `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles
          WHERE rolname LIKE 'hms\\_%' ORDER BY rolname`,
      ),
    );
    expect(roles.map((r) => r.rolname)).toEqual(['hms_app', 'hms_migrator', 'hms_readonly', 'hms_retention']);
  });

  /**
   * The single most consequential assertion in the repository. If `hms_app`ever
   * gains BYPASSRLS, every isolation guarantee in the product evaporates while
   * every other test still passes.
   */
  it('leaves the application role subject to RLS', async () => {
    const app = await withRollback(pg.pool('migrator'), (c) =>
      c.rows<{ rolbypassrls: boolean; rolsuper: boolean; rolcreatedb: boolean }>(
        `SELECT rolbypassrls, rolsuper, rolcreatedb FROM pg_roles WHERE rolname = 'hms_app'`,
      ),
    );
    expect(app[0]).toMatchObject({ rolbypassrls: false, rolsuper: false, rolcreatedb: false });
  });

  it('applied every migration', async () => {
    const tables = await withRollback(pg.pool('migrator'), (c) =>
      c.scalar<string>(`SELECT count(*) FROM pg_tables WHERE schemaname = 'core'`),
    );
    expect(Number(tables)).toBeGreaterThan(40);
  });
});

describe('withRollback isolates one test from the next', () => {
  it('discards writes made inside it', async () => {
    const probeId = '5a5a5a5a-5a5a-7a5a-8a5a-5a5a5a5a5a5a';

    await asMigrator(pg, async (c) => {
      await c.query(
        `INSERT INTO core.org_groups (id, name, legal_name, updated_at)
         VALUES ($1, 'Rollback Probe', 'Rollback Probe Pvt Ltd', now())`,
        [probeId],
      );
      const seen = await c.scalar<string>('SELECT count(*) FROM core.org_groups WHERE id = $1', [probeId]);
      expect(Number(seen)).toBe(1);
    });

    const survived = await asMigrator(pg, (c) =>
      c.scalar<string>('SELECT count(*) FROM core.org_groups WHERE id = $1', [probeId]),
    );
    expect(Number(survived)).toBe(0);
  });

  it('rolls back even when the body throws', async () => {
    const probeId = '6b6b6b6b-6b6b-7b6b-8b6b-6b6b6b6b6b6b';
    await expect(
      asMigrator(pg, async (c) => {
        await c.query(
          `INSERT INTO core.org_groups (id, name, legal_name, updated_at)
           VALUES ($1, 'Throwing Probe', 'Throwing Probe Pvt Ltd', now())`,
          [probeId],
        );
        throw new Error('deliberate');
      }),
    ).rejects.toThrow('deliberate');

    const survived = await asMigrator(pg, (c) =>
      c.scalar<string>('SELECT count(*) FROM core.org_groups WHERE id = $1', [probeId]),
    );
    expect(Number(survived)).toBe(0);
  });
});

describe('row-level security is in force for the application role', () => {
  it('shows a tenant its own branch', async () => {
    const count = await asTenant(pg, ctx(tenants.hospitalA), (c) =>
      c.scalar<string>('SELECT count(*) FROM core.branches WHERE id = $1', [tenants.branchA]),
    );
    expect(Number(count)).toBe(1);
  });

  it('hides another tenant’s branch, even by direct id', async () => {
    const count = await asTenant(pg, ctx(tenants.hospitalA), (c) =>
      c.scalar<string>('SELECT count(*) FROM core.branches WHERE id = $1', [tenants.branchB]),
    );
    expect(Number(count)).toBe(0);
  });

  it('shows nothing at all to a session with no tenancy context', async () => {
    const count = await asUnscoped(pg, (c) => c.scalar<string>('SELECT count(*) FROM core.branches'));
    expect(Number(count)).toBe(0);
  });

  it('passes the full isolation probe on core.branches', async () => {
    const report = await assertTenantIsolation(pg, {
      table: 'core.branches',
      victimRowId: tenants.branchB,
      attacker: ctx(tenants.hospitalA),
      victim: ctx(tenants.hospitalB),
    });
    expect(report).toMatchObject({
      ok: true,
      controlVisible: true,
      readBlocked: true,
      crossTenantInsertBlocked: true,
      crossTenantUpdateBlocked: true,
      unscopedSeesNothing: true,
    });
  });

  /**
   * The matcher must fail loudly when the fixture is wrong, rather than
   * reporting a green isolation result for an empty table.
   */
  it('reports a control failure when the victim row does not exist', async () => {
    const report = await checkTenantIsolation(pg, {
      table: 'core.branches',
      victimRowId: '00000000-0000-7000-8000-000000000000',
      attacker: ctx(tenants.hospitalA),
      victim: ctx(tenants.hospitalB),
    });
    expect(report.ok).toBe(false);
    expect(report.controlVisible).toBe(false);
    expect(report.failures.join(' ')).toContain('CONTROL FAILED');
  });
});

/**
 * The mutation test — the one that decides whether any of the above means
 * anything.
 *
 * `docs/prompts/phase-00-foundation.md` exit gate 4 does not ask for passing
 * isolation tests; it asks that "deliberately breaking a policy makes them
 * fail". A green suite is consistent with three worlds: the policy works, the
 * policy is absent and the tables are empty, or the assertion is malformed.
 * Only weakening the policy on purpose and watching the suite go red
 * distinguishes the first from the other two.
 *
 * The policy is restored in a `finally`, and the container is discarded after
 * the file regardless, so a crash mid-test cannot leave a weakened policy
 * behind.
 */
describe('the isolation proof has teeth', () => {
  it('goes red when the tenant policy on core.branches is weakened to USING (true)', async () => {
    const pool = pg.pool('migrator');
    const original = await pool.query<{ qual: string; with_check: string | null }>(
      `SELECT qual, with_check FROM pg_policies
        WHERE schemaname = 'core' AND tablename = 'branches' AND policyname = 'tenant_isolation'`,
    );
    const policy = original.rows[0];
    expect(policy, 'core.branches must have a tenant_isolation policy to weaken').toBeDefined();
    if (!policy) return;

    try {
      await pool.query('ALTER POLICY tenant_isolation ON core.branches USING (true) WITH CHECK (true)');

      const report = await checkTenantIsolation(pg, {
        table: 'core.branches',
        victimRowId: tenants.branchB,
        attacker: ctx(tenants.hospitalA),
        victim: ctx(tenants.hospitalB),
      });

      expect(report.ok).toBe(false);
      expect(report.readBlocked).toBe(false);
      expect(report.unscopedSeesNothing).toBe(false);
      expect(report.failures.join(' ')).toContain('READ LEAK');
    } finally {
      await pool.query(
        `ALTER POLICY tenant_isolation ON core.branches USING (${policy.qual}) WITH CHECK (${
          policy.with_check ?? policy.qual
        })`,
      );
    }
  });

  it('is green again once the policy is restored', async () => {
    const report = await checkTenantIsolation(pg, {
      table: 'core.branches',
      victimRowId: tenants.branchB,
      attacker: ctx(tenants.hospitalA),
      victim: ctx(tenants.hospitalB),
    });
    expect(report.ok).toBe(true);
  });
});

describe('the SQL-level isolation suite runs in CI, not only by hand', () => {
  it('passes every case in packages/db/src/rls/verify-isolation.sql', async () => {
    const result = await runSqlIsolationSuite(pg);
    expect(result.cases.length).toBeGreaterThanOrEqual(10);
    expect(result.failed).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
  }, 120_000);
});
