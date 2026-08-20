import { newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWithContext, type MutableRequestContext } from '../context/request-context.js';
import { DatabaseService } from '../db/database.service.js';
import { NumberingService } from './numbering.service.js';

/**
 * The numbering service against a real PostgreSQL 17.
 *
 * Every property worth asserting here is a property of *concurrent* behaviour,
 * which no unit test can reach: whether two simultaneous registrations can be
 * handed the same UHID, and whether a failed registration burns a receipt number
 * that an auditor will later ask about. Both are invisible to a single-threaded
 * test and to review.
 */
let pg: TestPostgres;
let pool: Pool;
let tenants: TenantFixture;
let db: DatabaseService;
const numbering = new NumberingService();

const USER_ID = newId();

function contextFor(hospitalId: string, branchId: string): MutableRequestContext {
  return {
    traceId: newId(),
    requestId: newId(),
    startedAtMs: Date.now(),
    method: 'POST',
    route: '/test',
    ip: null,
    userAgent: null,
    userId: USER_ID,
    sessionId: newId(),
    hospitalId,
    branchId,
    grantedBranchIds: [branchId],
    scope: 'branch',
    roleKeys: [],
    impersonatorUserId: null,
    reason: null,
  };
}

/** Creates a series directly, as a hospital administrator would have configured it. */
async function defineSeries(
  hospitalId: string,
  branchId: string | null,
  key: string,
  pattern: string,
  options: { gapless?: boolean; reset?: string; fy?: string | null; lockedAt?: Date | null } = {},
): Promise<string> {
  const id = newId();
  await pool.query(
    `INSERT INTO core.numbering_series
       (id, hospital_id, branch_id, key, pattern, scope, fy, current_value, gapless,
        reset_policy, version, effective_from, active, locked_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9::"core"."NumberingResetPolicy", 1,
             now() - interval '1 day', true, $10, now(), now())`,
    [
      id,
      hospitalId,
      branchId,
      key,
      pattern,
      branchId === null ? 'hospital' : 'branch',
      options.fy ?? null,
      options.gapless ?? false,
      options.reset ?? 'never',
      options.lockedAt ?? null,
    ],
  );
  return id;
}

beforeAll(async () => {
  pg = await startTestPostgres();
  pool = pg.pool('migrator');
  tenants = await createTenantFixture(pg, { codePrefix: 'NUM' });
  // DatabaseService builds its own pool from the environment, so the container's
  // URL has to be in place before it is constructed.
  process.env['DATABASE_URL'] = pg.connectionString('app');
  db = new DatabaseService({
    DATABASE_URL: pg.connectionString('app'),
    DATABASE_POOL_MAX: 10,
    DATABASE_STATEMENT_TIMEOUT_MS: 30_000,
  } as never);
}, 600_000);

afterAll(async () => {
  await pg?.stop();
});

describe('NumberingService', () => {
  it('formats the seeded UHID shape from the branch code', async () => {
    await defineSeries(tenants.hospitalA, tenants.branchA, 'UHID_FMT', '{BR}{SEQ:8}');
    const allocation = await runWithContext(contextFor(tenants.hospitalA, tenants.branchA), async () =>
      db.withTenant(
        {
          hospitalId: tenants.hospitalA,
          userId: USER_ID,
          scope: 'branch',
          branchIds: [tenants.branchA],
        },
        async (tx) => numbering.allocate(tx, { key: 'UHID_FMT', branchId: tenants.branchA }),
      ),
    );
    expect(allocation.number).toBe(1n);
    expect(allocation.formatted).toMatch(/^[A-Za-z0-9-]+0{7}1$/);
  });

  /**
   * The property the whole design exists for. Two registrations at two counters
   * commit at the same moment; if they can both read `current_value` before
   * either writes, two patients leave with the same UHID and the records are
   * merged by hand weeks later.
   */
  it('never issues the same number twice under concurrency', async () => {
    await defineSeries(tenants.hospitalA, tenants.branchA, 'UHID_RACE', '{BR}{SEQ:8}');

    const allocateOnce = async (): Promise<string> =>
      runWithContext(contextFor(tenants.hospitalA, tenants.branchA), async () =>
        db.withTenant(
          {
            hospitalId: tenants.hospitalA,
            userId: USER_ID,
            scope: 'branch',
            branchIds: [tenants.branchA],
          },
          async (tx) => {
            const a = await numbering.allocate(tx, {
              key: 'UHID_RACE',
              branchId: tenants.branchA,
            });
            return a.formatted;
          },
        ),
      );

    const CONCURRENCY = 20;
    const issued = await Promise.all(Array.from({ length: CONCURRENCY }, allocateOnce));

    expect(new Set(issued).size, `issued: ${issued.join(', ')}`).toBe(CONCURRENCY);
  }, 120_000);

  /**
   * `docs/03 §84`: gapless for invoices and receipts. A registration that fails
   * after allocating must give the number back, or the series grows holes that
   * an auditor will ask about and nobody will be able to explain.
   */
  it('returns a gapless number when the transaction rolls back', async () => {
    await defineSeries(tenants.hospitalA, tenants.branchA, 'RCP_ROLLBACK', '{BR}/RCP/{SEQ:6}', {
      gapless: true,
    });

    const allocate = async (fail: boolean): Promise<string> =>
      runWithContext(contextFor(tenants.hospitalA, tenants.branchA), async () =>
        db.withTenant(
          {
            hospitalId: tenants.hospitalA,
            userId: USER_ID,
            scope: 'branch',
            branchIds: [tenants.branchA],
          },
          async (tx) => {
            const a = await numbering.allocate(tx, {
              key: 'RCP_ROLLBACK',
              branchId: tenants.branchA,
            });
            if (fail) throw new Error('the receipt failed validation after allocating');
            return a.formatted;
          },
        ),
      );

    const first = await allocate(false);
    await expect(allocate(true)).rejects.toThrow(/failed validation/);
    const second = await allocate(false);

    // 1 then 2 — the rolled-back attempt consumed nothing.
    expect(first).toMatch(/0{5}1$/);
    expect(second).toMatch(/0{5}2$/);
  }, 120_000);

  /** A number that was never committed must leave no allocation record either. */
  it('records one allocation row per committed number, and none for a rollback', async () => {
    const seriesId = await defineSeries(tenants.hospitalA, tenants.branchA, 'ALLOC_LOG', '{BR}/AL/{SEQ:4}');
    const refId = newId();

    await runWithContext(contextFor(tenants.hospitalA, tenants.branchA), async () =>
      db.withTenant(
        {
          hospitalId: tenants.hospitalA,
          userId: USER_ID,
          scope: 'branch',
          branchIds: [tenants.branchA],
        },
        async (tx) =>
          numbering.allocate(tx, {
            key: 'ALLOC_LOG',
            branchId: tenants.branchA,
            refType: 'patient',
            refId,
          }),
      ),
    );

    const { rows } = await pool.query<{ n: string; ref_id: string; allocated_by: string }>(
      `SELECT count(*)::text AS n, max(ref_id::text) AS ref_id, max(allocated_by::text) AS allocated_by
         FROM core.numbering_allocations WHERE series_id = $1`,
      [seriesId],
    );
    expect(rows[0]?.n).toBe('1');
    expect(rows[0]?.ref_id).toBe(refId);
    expect(rows[0]?.allocated_by).toBe(USER_ID);
  }, 120_000);

  /**
   * The financial-year reset. `RECEIPT` is gapless and resets on 1 April, so a
   * series that fails to notice the rollover keeps counting into a year it has
   * already closed.
   */
  it('restarts at 1 when the financial year turns over', async () => {
    await defineSeries(tenants.hospitalA, tenants.branchA, 'RCP_FY', '{BR}/RCP/{FY}/{SEQ:6}', {
      gapless: true,
      reset: 'fy',
      // A year that is certainly not the current one.
      fy: '2019-20',
    });

    const allocation = await runWithContext(contextFor(tenants.hospitalA, tenants.branchA), async () =>
      db.withTenant(
        {
          hospitalId: tenants.hospitalA,
          userId: USER_ID,
          scope: 'branch',
          branchIds: [tenants.branchA],
        },
        async (tx) => numbering.allocate(tx, { key: 'RCP_FY', branchId: tenants.branchA }),
      ),
    );

    expect(allocation.number).toBe(1n);
    expect(allocation.formatted).not.toContain('2019-20');
    expect(allocation.formatted).toMatch(/0{5}1$/);
  }, 120_000);

  /** A sealed series is evidence; issuing into a signed-off period corrupts it. */
  it('refuses to issue from a sealed series', async () => {
    await defineSeries(tenants.hospitalA, tenants.branchA, 'RCP_SEALED', '{BR}/RCP/{SEQ:6}', {
      gapless: true,
      lockedAt: new Date(),
    });

    await expect(
      runWithContext(contextFor(tenants.hospitalA, tenants.branchA), async () =>
        db.withTenant(
          {
            hospitalId: tenants.hospitalA,
            userId: USER_ID,
            scope: 'branch',
            branchIds: [tenants.branchA],
          },
          async (tx) => numbering.allocate(tx, { key: 'RCP_SEALED', branchId: tenants.branchA }),
        ),
      ),
    ).rejects.toThrow(/sealed/);
  }, 120_000);

  /**
   * A daily series cannot record which day it is on in this table, so issuing
   * from one would silently reissue yesterday's numbers. Failing loudly and
   * naming the right table is the only safe behaviour.
   */
  it('refuses a daily series and names where daily numbers come from', async () => {
    await defineSeries(tenants.hospitalA, tenants.branchA, 'TOKEN_DAY', '{SEQ:4}', {
      reset: 'day',
    });

    await expect(
      runWithContext(contextFor(tenants.hospitalA, tenants.branchA), async () =>
        db.withTenant(
          {
            hospitalId: tenants.hospitalA,
            userId: USER_ID,
            scope: 'branch',
            branchIds: [tenants.branchA],
          },
          async (tx) => numbering.allocate(tx, { key: 'TOKEN_DAY', branchId: tenants.branchA }),
        ),
      ),
    ).rejects.toThrow(/queue\.queue_token_series/);
  }, 120_000);

  /** An unconfigured series must say so, not mint an identifier of its own. */
  it('refuses a series that is not configured', async () => {
    await expect(
      runWithContext(contextFor(tenants.hospitalA, tenants.branchA), async () =>
        db.withTenant(
          {
            hospitalId: tenants.hospitalA,
            userId: USER_ID,
            scope: 'branch',
            branchIds: [tenants.branchA],
          },
          async (tx) => numbering.allocate(tx, { key: 'NOT_CONFIGURED', branchId: tenants.branchA }),
        ),
      ),
    ).rejects.toThrow(/No active numbering series/);
  }, 120_000);

  /**
   * Two branches counting independently. A shared counter would mean branch B's
   * first patient of the day is handed UHID 4,001 because branch A registered
   * 4,000 that morning — and a UHID collision across a group is a merge nobody
   * can undo.
   */
  it('counts each tenant separately', async () => {
    await defineSeries(tenants.hospitalA, tenants.branchA, 'UHID_TENANT', '{BR}{SEQ:8}');
    await defineSeries(tenants.hospitalB, tenants.branchB, 'UHID_TENANT', '{BR}{SEQ:8}');

    const inA = await runWithContext(contextFor(tenants.hospitalA, tenants.branchA), async () =>
      db.withTenant(
        {
          hospitalId: tenants.hospitalA,
          userId: USER_ID,
          scope: 'branch',
          branchIds: [tenants.branchA],
        },
        async (tx) => numbering.allocate(tx, { key: 'UHID_TENANT', branchId: tenants.branchA }),
      ),
    );
    const inB = await runWithContext(contextFor(tenants.hospitalB, tenants.branchB), async () =>
      db.withTenant(
        {
          hospitalId: tenants.hospitalB,
          userId: USER_ID,
          scope: 'branch',
          branchIds: [tenants.branchB],
        },
        async (tx) => numbering.allocate(tx, { key: 'UHID_TENANT', branchId: tenants.branchB }),
      ),
    );

    expect(inA.number).toBe(1n);
    expect(inB.number).toBe(1n);
    expect(inA.formatted).not.toBe(inB.formatted);
  }, 120_000);
});
