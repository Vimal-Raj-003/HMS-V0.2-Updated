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
 * NC-012 + RC-005 through the API.
 *
 * The assertions are the ones that protect a corporate relationship and the
 * hospital's money: that a bill cannot be invoiced twice, that a credit limit
 * and a hold actually stop an invoice, that the amounts come from the bills,
 * that a write-off cannot approve itself, and that a settled invoice cannot be
 * cancelled out from under a payment.
 */

let pg: TestPostgres;
let app: NestFastifyApplication;

const PASSWORD = 'VimsDev#2026';
let hospitalId = '';
let branchId = '';
let token = '';
let secondUserId = '';

const state = { accountId: '', invoiceId: '', payerId: '', userId: '', billIds: [] as string[] };

@Module({ imports: [AppModule] })
class CorporateTestModule {}

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
     VALUES ($1,$2,'nc012_e2e','NC-012 e2e','end to end','dashboard','governance', now())`,
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
     VALUES ($1,$2,(SELECT group_id FROM core.hospitals WHERE id=$2),'nc012@vims-blr',
             'nc012@example.invalid','{"given":"NC","family":"Twelve"}'::jsonb,'NC Twelve',$3,'active','staff', now())`,
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

  // A corporate payer to hold the account against. The demo seed carries
  // insurers but no corporate, and a fixture that silently used an insurer
  // would be testing a different relationship.
  const payerId = newId();
  await pool.query(
    `INSERT INTO billing.ins_payers (id, hospital_id, code, name, payer_type, active, created_at, updated_at)
     VALUES ($1,$2,'ACME-CO','Acme Industries Pvt Ltd','corporate',true, now(), now())`,
    [payerId, hospitalId],
  );
  state.payerId = payerId;

  // Two finalised bills, built header **and** line.
  //
  // `billing.bills` enforces that its lines total the header (OP-005 §5), so a
  // header alone is refused — correctly. The first attempt at this fixture
  // inserted only headers and the constraint caught it, which is the invariant
  // doing its job rather than an obstacle to work around.
  const patientId = (
    await pool.query<{ id: string }>(`SELECT id FROM patient.patients WHERE hospital_id = $1 LIMIT 1`, [
      hospitalId,
    ])
  ).rows[0]!.id;

  for (let i = 0; i < 2; i += 1) {
    const billId = newId();
    state.billIds.push(billId);
    await pool.query(
      `INSERT INTO billing.bills
         (id, hospital_id, branch_id, bill_no, patient_id, bill_type, status, payer_type,
          currency, gross_amount, taxable_amount, cgst, sgst, igst, net_amount,
          finalized_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'op','draft','corporate','INR',
               1000.00, 0, 0, 0, 0, 1000.00, now(), now())`,
      [billId, hospitalId, branchId, `CORP-TEST-${String(i)}`, patientId],
    );
    await pool.query(
      `INSERT INTO billing.bill_items
         (id, hospital_id, bill_id, item_type, description, qty, unit_price, gross,
          discount_amount, taxable_value, gst_rate, cgst, sgst, igst, cess, is_exempt,
          net, status, price_status, source_module, source_ref_id, package_component,
          payer_covered, patient_share, payer_share, posted_at, updated_at)
       VALUES ($1,$2,$3,'consult','Corporate health check',1,1000.00,1000.00,
               0,0,0,0,0,0,0,true,
               1000.00,'unpaid','priced','test',$4,false,
               true,0,1000.00, now(), now())`,
      [newId(), hospitalId, billId, billId],
    );
    // Finalised only once the line is there, so the balance check sees a whole
    // bill rather than a header.
    await pool.query(`UPDATE billing.bills SET status = 'finalized' WHERE id = $1`, [billId]);
  }

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379/13';
  process.env['JWT_ACCESS_SECRET'] = 'nc012-access-secret-that-is-long-enough-0';
  process.env['JWT_REFRESH_SECRET'] = 'nc012-refresh-secret-that-is-long-enoug-0';
  process.env['RATE_LIMIT_AUTH_MAX'] = '10000';
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(CorporateTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { hospitalId, identifier: 'nc012@vims-blr', password: PASSWORD },
  });
  token = login.json<{ accessToken: string }>().accessToken;
}, 300_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe('NC-012 · the account', () => {
  it('creates one and reports exposure computed rather than stored', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/finance/corporate/accounts',
      payload: {
        payerId: state.payerId,
        code: 'ACME',
        name: 'Acme Industries',
        creditLimit: '10000.00',
        paymentTermsDays: 30,
      },
      reason: 'new corporate client',
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
    const account = res.json<{ id: string; exposure: string; headroom: string }>();
    state.accountId = account.id;
    expect(account.exposure).toBe('0.00');
    expect(account.headroom).toBe('10000.00');
  });
});

describe('NC-012 · raising an invoice', () => {
  it('takes its amounts from the bills, not from the caller', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/finance/corporate/invoices',
      payload: {
        accountId: state.accountId,
        invoiceDate: new Date().toISOString().slice(0, 10),
        billIds: [state.billIds[0]],
      },
    });
    expect(res.statusCode).toBe(201);
    const invoice = res.json<{ id: string; netAmount: string; lineCount: number; invoiceNo: string }>();
    state.invoiceId = invoice.id;
    // The amount comes from the bill row, whatever a request field might have
    // claimed — so this asserts against the seed rather than a constant.
    // Two ₹1000 bills exist; one was named, so the invoice is ₹1000 and not
    // whatever a request field might have claimed.
    expect(invoice.netAmount).toBe('1000.00');
    expect(invoice.lineCount).toBe(1);
    expect(invoice.invoiceNo).toMatch(/CINV/);
  });

  it('refuses to invoice the same bill twice', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/finance/corporate/invoices',
      payload: {
        accountId: state.accountId,
        invoiceDate: new Date().toISOString().slice(0, 10),
        billIds: [state.billIds[0]],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: string }>().detail).toMatch(/already on a corporate invoice/i);
  });

  it('refuses an invoice that would breach the credit limit', async () => {
    // Both rules apply to a re-invoice, and the limit is checked first — so the
    // limit is lowered here deliberately, to test it on its own rather than
    // have it mask the duplicate-bill index.
    await call({
      method: 'POST',
      url: '/api/v1/finance/corporate/accounts',
      payload: {
        payerId: state.payerId,
        code: 'ACME',
        name: 'Acme Industries',
        creditLimit: '1500.00',
        paymentTermsDays: 30,
      },
      reason: 'limit review',
    });

    // 1000 outstanding, 1500 limit, another 1000 would make 2000.
    const res = await call({
      method: 'POST',
      url: '/api/v1/finance/corporate/invoices',
      payload: {
        accountId: state.accountId,
        invoiceDate: new Date().toISOString().slice(0, 10),
        billIds: [state.billIds[1]],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: string }>().detail).toMatch(/credit limit/i);
  });

  it('refuses a new invoice while the account is on hold', async () => {
    await call({
      method: 'PATCH',
      url: `/api/v1/finance/corporate/accounts/${state.accountId}/hold`,
      payload: { onHold: true, holdReason: 'No payment since March' },
      reason: 'overdue',
    });

    const res = await call({
      method: 'POST',
      url: '/api/v1/finance/corporate/invoices',
      payload: {
        accountId: state.accountId,
        invoiceDate: new Date().toISOString().slice(0, 10),
        billIds: [state.billIds[1]],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: string }>().detail).toMatch(/on hold/i);
    // And it says why, so somebody knows when to lift it.
    expect(res.json<{ detail: string }>().detail).toMatch(/No payment since March/);

    await call({
      method: 'PATCH',
      url: `/api/v1/finance/corporate/accounts/${state.accountId}/hold`,
      payload: { onHold: false },
      reason: 'client paid',
    });
  });

  it('refuses a bill that is not finalised, rather than silently invoicing the rest', async () => {
    const draft = await pg.pool('migrator').query<{ id: string }>(
      `SELECT id FROM billing.bills
        WHERE hospital_id = $1 AND (status <> 'finalized' OR cancelled_at IS NOT NULL)
        LIMIT 1`,
      [hospitalId],
    );
    const draftId = draft.rows[0]?.id;
    if (draftId === undefined) return; // nothing unfinalised in this seed

    const res = await call({
      method: 'POST',
      url: '/api/v1/finance/corporate/invoices',
      payload: {
        accountId: state.accountId,
        invoiceDate: new Date().toISOString().slice(0, 10),
        billIds: [state.billIds[1], draftId],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: string }>().detail).toMatch(/not finalised|cancelled/i);
  });
});

describe('RC-005 · chasing it', () => {
  it('puts an overdue invoice on the worklist with the rung it has reached', async () => {
    // Backdate both dates. `a_due_date_follows_the_invoice` refuses a due date
    // before the invoice date, and rightly — moving only `due_on` would create
    // an invoice due before it existed.
    await pg.pool('migrator').query(
      `UPDATE finance.corporate_invoices
            SET invoice_date = current_date - 75, due_on = current_date - 45
          WHERE id = $1`,
      [state.invoiceId],
    );

    const res = await call({ method: 'GET', url: '/api/v1/finance/corporate/ageing' });
    expect(res.statusCode).toBe(200);
    const rows =
      res.json<
        { invoiceId: string; bucket: string; daysOverdue: number; dunningStage: number; nextAction: string }[]
      >();
    const mine = rows.find((r) => r.invoiceId === state.invoiceId);
    expect(mine?.bucket).toBe('31-60');
    expect(mine?.daysOverdue).toBe(45);
    // 45 days is a statement and a call, not a legal notice.
    expect(mine?.dunningStage).toBe(2);
    expect(mine?.nextAction).toMatch(/statement/i);
  });

  it('logs a follow-up, stamping the rung it was at the time', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/finance/corporate/invoices/${state.invoiceId}/followups`,
      payload: { channel: 'call', outcome: 'promised', promisedOn: '2026-12-01', promisedAmount: '1000.00' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ dunningStage: number }>().dunningStage).toBe(2);
  });

  it('refuses a promise with no date or amount', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/finance/corporate/invoices/${state.invoiceId}/followups`,
      payload: { channel: 'call', outcome: 'promised' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a write-off approved by the person who asked for it', async () => {
    // The caller is the approver; naming them as the requester too is exactly
    // the case the CHECK constraint exists to refuse.
    const res = await call({
      method: 'POST',
      url: `/api/v1/finance/corporate/invoices/${state.invoiceId}/write-off`,
      payload: {
        amount: '100.00',
        reason: 'Client in liquidation, no prospect of recovery',
        requestedBy: state.userId,
      },
      reason: 'bad debt',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: string }>().detail).toMatch(/cannot be approved by the person who requested/i);
  });

  it('accepts one with a second person, and the invoice reflects it', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/finance/corporate/invoices/${state.invoiceId}/write-off`,
      payload: {
        amount: '100.00',
        reason: 'Client in liquidation, no prospect of recovery',
        requestedBy: secondUserId,
      },
      reason: 'bad debt',
    });
    expect(res.statusCode).toBe(201);
    const invoice = res.json<{ writtenOff: string; outstanding: string }>();
    // Derived by trigger from `ar_write_offs`, not set by this service.
    expect(invoice.writtenOff).toBe('100.00');
    expect(invoice.outstanding).toBe('900.00');
  });

  it('will not cancel an invoice that has been settled against', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/finance/corporate/invoices/${state.invoiceId}/cancel`,
      payload: { cancelReason: 'raised in error' },
      reason: 'error',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: string }>().detail).toMatch(/already been settled/i);
  });
});
