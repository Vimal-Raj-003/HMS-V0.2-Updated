import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { runSeed } from '@vims/db/seed';
import { startTestPostgres, type TestPostgres } from '@vims/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';

/**
 * NC-022 through the API.
 *
 * The assertions are the ones that decide whether a hospital finds out in
 * August or in March: that a commitment cannot exceed its line, that actuals
 * count towards the limit and not just commitments, that a virement has to
 * balance, that operating money cannot become capital money, and that the
 * history cannot be rewritten afterwards.
 */

let pg: TestPostgres;
let app: NestFastifyApplication;

const PASSWORD = 'VimsDev#2026';
let hospitalId = '';
let branchId = '';
let token = '';
let secondUserId = '';

const state = {
  userId: '',
  bookId: '',
  cycleId: '',
  consumablesLineId: '',
  maintenanceLineId: '',
  capexLineId: '',
};

@Module({ imports: [AppModule] })
class BudgetTestModule {}

function call(options: {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly url: string;
  readonly payload?: Record<string, unknown>;
  readonly reason?: string;
}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.reason !== undefined) headers['x-reason'] = options.reason;
  if (options.method !== 'GET') headers['idempotency-key'] = newId();
  return app.inject({
    method: options.method,
    url: options.url,
    headers,
    ...(options.method === 'GET' ? {} : { payload: options.payload ?? {} }),
  });
}

beforeAll(async () => {
  pg = await startTestPostgres();
  process.env['DATABASE_MIGRATE_URL'] = pg.connectionString('migrator');
  await runSeed(pg.pool('migrator'), 'demo');

  const pool = pg.pool('migrator');
  hospitalId = (await pool.query<{ id: string }>(`SELECT id FROM core.hospitals WHERE code = 'VIMS-BLR'`))
    .rows[0]!.id;
  branchId = (
    await pool.query<{ id: string }>(`SELECT id FROM core.branches WHERE hospital_id = $1 LIMIT 1`, [
      hospitalId,
    ])
  ).rows[0]!.id;

  const roleId = newId();
  await pool.query(
    `INSERT INTO core.roles (id, hospital_id, key, name, description, home_workspace, category, updated_at)
     VALUES ($1,$2,'nc022_e2e','NC-022 e2e','end to end','dashboard','governance', now())`,
    [roleId, hospitalId],
  );
  for (const perm of PERMISSION_CATALOGUE) {
    await pool.query(
      `INSERT INTO core.role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [roleId, perm.key],
    );
  }
  const donor = await pool.query<{ password_hash: string }>(
    `SELECT password_hash FROM core.users WHERE hospital_id = $1 AND password_hash IS NOT NULL LIMIT 1`,
    [hospitalId],
  );
  const userId = newId();
  state.userId = userId;
  await pool.query(
    `INSERT INTO core.users (id, hospital_id, group_id, username, email, name, display_name,
                             password_hash, status, type, updated_at)
     VALUES ($1,$2,(SELECT group_id FROM core.hospitals WHERE id=$2),'nc022@vims-blr',
             'nc022@example.invalid','{"given":"NC","family":"TwentyTwo"}'::jsonb,'NC TwentyTwo',$3,'active','staff', now())`,
    [userId, hospitalId, donor.rows[0]!.password_hash],
  );
  await pool.query(
    `INSERT INTO core.user_roles (id, hospital_id, user_id, role_id, branch_id, updated_at)
     VALUES ($1,$2,$3,$4,$5, now())`,
    [newId(), hospitalId, userId, roleId, branchId],
  );
  secondUserId = (
    await pool.query<{ id: string }>(
      `SELECT id FROM core.users WHERE hospital_id = $1 AND id <> $2 LIMIT 1`,
      [hospitalId, userId],
    )
  ).rows[0]!.id;

  state.bookId = (
    await pool.query<{ id: string }>(`SELECT id FROM finance.books WHERE hospital_id = $1 LIMIT 1`, [
      hospitalId,
    ])
  ).rows[0]!.id;

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379/13';
  process.env['JWT_ACCESS_SECRET'] = 'nc022-access-secret-that-is-long-enough-0';
  process.env['JWT_REFRESH_SECRET'] = 'nc022-refresh-secret-that-is-long-enoug-0';
  process.env['RATE_LIMIT_AUTH_MAX'] = '10000';
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(
    BudgetTestModule,
    new FastifyAdapter({ trustProxy: true }),
    { logger: false },
  );
  app.setGlobalPrefix('api/v1');
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { hospitalId, identifier: 'nc022@vims-blr', password: PASSWORD },
  });
  token = login.json<{ accessToken: string }>().accessToken;
});

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe('NC-022 · budgets', () => {
  it('opens a cycle, which starts as a draft and binds nothing', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/finance/budget/cycles',
      reason: 'FY 2026-27 budget',
      payload: {
        bookId: state.bookId,
        code: 'FY27',
        name: 'FY 2026-27',
        startsOn: '2026-04-01',
        endsOn: '2027-03-31',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; status: string }>();
    expect(body.status).toBe('draft');
    state.cycleId = body.id;
  });

  it('refuses a cycle that ends before it starts', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/finance/budget/cycles',
      reason: 'backwards',
      payload: {
        bookId: state.bookId,
        code: 'FY99',
        name: 'Backwards',
        startsOn: '2027-03-31',
        endsOn: '2026-04-01',
      },
    });
    // Refused by the Zod schema before it reaches the database, which also
    // has a CHECK for it. Two copies of one rule is acceptable here only
    // because the second is the one that actually binds.
    expect(res.statusCode).toBe(400);
  });

  it('sets three lines and activates the cycle', async () => {
    const pool = pg.pool('migrator');
    const costCentreId = (
      await pool.query<{ id: string }>(
        `SELECT id FROM finance.cost_centres WHERE hospital_id = $1 ORDER BY code LIMIT 1`,
        [hospitalId],
      )
    ).rows[0]!.id;
    const accounts = await pool.query<{ id: string }>(
      `SELECT id FROM finance.accounts WHERE hospital_id = $1 AND code LIKE '5%' ORDER BY code LIMIT 3`,
      [hospitalId],
    );

    const lines = [
      { key: 'consumablesLineId', code: 'FY27-CONSUM', kind: 'operating', amount: '100000.00' },
      { key: 'maintenanceLineId', code: 'FY27-MAINT', kind: 'operating', amount: '50000.00' },
      { key: 'capexLineId', code: 'FY27-CAPEX', kind: 'capital', amount: '50000.00' },
    ] as const;

    for (const [i, line] of lines.entries()) {
      const res = await call({
        method: 'POST',
        url: '/api/v1/finance/budget/lines',
        reason: 'FY 2026-27 allocation',
        payload: {
          cycleId: state.cycleId,
          costCentreId,
          accountId: accounts.rows[i]!.id,
          code: line.code,
          budgetKind: line.kind,
          amount: line.amount,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json<{ lineId: string; available: string; originalAmount: string }>();
      expect(body.available).toBe(line.amount);
      expect(body.originalAmount).toBe(line.amount);
      state[line.key] = body.lineId;
    }

    const activate = await call({
      method: 'PATCH',
      url: `/api/v1/finance/budget/cycles/${state.cycleId}/status`,
      reason: 'board approved',
      payload: { status: 'active' },
    });
    expect(activate.statusCode).toBe(200);
    expect(activate.json<{ status: string }>().status).toBe('active');
  });

  it('allows a commitment that fits', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/finance/budget/commitments',
      payload: {
        lineId: state.consumablesLineId,
        sourceKind: 'purchase_order',
        sourceId: newId(),
        sourceRef: 'PO-FY27-0001',
        amount: '70000.00',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ amount: string }>().amount).toBe('70000.00');
  });

  // ── The rule the whole module exists for ─────────────────────────────────
  it('refuses a commitment that would take the line past its budget', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/finance/budget/commitments',
      payload: {
        lineId: state.consumablesLineId,
        sourceKind: 'purchase_order',
        sourceId: newId(),
        sourceRef: 'PO-FY27-0002',
        amount: '40000.00',
      },
    });
    expect(res.statusCode).toBe(409);
    const detail = res.json<{ detail: string }>().detail;
    expect(detail).toContain('30000.00');
    expect(detail).toContain('40000.00');
  });

  /**
   * The three-part sum, which is the point of commitment control.
   *
   * A control that watched actuals alone would approve a year's spending in a
   * week, because no purchase order has been paid yet. This asserts the other
   * half: that money already *spent* also closes the line, so a hospital
   * cannot commit against a budget it has already used.
   */
  it('counts money already spent, not just money committed', async () => {
    await pg
      .pool('migrator')
      .query(`UPDATE finance.budget_lines SET actual_amount = 20000, updated_at = now() WHERE id = $1`, [
        state.maintenanceLineId,
      ]);

    const res = await call({
      method: 'POST',
      url: '/api/v1/finance/budget/commitments',
      payload: {
        lineId: state.maintenanceLineId,
        sourceKind: 'indent',
        sourceId: newId(),
        sourceRef: 'IND-FY27-0001',
        amount: '35000.00',
      },
    });
    expect(res.statusCode).toBe(409);
    const detail = res.json<{ detail: string }>().detail;
    // 50,000 budget − 0 committed − 20,000 spent = 30,000 left.
    expect(detail).toContain('30000.00');
    expect(detail).toContain('already spent 20000.00');
  });

  it('warns before the order is written, and says it is only advisory', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/finance/budget/check',
      payload: { lineId: state.consumablesLineId, amount: '40000.00' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ wouldFit: boolean; available: string; message: string }>();
    expect(body.wouldFit).toBe(false);
    expect(body.available).toBe('30000.00');

    const ok = await call({
      method: 'POST',
      url: '/api/v1/finance/budget/check',
      payload: { lineId: state.consumablesLineId, amount: '10000.00' },
    });
    expect(ok.json<{ wouldFit: boolean }>().wouldFit).toBe(true);
    expect(ok.json<{ message: string }>().message).toContain('advisory');
  });

  it('releasing a commitment gives the budget back', async () => {
    const list = await call({
      method: 'GET',
      url: `/api/v1/finance/budget/commitments?lineId=${state.consumablesLineId}`,
    });
    const open = list.json<readonly { id: string; status: string }[]>().find((c) => c.status === 'open');
    expect(open).toBeDefined();

    const res = await call({
      method: 'PATCH',
      url: `/api/v1/finance/budget/commitments/${open!.id}/release`,
      reason: 'vendor withdrew',
      payload: { releasedReason: 'vendor withdrew the quotation', becomes: 'released' },
    });
    expect(res.statusCode).toBe(200);

    const position = await call({
      method: 'GET',
      url: `/api/v1/finance/budget/position?cycleId=${state.cycleId}`,
    });
    const line = position
      .json<readonly { lineId: string; available: string }[]>()
      .find((l) => l.lineId === state.consumablesLineId);
    expect(line?.available).toBe('100000.00');
  });

  it('a released commitment cannot be released twice', async () => {
    const list = await call({
      method: 'GET',
      url: `/api/v1/finance/budget/commitments?lineId=${state.consumablesLineId}`,
    });
    const released = list
      .json<readonly { id: string; status: string }[]>()
      .find((c) => c.status === 'released');
    const res = await call({
      method: 'PATCH',
      url: `/api/v1/finance/budget/commitments/${released!.id}/release`,
      reason: 'again',
      payload: { releasedReason: 'trying again', becomes: 'released' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('NC-022 · revisions and virements', () => {
  it('revises a single line and keeps the original for variance', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/finance/budget/lines/${state.capexLineId}/revisions`,
      reason: 'theatre light failed',
      payload: { toAmount: '65000.00', reason: 'Theatre light failed and must be replaced this year.' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      originalAmount: string;
      revisedAmount: string;
      revisionMovement: string;
    }>();
    expect(body.originalAmount).toBe('50000.00');
    expect(body.revisedAmount).toBe('65000.00');
    expect(body.revisionMovement).toBe('15000.00');
  });

  it('refuses a virement that does not net to zero', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/finance/budget/virements',
      reason: 'unbalanced',
      payload: {
        cycleId: state.cycleId,
        reason: 'Moving money to consumables',
        requestedBy: secondUserId,
        legs: [
          { lineId: state.consumablesLineId, toAmount: '115000.00', note: 'to consumables' },
          { lineId: state.maintenanceLineId, toAmount: '40000.00', note: 'from maintenance' },
        ],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: string }>().detail).toContain('net to zero');
  });

  it('and stores nothing when it refuses one', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/finance/budget/lines/${state.consumablesLineId}/revisions`,
    });
    expect(res.json<readonly unknown[]>().length).toBe(0);
  });

  it('refuses a virement between operating and capital', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/finance/budget/virements',
      reason: 'opex to capex',
      payload: {
        cycleId: state.cycleId,
        reason: 'Buying a monitor out of the maintenance budget',
        requestedBy: secondUserId,
        legs: [
          { lineId: state.capexLineId, toAmount: '75000.00', note: 'to capex' },
          { lineId: state.maintenanceLineId, toAmount: '40000.00', note: 'from maintenance' },
        ],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: string }>().detail).toContain('board decision');
  });

  it('refuses a virement the requester approves themselves', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/finance/budget/virements',
      reason: 'self approved',
      payload: {
        cycleId: state.cycleId,
        reason: 'Approving my own transfer',
        requestedBy: state.userId,
        legs: [
          { lineId: state.consumablesLineId, toAmount: '110000.00', note: 'to consumables' },
          { lineId: state.maintenanceLineId, toAmount: '40000.00', note: 'from maintenance' },
        ],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: string }>().detail).toContain('second person');
  });

  it('accepts a balanced virement and moves both lines', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/finance/budget/virements',
      reason: 'monsoon consumable surge',
      payload: {
        cycleId: state.cycleId,
        reference: 'VIR-FY27-001',
        reason: 'Monsoon consumable surge; maintenance deferred to Q4.',
        requestedBy: secondUserId,
        legs: [
          { lineId: state.consumablesLineId, toAmount: '110000.00', note: 'to consumables' },
          { lineId: state.maintenanceLineId, toAmount: '40000.00', note: 'from maintenance' },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const rows = res.json<readonly { lineId: string; revisedAmount: string; available: string }[]>();
    const consum = rows.find((r) => r.lineId === state.consumablesLineId);
    const maint = rows.find((r) => r.lineId === state.maintenanceLineId);
    expect(consum?.revisedAmount).toBe('110000.00');
    expect(maint?.revisedAmount).toBe('40000.00');
    // Maintenance has 20,000 already spent, so 40,000 − 20,000 = 20,000 left.
    expect(maint?.available).toBe('20000.00');
  });

  it('records both legs against the virement, append-only', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/finance/budget/lines/${state.consumablesLineId}/revisions`,
    });
    const rows = res.json<readonly { movement: string; virementId: string | null }[]>();
    expect(rows.length).toBe(1);
    expect(rows[0]!.movement).toBe('10000.00');
    expect(rows[0]!.virementId).not.toBeNull();

    // No endpoint rewrites one, and the database refuses it directly too.
    await expect(
      pg
        .pool('migrator')
        .query(`UPDATE finance.budget_revisions SET to_amount = 999999 WHERE line_id = $1`, [
          state.consumablesLineId,
        ]),
    ).rejects.toThrow(/cannot be changed/);
  });

  it('a draft or closed cycle accepts no commitments', async () => {
    await call({
      method: 'PATCH',
      url: `/api/v1/finance/budget/cycles/${state.cycleId}/status`,
      reason: 'year end',
      payload: { status: 'closed' },
    });

    const res = await call({
      method: 'POST',
      url: '/api/v1/finance/budget/commitments',
      payload: {
        lineId: state.consumablesLineId,
        sourceKind: 'indent',
        sourceId: newId(),
        sourceRef: 'IND-LATE',
        amount: '100.00',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: string }>().detail).toContain('closed');
  });
});
