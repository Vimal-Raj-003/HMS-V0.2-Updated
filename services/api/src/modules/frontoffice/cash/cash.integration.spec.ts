import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, SETTING_DEFINITIONS, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';

/**
 * NC-001 against a real PostgreSQL 17.
 *
 * The five properties worth a container:
 *
 *  1. **§269ST.** ₹1,99,999.99 of cash from one payer in one day is accepted and
 *     the next rupee is refused — the boundary exactly, because "about two
 *     lakh" is not what the section says.
 *  2. **Receipt numbers are gapless.** The receipt refused by the cap gives its
 *     number back, so the next successful receipt takes it.
 *  3. **A cashier cannot approve their own variance**, even holding the key.
 *  4. **Money out needs a second person**, and the second person cannot be the
 *     first.
 *  5. **A shift does not close over an unexplained variance**, and a split
 *     tender that does not balance is refused at write time.
 */

/**
 * `AppModule` declares this module's controllers and providers directly (see
 * app.module.ts), so importing the feature module here as well mounts every
 * route twice and Fastify refuses the second with FST_ERR_DUPLICATED_ROUTE --
 * the suite then fails to bootstrap at all rather than failing a test.
 */
@Module({ imports: [AppModule] })
class CashTestApp {}

let pg: TestPostgres;
let app: NestFastifyApplication;
let tenants: TenantFixture;

const PASSWORD = 'Correct-Horse-Battery-9!';

interface Actor {
  readonly userId: string;
  readonly roleId: string;
  readonly username: string;
  token: string;
}

/** Takes money; holds neither the variance key nor either money-out key. */
const cashierA: Actor = { userId: newId(), roleId: newId(), username: 'cash-cashier-a', token: '' };
/** Holds `receipt.shift.variance.approve` **and** operates a counter — the case that proves SoD. */
const selfApproverA: Actor = { userId: newId(), roleId: newId(), username: 'cash-selfapprover-a', token: '' };
/** Head cashier: every NC-001 key, so it can approve, co-sign and pay out. */
const headCashierA: Actor = { userId: newId(), roleId: newId(), username: 'cash-head-a', token: '' };
/** Holds every NC-001 key too, and is the second pair of eyes on money going out. */
const supervisorA: Actor = { userId: newId(), roleId: newId(), username: 'cash-supervisor-a', token: '' };
/** Read-only, for the gating test. */
const readerA: Actor = { userId: newId(), roleId: newId(), username: 'cash-reader-a', token: '' };
const cashierB: Actor = { userId: newId(), roleId: newId(), username: 'cash-cashier-b', token: '' };

const ALL_RECEIPT_KEYS = PERMISSION_CATALOGUE.filter((p) => p.key.startsWith('receipt.')).map((p) => p.key);
const CASHIER_KEYS = [
  'receipt.shift.open',
  'receipt.shift.read',
  'receipt.shift.list',
  'receipt.shift.close',
  'receipt.collect',
];
const SELF_APPROVER_KEYS = [...CASHIER_KEYS, 'receipt.shift.variance.approve'];

const counter1 = newId();
const counter2 = newId();
const counter3 = newId();
const counterUnassigned = newId();
const counterB = newId();

let shiftA = '';
let firstPaymentId = '';

async function syncCatalogues(): Promise<void> {
  const pool = pg.pool('migrator');
  for (const p of PERMISSION_CATALOGUE) {
    await pool.query(
      `INSERT INTO core.permissions (key, module, resource, action, description, data_class, risk, phase,
         sensitive_grant, requires_second_person, requires_reason, requires_step_up, phi_read, clinical_safety_exempt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (key) DO NOTHING`,
      [
        p.key,
        p.module,
        p.resource,
        p.action,
        p.description,
        p.dataClass,
        p.risk,
        p.phase,
        p.sensitiveGrant ?? false,
        p.requiresSecondPerson ?? false,
        p.requiresReason ?? false,
        p.requiresStepUp ?? false,
        p.phiRead ?? false,
        p.clinicalSafetyExempt ?? false,
      ],
    );
  }
  for (const d of SETTING_DEFINITIONS) {
    await pool.query(
      `INSERT INTO core.setting_definitions
         (key, module, label, description, scopes, json_schema, default_value, sensitivity,
          requires_approval, dual_control)
       VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,$6::jsonb,$7,$8,$9)
       ON CONFLICT (key) DO NOTHING`,
      [
        d.key,
        d.module,
        d.label,
        d.description,
        [...d.scopes],
        JSON.stringify(d.defaultValue),
        d.sensitivity,
        d.requiresApproval,
        d.dualControl,
      ],
    );
  }
}

async function seedActor(
  hospitalId: string,
  branchId: string,
  actor: Actor,
  permissionKeys: readonly string[],
): Promise<void> {
  const pool = pg.pool('migrator');
  const hash = await argon2.hash(PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  await pool.query(
    `INSERT INTO core.roles (id, hospital_id, key, name, description, home_workspace, category, updated_at)
     VALUES ($1, $2, $3, $4, 'Integration test role', 'cash_counter', 'operational', now())`,
    [actor.roleId, hospitalId, `role_${actor.username.replace(/-/g, '_')}`, `Role ${actor.username}`],
  );
  for (const key of permissionKeys) {
    await pool.query(
      `INSERT INTO core.role_permissions (role_id, permission_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [actor.roleId, key],
    );
  }
  await pool.query(
    `INSERT INTO core.users (id, hospital_id, group_id, username, email, name, display_name,
                             password_hash, status, type, updated_at)
     VALUES ($1, $2, (SELECT group_id FROM core.hospitals WHERE id = $2), $3, $4, $5::jsonb, $6, $7,
             'active', 'staff', now())`,
    [
      actor.userId,
      hospitalId,
      actor.username,
      `${actor.username}@example.invalid`,
      JSON.stringify({ given: 'Test', family: actor.username }),
      `Test ${actor.username}`,
      hash,
    ],
  );
  await pool.query(
    `INSERT INTO core.user_roles (id, hospital_id, user_id, role_id, branch_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [newId(), hospitalId, actor.userId, actor.roleId, branchId],
  );
}

async function seedCounter(
  id: string,
  hospitalId: string,
  branchId: string,
  code: string,
  assignees: readonly string[],
): Promise<void> {
  const pool = pg.pool('migrator');
  await pool.query(
    `INSERT INTO billing.cash_counters
       (id, hospital_id, branch_id, code, name, counter_type, allowed_modes, float_limit,
        drawer_alert_limit, currency, receipt_series_key, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'general'::billing."CashCounterType",
             ARRAY['cash','card','upi','cheque','wallet']::billing."PaymentMode"[],
             0, 100000, 'INR', 'RECEIPT', now())`,
    [id, hospitalId, branchId, code, `Counter ${code}`],
  );
  for (const userId of assignees) {
    await pool.query(
      `INSERT INTO billing.cash_counter_assignments
         (id, hospital_id, branch_id, counter_id, user_id, valid_from, updated_at)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 day', now())`,
      [newId(), hospitalId, branchId, id, userId],
    );
  }
}

async function seedReceiptSeries(hospitalId: string, branchId: string): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO core.numbering_series
       (id, hospital_id, branch_id, key, pattern, scope, fy, current_value, gapless,
        reset_policy, version, effective_from, active, created_at, updated_at)
     VALUES ($1, $2, $3, 'RECEIPT', 'RCT-{SEQ:6}', 'branch', NULL, 0, true,
             'never'::"core"."NumberingResetPolicy", 1, now() - interval '1 day', true, now(), now())`,
    [newId(), hospitalId, branchId],
  );
}

async function login(hospitalId: string, identifier: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { hospitalId, identifier, password: PASSWORD },
  });
  const body = res.json<{ accessToken?: string }>();
  if (typeof body.accessToken !== 'string') {
    throw new Error(`login failed for ${identifier}: ${res.statusCode} ${res.body}`);
  }
  return body.accessToken;
}

interface CallOptions {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly token: string;
  readonly reason?: string;
  /** Supply one only to test replay; otherwise every call is a fresh submission. */
  readonly idempotencyKey?: string;
  readonly payload?: Record<string, unknown>;
}

async function call(options: CallOptions) {
  const headers: Record<string, string> = { authorization: `Bearer ${options.token}` };
  if (options.reason !== undefined) headers['x-reason'] = options.reason;
  // Routes marked `@Idempotent()` refuse a POST with no key. A fresh key per
  // call keeps each one a distinct submission, which is what these tests mean;
  // a test that is about replay passes the same key twice deliberately.
  if (options.method === 'POST') {
    headers['idempotency-key'] = options.idempotencyKey ?? newId();
  }
  return app.inject({
    method: options.method,
    url: options.url,
    headers,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

async function openShift(actor: Actor, counterId: string, notes: readonly number[]): Promise<string> {
  const res = await call({
    method: 'POST',
    url: '/api/v1/cash/shifts/open',
    token: actor.token,
    payload: {
      counterId,
      denominations: notes.map((count, index) => ({
        denomination: ['500', '100'][index] ?? '100',
        count,
      })),
    },
  });
  if (res.statusCode !== 201) throw new Error(`open shift failed: ${res.statusCode} ${res.body}`);
  return res.json<{ id: string }>().id;
}

async function auditRowsForTrace(traceId: unknown): Promise<Array<Record<string, unknown>>> {
  const result = await pg.pool('migrator').query(
    `SELECT id, actor_user_id, entity, action::text AS action, row_id, business_key, data_class::text AS data_class
         FROM core.audit_log WHERE trace_id = $1`,
    [String(traceId)],
  );
  return result.rows as Array<Record<string, unknown>>;
}

async function outboxRowsForTrace(traceId: unknown): Promise<Array<Record<string, unknown>>> {
  const result = await pg.pool('migrator').query(
    `SELECT id, event_type, aggregate_id, payload FROM core.outbox_events
        WHERE trace_id = $1 ORDER BY event_type`,
    [String(traceId)],
  );
  return result.rows as Array<Record<string, unknown>>;
}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'CSH' });
  await syncCatalogues();

  await seedActor(tenants.hospitalA, tenants.branchA, cashierA, CASHIER_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, selfApproverA, SELF_APPROVER_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, headCashierA, ALL_RECEIPT_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, supervisorA, ALL_RECEIPT_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, readerA, ['receipt.shift.read']);
  await seedActor(tenants.hospitalB, tenants.branchB, cashierB, CASHIER_KEYS);

  await seedCounter(counter1, tenants.hospitalA, tenants.branchA, 'CC-OP-01', [cashierA.userId]);
  await seedCounter(counter2, tenants.hospitalA, tenants.branchA, 'CC-OP-02', [selfApproverA.userId]);
  await seedCounter(counter3, tenants.hospitalA, tenants.branchA, 'CC-OP-03', [headCashierA.userId]);
  await seedCounter(counterUnassigned, tenants.hospitalA, tenants.branchA, 'CC-OP-99', []);
  await seedCounter(counterB, tenants.hospitalB, tenants.branchB, 'CC-OP-01', [cashierB.userId]);

  await seedReceiptSeries(tenants.hospitalA, tenants.branchA);
  await seedReceiptSeries(tenants.hospitalB, tenants.branchB);

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['DATABASE_POOL_MAX'] = '10';
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(CashTestApp, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  cashierA.token = await login(tenants.hospitalA, cashierA.username);
  selfApproverA.token = await login(tenants.hospitalA, selfApproverA.username);
  headCashierA.token = await login(tenants.hospitalA, headCashierA.username);
  supervisorA.token = await login(tenants.hospitalA, supervisorA.username);
  readerA.token = await login(tenants.hospitalA, readerA.username);
  cashierB.token = await login(tenants.hospitalB, cashierB.username);
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe('shift open', () => {
  it('opens with a counted float, one audit row and one outbox event', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/cash/shifts/open',
      token: cashierA.token,
      payload: { counterId: counter1, denominations: [{ denomination: '500', count: 10 }] },
    });

    expect(res.statusCode).toBe(201);
    const shift = res.json<{ id: string; status: string; openingFloat: string; expectedCash: string }>();
    shiftA = shift.id;
    expect(shift.status).toBe('open');
    expect(shift.openingFloat).toBe('5000.00');
    expect(shift.expectedCash).toBe('5000.00');

    const audit = await auditRowsForTrace(res.headers['x-trace-id']);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      entity: 'billing.cash_shifts',
      action: 'insert',
      data_class: 'financial',
      actor_user_id: cashierA.userId,
    });

    const events = await outboxRowsForTrace(res.headers['x-trace-id']);
    expect(events.map((e) => e['event_type'])).toEqual(['cash.shift.opened']);

    const sheets = await pg
      .pool('migrator')
      .query(
        `SELECT kind::text AS kind, total::text AS total FROM billing.cash_denomination_sheets WHERE shift_id = $1`,
        [shift.id],
      );
    expect(sheets.rows).toEqual([{ kind: 'opening', total: '5000.00' }]);
  });

  it('refuses a role that does not hold receipt.shift.open', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/cash/shifts/open',
      token: readerA.token,
      payload: { counterId: counterUnassigned, denominations: [] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('refuses a counter the cashier is not assigned to', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/cash/shifts/open',
      token: cashierA.token,
      payload: { counterId: counterUnassigned, denominations: [] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('not assigned');
  });

  it('refuses a second open shift on the same counter', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/cash/shifts/open',
      token: cashierA.token,
      payload: { counterId: counter1, denominations: [] },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('tenancy', () => {
  it('returns 404 — not 403 — for another hospital’s counter and shift', async () => {
    const theirs = await openShift(cashierB, counterB, [2]);

    const foreignCounter = await call({
      method: 'POST',
      url: '/api/v1/cash/shifts/open',
      token: cashierA.token,
      payload: { counterId: counterB, denominations: [] },
    });
    const foreignShift = await call({
      method: 'GET',
      url: `/api/v1/cash/shifts/${theirs}`,
      token: cashierA.token,
    });
    const ghost = await call({ method: 'GET', url: `/api/v1/cash/shifts/${newId()}`, token: cashierA.token });

    expect(foreignCounter.statusCode).toBe(404);
    expect(foreignShift.statusCode).toBe(404);
    expect(ghost.statusCode).toBe(404);
    expect(foreignShift.json<{ detail: string }>().detail).toBe(ghost.json<{ detail: string }>().detail);
  });
});

describe('collection', () => {
  it('takes a split payment, balances it, and issues one gapless receipt', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/cash/payments',
      token: cashierA.token,
      payload: {
        shiftId: shiftA,
        patientId: newId(),
        amount: '1500.00',
        lines: [
          { mode: 'cash', amount: '500.00', tendered: '500.00' },
          { mode: 'upi', amount: '1000.00', reference: 'UPI-1' },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    const payment = res.json<{ id: string; receiptNo: string; amount: string; lines: unknown[] }>();
    firstPaymentId = payment.id;
    expect(payment.receiptNo).toBe('RCT-000001');
    expect(payment.lines).toHaveLength(2);

    const audit = await auditRowsForTrace(res.headers['x-trace-id']);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entity: 'billing.payments', business_key: 'RCT-000001' });
    const events = await outboxRowsForTrace(res.headers['x-trace-id']);
    expect(events.map((e) => e['event_type'])).toEqual(['receipt.issued']);

    const totals = await pg.pool('migrator').query(
      `SELECT mode::text AS mode, collections::text AS collections FROM billing.cash_shift_totals
          WHERE shift_id = $1 ORDER BY mode::text`,
      [shiftA],
    );
    expect(totals.rows).toEqual([
      { mode: 'cash', collections: '500.00' },
      { mode: 'upi', collections: '1000.00' },
    ]);
  });

  it('refuses a split that does not add up, and writes nothing', async () => {
    const before = await pg.pool('migrator').query(`SELECT count(*)::int AS n FROM billing.payments`);
    const res = await call({
      method: 'POST',
      url: '/api/v1/cash/payments',
      token: cashierA.token,
      payload: {
        shiftId: shiftA,
        patientId: newId(),
        amount: '1500.00',
        lines: [
          { mode: 'cash', amount: '500.00' },
          { mode: 'upi', amount: '999.99' },
        ],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: string }>().detail).toContain('must balance exactly');

    const after = await pg.pool('migrator').query(`SELECT count(*)::int AS n FROM billing.payments`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  /**
   * §269ST is a boundary, not an approximation, and the boundary is inclusive:
   * the section forbids receiving "two lakh rupees **or more**", so ₹2,00,000
   * itself is already a breach and ₹1,99,999.99 is the largest receivable sum.
   * §271DA sets the penalty at the whole amount received, so the boundary rupee
   * costs ₹2,00,000 -- which is why this is tested to the paisa rather than
   * approximated. Weakening the comparison to `>` fails this test; dropping the
   * check fails the one below it.
   */
  it('accepts ₹1,99,999.99 of cash from one payer and refuses the rupee that reaches the cap', async () => {
    const payer = newId();

    const belowCap = await call({
      method: 'POST',
      url: '/api/v1/cash/payments',
      token: cashierA.token,
      payload: {
        shiftId: shiftA,
        patientId: payer,
        amount: '199999.99',
        lines: [{ mode: 'cash', amount: '199999.99' }],
      },
    });
    expect(belowCap.statusCode).toBe(201);

    const overCap = await call({
      method: 'POST',
      url: '/api/v1/cash/payments',
      token: cashierA.token,
      payload: {
        shiftId: shiftA,
        patientId: payer,
        amount: '0.01',
        lines: [{ mode: 'cash', amount: '0.01' }],
      },
    });
    expect(overCap.statusCode).toBe(422);
    expect(overCap.json<{ type: string }>().type).toContain('statutory-limit');

    const ledger = await pg
      .pool('migrator')
      .query(
        `SELECT cash_total::text AS cash_total FROM billing.cash_payer_day_totals WHERE payer_ref_id = $1`,
        [payer],
      );
    expect(ledger.rows[0].cash_total).toBe('199999.99');
  });

  it('does not accept the same cash again by splitting it across receipts', async () => {
    const payer = newId();
    for (const amount of ['150000.00', '49999.00']) {
      const res = await call({
        method: 'POST',
        url: '/api/v1/cash/payments',
        token: cashierA.token,
        payload: {
          shiftId: shiftA,
          patientId: payer,
          amount,
          lines: [{ mode: 'cash', amount }],
        },
      });
      expect(res.statusCode).toBe(201);
    }
    // 1,99,999 + 1 lands exactly on ₹2,00,000, which §269ST already forbids.
    // Asking for 2.00 here would be refused under either comparison and so
    // would prove nothing about the boundary.
    const atCap = await call({
      method: 'POST',
      url: '/api/v1/cash/payments',
      token: cashierA.token,
      payload: {
        shiftId: shiftA,
        patientId: payer,
        amount: '1.00',
        lines: [{ mode: 'cash', amount: '1.00' }],
      },
    });
    expect(atCap.statusCode).toBe(422);
  });

  it('gives the refused receipt’s number back, so the series has no hole', async () => {
    const numbers = await pg
      .pool('migrator')
      .query(`SELECT receipt_no FROM billing.payments WHERE hospital_id = $1 ORDER BY receipt_no`, [
        tenants.hospitalA,
      ]);
    const issued = numbers.rows.map((r: { receipt_no: string }) => r.receipt_no);
    const expected = issued.map((_: string, index: number) => `RCT-${String(index + 1).padStart(6, '0')}`);
    expect(issued).toEqual(expected);
  });

  it('returns the same receipt for a retried Idempotency-Key', async () => {
    const key = `idem-${newId()}`;
    const payload = {
      shiftId: shiftA,
      patientId: newId(),
      amount: '250.00',
      lines: [{ mode: 'card', amount: '250.00', cardLast4: '4242' }],
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/cash/payments',
      headers: { authorization: `Bearer ${cashierA.token}`, 'idempotency-key': key },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/cash/payments',
      headers: { authorization: `Bearer ${cashierA.token}`, 'idempotency-key': key },
      payload,
    });
    expect(first.json<{ id: string }>().id).toBe(second.json<{ id: string }>().id);
  });
});

describe('shift close and variance', () => {
  it('will not close over an unexplained variance, and will not let the cashier approve their own', async () => {
    const shift = await openShift(selfApproverA, counter2, [4]);

    const noReason = await call({
      method: 'POST',
      url: `/api/v1/cash/shifts/${shift}/close`,
      token: selfApproverA.token,
      payload: { denominations: [{ denomination: '500', count: 3 }] },
    });
    expect(noReason.statusCode).toBe(422);
    expect(noReason.json<{ type: string }>().type).toContain('business-rule-violated');

    const parked = await call({
      method: 'POST',
      url: `/api/v1/cash/shifts/${shift}/close`,
      token: selfApproverA.token,
      payload: {
        denominations: [{ denomination: '500', count: 3 }],
        varianceReason: 'note handed to the next counter without a slip',
      },
    });
    expect(parked.statusCode).toBe(201);
    const parkedBody = parked.json<{ status: string; variance: string; blockedBy: string | null }>();
    expect(parkedBody.status).toBe('closing');
    expect(parkedBody.variance).toBe('-500.00');
    expect(parkedBody.blockedBy).toBe('variance_approval');

    // No `cash.shift.closed` may have been announced: the shift is not closed.
    const parkedEvents = await outboxRowsForTrace(parked.headers['x-trace-id']);
    expect(parkedEvents).toHaveLength(0);

    const selfApproval = await call({
      method: 'POST',
      url: `/api/v1/cash/shifts/${shift}/variance/approve`,
      token: selfApproverA.token,
      reason: 'I counted it myself',
    });
    expect(selfApproval.statusCode).toBe(403);
    expect(selfApproval.json<{ type: string }>().type).toContain('segregation-of-duties');

    const stillClosing = await call({
      method: 'POST',
      url: `/api/v1/cash/shifts/${shift}/close`,
      token: selfApproverA.token,
      payload: {
        denominations: [{ denomination: '500', count: 3 }],
        varianceReason: 'note handed to the next counter without a slip',
      },
    });
    expect(stillClosing.json<{ status: string }>().status).toBe('closing');

    const approved = await call({
      method: 'POST',
      url: `/api/v1/cash/shifts/${shift}/variance/approve`,
      token: headCashierA.token,
      reason: 'counted with the cashier; shortage recovered from the float',
    });
    expect(approved.statusCode).toBe(201);
    expect(approved.json<{ varianceApprovedBy: string }>().varianceApprovedBy).toBe(headCashierA.userId);

    const closed = await call({
      method: 'POST',
      url: `/api/v1/cash/shifts/${shift}/close`,
      token: selfApproverA.token,
      payload: {
        denominations: [{ denomination: '500', count: 3 }],
        varianceReason: 'note handed to the next counter without a slip',
        handoverTo: 'main_cash',
        handoverBagNo: 'BAG-01',
      },
    });
    expect(closed.statusCode).toBe(201);
    expect(closed.json<{ status: string }>().status).toBe('closed');

    const events = await outboxRowsForTrace(closed.headers['x-trace-id']);
    expect(events.map((e) => e['event_type'])).toEqual(['cash.shift.closed']);
    expect(events[0]?.['payload']).toMatchObject({
      expected: '2000.00',
      declared: '1500.00',
      variance: '-500.00',
    });
  });

  it('closes cleanly when the drawer balances', async () => {
    const shift = await openShift(headCashierA, counter3, [2]);
    const closed = await call({
      method: 'POST',
      url: `/api/v1/cash/shifts/${shift}/close`,
      token: headCashierA.token,
      payload: { denominations: [{ denomination: '500', count: 2 }] },
    });
    expect(closed.statusCode).toBe(201);
    const body = closed.json<{ status: string; variance: string }>();
    expect(body.status).toBe('closed');
    expect(body.variance).toBe('0.00');
  });

  it('will not close over a digital tender the gateway has not confirmed', async () => {
    const shift = await openShift(selfApproverA, counter2, [2]);
    const collected = await call({
      method: 'POST',
      url: '/api/v1/cash/payments',
      token: selfApproverA.token,
      payload: {
        shiftId: shift,
        patientId: newId(),
        amount: '500.00',
        lines: [{ mode: 'upi', amount: '500.00', reference: 'QR-pending', pending: true }],
      },
    });
    expect(collected.statusCode).toBe(201);

    const blocked = await call({
      method: 'POST',
      url: `/api/v1/cash/shifts/${shift}/close`,
      token: selfApproverA.token,
      payload: { denominations: [{ denomination: '500', count: 2 }] },
    });
    expect(
      blocked.json<{ status: string; blockedBy: string | null; pendingConfirmations: number }>(),
    ).toMatchObject({
      status: 'open',
      blockedBy: 'pending_confirmations',
      pendingConfirmations: 1,
    });

    await retireShift(shift);
  });
});

describe('money out needs two people', () => {
  it('refuses a refund payout to a cashier who does not hold receipt.refund.pay', async () => {
    const refundId = await seedApprovedRefund('100.00');
    const res = await call({
      method: 'POST',
      url: `/api/v1/cash/refunds/${refundId}/pay`,
      token: cashierA.token,
      reason: 'patient cancelled the consultation',
      payload: {
        shiftId: shiftA,
        coSigner: { identifier: supervisorA.username, credential: PASSWORD, credentialKind: 'password' },
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ nextAction: string }>().nextAction).toContain('receipt.refund.pay');
  });

  it('refuses a payout co-signed by the person paying it', async () => {
    const refundId = await seedApprovedRefund('100.00');
    const shift = await openShift(headCashierA, counter3, [4]);
    const res = await call({
      method: 'POST',
      url: `/api/v1/cash/refunds/${refundId}/pay`,
      token: headCashierA.token,
      reason: 'patient cancelled the consultation',
      payload: {
        shiftId: shift,
        coSigner: { identifier: headCashierA.username, credential: PASSWORD, credentialKind: 'password' },
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ type: string }>().type).toContain('segregation-of-duties');
    await retireShift(shift);
  });

  it('refuses a payout when the co-signer’s credential is wrong', async () => {
    const refundId = await seedApprovedRefund('100.00');
    const shift = await openShift(headCashierA, counter3, [4]);
    const res = await call({
      method: 'POST',
      url: `/api/v1/cash/refunds/${refundId}/pay`,
      token: headCashierA.token,
      reason: 'patient cancelled the consultation',
      payload: {
        shiftId: shift,
        coSigner: {
          identifier: supervisorA.username,
          credential: 'not-the-password',
          credentialKind: 'password',
        },
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ type: string }>().type).toContain('second-person-required');
    await retireShift(shift);
  });

  it('refuses a co-signer who does not hold the authority themselves', async () => {
    const refundId = await seedApprovedRefund('100.00');
    const shift = await openShift(headCashierA, counter3, [4]);
    const res = await call({
      method: 'POST',
      url: `/api/v1/cash/refunds/${refundId}/pay`,
      token: headCashierA.token,
      reason: 'patient cancelled the consultation',
      payload: {
        // A cashier is a second person, but not a second *authoriser*.
        shiftId: shift,
        coSigner: { identifier: cashierA.username, credential: PASSWORD, credentialKind: 'password' },
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ type: string }>().type).toContain('second-person-required');
    await retireShift(shift);
  });

  it('pays the refund when a different authorised person co-signs', async () => {
    const refundId = await seedApprovedRefund('100.00');
    const shift = await openShift(headCashierA, counter3, [4]);
    const res = await call({
      method: 'POST',
      url: `/api/v1/cash/refunds/${refundId}/pay`,
      token: headCashierA.token,
      reason: 'patient cancelled the consultation',
      payload: {
        shiftId: shift,
        coSigner: { identifier: supervisorA.username, credential: PASSWORD, credentialKind: 'password' },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ status: string }>().status).toBe('processed');

    const events = await outboxRowsForTrace(res.headers['x-trace-id']);
    expect(events.map((e) => e['event_type'])).toEqual(['refund.issued']);

    const totals = await pg
      .pool('migrator')
      .query(
        `SELECT refunds::text AS refunds FROM billing.cash_shift_totals WHERE shift_id = $1 AND mode = 'cash'`,
        [shift],
      );
    expect(totals.rows[0]).toMatchObject({ refunds: '100.00' });

    // §269ST headroom is never restored by money going back out.
    const ledger = await pg
      .pool('migrator')
      .query(`SELECT count(*)::int AS n FROM billing.cash_payer_day_totals WHERE cash_total < 0`);
    expect(ledger.rows[0].n).toBe(0);

    await retireShift(shift);
  });

  it('voids a receipt only with a second person, and keeps the number', async () => {
    const shift = await openShift(headCashierA, counter3, [2]);
    const collected = await call({
      method: 'POST',
      url: '/api/v1/cash/payments',
      token: headCashierA.token,
      payload: {
        shiftId: shift,
        patientId: newId(),
        amount: '300.00',
        lines: [{ mode: 'cash', amount: '300.00' }],
      },
    });
    const receiptId = collected.json<{ id: string; receiptNo: string }>().id;
    const receiptNo = collected.json<{ receiptNo: string }>().receiptNo;

    const alone = await call({
      method: 'POST',
      url: `/api/v1/cash/receipts/${receiptId}/void`,
      token: headCashierA.token,
      reason: 'wrong patient',
      payload: {
        reason: 'wrong patient',
        coSigner: { identifier: headCashierA.username, credential: PASSWORD, credentialKind: 'password' },
      },
    });
    expect(alone.statusCode).toBe(403);

    const voided = await call({
      method: 'POST',
      url: `/api/v1/cash/receipts/${receiptId}/void`,
      token: headCashierA.token,
      reason: 'wrong patient',
      payload: {
        reason: 'wrong patient',
        coSigner: { identifier: supervisorA.username, credential: PASSWORD, credentialKind: 'password' },
      },
    });
    expect(voided.statusCode).toBe(201);
    expect(voided.json<{ status: string; receiptNo: string }>()).toMatchObject({
      status: 'voided',
      receiptNo,
    });

    const events = await outboxRowsForTrace(voided.headers['x-trace-id']);
    expect(events.map((e) => e['event_type'])).toEqual(['receipt.voided']);

    const record = await pg
      .pool('migrator')
      .query(`SELECT approved_by, voided_by, reason FROM billing.cash_receipt_voids WHERE receipt_id = $1`, [
        receiptId,
      ]);
    expect(record.rows[0]).toMatchObject({
      approved_by: supervisorA.userId,
      voided_by: headCashierA.userId,
      reason: 'wrong patient',
    });
  });
});

/** An approved refund as EN-038 would have left it: approved by somebody who is not paying it. */
async function seedApprovedRefund(amount: string): Promise<string> {
  const id = newId();
  await pg.pool('migrator').query(
    `INSERT INTO billing.refunds
       (id, hospital_id, branch_id, refund_no, patient_id, payment_id, amount, currency, mode,
        reason_code, status, requested_by, approved_by, approved_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, 'INR', 'cash'::billing."PaymentMode",
             'service_cancelled', 'approved'::billing."RefundStatus", $8, $9, now(), now())`,
    [
      id,
      tenants.hospitalA,
      tenants.branchA,
      `RFD-${id.slice(-12)}`,
      newId(),
      firstPaymentId,
      amount,
      cashierA.userId,
      selfApproverA.userId,
    ],
  );
  return id;
}

/**
 * Test scaffolding, not an assertion: frees the counter for the next test.
 *
 * It closes the shift with a direct statement rather than through the API
 * because these shifts have had money move through them and re-deriving a
 * denomination sheet that lands exactly on the expected figure would be a test
 * asserting its own arithmetic. The close path itself is proved in its own
 * describe block.
 */
async function retireShift(shiftId: string): Promise<void> {
  await pg.pool('migrator').query(
    `UPDATE billing.cash_shifts
        SET status = 'closed'::billing."CashShiftStatus", counted_cash = expected_cash,
            closed_at = now(), updated_at = now()
      WHERE id = $1`,
    [shiftId],
  );
}
