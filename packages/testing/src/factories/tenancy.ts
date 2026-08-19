import { newId } from '@vims/contracts/primitives';
import type { TestPostgres } from '../containers/postgres.js';

/**
 * Tenancy fixtures — two hospitals that look alike in every respect except
 * which tenant they belong to.
 *
 * `docs/09-quality-gates-and-testing.md` §3.1 step 1 asks for exactly this
 * shape, and the reason is worth stating: an isolation test between a hospital
 * with data and a hospital without it can pass because the second is empty. Two
 * populated, structurally identical tenants are the only arrangement where
 * "hospital A cannot see hospital B" means what it says.
 *
 * These are **committed**, not rolled back — per-test transactions
 * (`withRollback`) need them to already exist. Create them once in `beforeAll`.
 */

export interface TenantFixture {
  readonly groupId: string;
  readonly hospitalA: string;
  readonly hospitalB: string;
  readonly branchA: string;
  readonly branchB: string;
}

export interface CreateTenantFixtureOptions {
  /** Prefix for the generated hospital/branch codes, so parallel suites cannot collide. */
  readonly codePrefix?: string;
}

/**
 * Creates one group containing two hospitals, each with one live branch.
 *
 * Runs as `hms_migrator`: the schema owner is not subject to RLS, which is what
 * allows a single statement to create rows in two different tenants. No
 * application code may ever do this — which is precisely why the fixture, not
 * the application, owns it.
 */
export async function createTenantFixture(
  pg: TestPostgres,
  options: CreateTenantFixtureOptions = {},
): Promise<TenantFixture> {
  const prefix = options.codePrefix ?? `T${Date.now().toString(36).slice(-5).toUpperCase()}`;
  const fixture: TenantFixture = {
    groupId: newId(),
    hospitalA: newId(),
    hospitalB: newId(),
    branchA: newId(),
    branchB: newId(),
  };

  const pool = pg.pool('migrator');

  await pool.query(
    `INSERT INTO core.org_groups (id, name, legal_name, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (id) DO NOTHING`,
    [fixture.groupId, `${prefix} Group`, `${prefix} Group Pvt Ltd`],
  );

  await pool.query(
    `INSERT INTO core.hospitals
       (id, group_id, code, legal_name, display_name, address, contacts, dpo, grievance_officer, updated_at)
     VALUES
       ($1, $3, $4, $5, $6, '{}', '{}', '{}', '{}', now()),
       ($2, $3, $7, $8, $9, '{}', '{}', '{}', '{}', now())
     ON CONFLICT (id) DO NOTHING`,
    [
      fixture.hospitalA,
      fixture.hospitalB,
      fixture.groupId,
      `${prefix}-A`,
      `${prefix} Hospital A Pvt Ltd`,
      `${prefix} Hospital A`,
      `${prefix}-B`,
      `${prefix} Hospital B Pvt Ltd`,
      `${prefix} Hospital B`,
    ],
  );

  await pool.query(
    `INSERT INTO core.branches
       (id, hospital_id, group_id, code, name, short_name, colour_token, status, updated_at)
     VALUES
       ($1, $3, $5, $6, $7, $8, 'branch-1', 'live', now()),
       ($2, $4, $5, $9, $10, $11, 'branch-2', 'live', now())
     ON CONFLICT (id) DO NOTHING`,
    [
      fixture.branchA,
      fixture.branchB,
      fixture.hospitalA,
      fixture.hospitalB,
      fixture.groupId,
      `${prefix}A-MAIN`,
      `${prefix} A Main Campus`,
      `${prefix}A-Main`,
      `${prefix}B-MAIN`,
      `${prefix} B Main Campus`,
      `${prefix}B-Main`,
    ],
  );

  return fixture;
}

/** Removes a fixture. Only useful for suites that create many; `stop()` discards the container anyway. */
export async function dropTenantFixture(pg: TestPostgres, fixture: TenantFixture): Promise<void> {
  const pool = pg.pool('migrator');
  await pool.query('DELETE FROM core.branches WHERE id = ANY($1::uuid[])', [
    [fixture.branchA, fixture.branchB],
  ]);
  await pool.query('DELETE FROM core.hospitals WHERE id = ANY($1::uuid[])', [
    [fixture.hospitalA, fixture.hospitalB],
  ]);
  await pool.query('DELETE FROM core.org_groups WHERE id = $1', [fixture.groupId]);
}
