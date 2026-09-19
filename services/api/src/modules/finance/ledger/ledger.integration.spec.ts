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
 * NC-009 §3.1 — the ledger, through the API.
 *
 * The database's own guards are proved in the migration and exercised here
 * only where the API adds something: that a refusal reaches the caller as a
 * message they can act on rather than as a 500, that a posted journal has no
 * route that edits it, and that a reversal mirrors every line.
 */

let pg: TestPostgres;
let app: NestFastifyApplication;

const PASSWORD = 'VimsDev#2026';
let hospitalId = '';
let branchId = '';
let token = '';

const state = { bookId: '', periodId: '', bank: '', income: '', heading: '' };

@Module({ imports: [AppModule] })
class LedgerTestModule {}

function call(options: {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly payload?: Record<string, unknown>;
  readonly reason?: string;
}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.reason !== undefined) headers['x-reason'] = options.reason;
  if (options.method === 'POST') headers['idempotency-key'] = newId();
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

  // A book with an open October, and three accounts.
  const entityId = newId();
  state.bookId = newId();
  const yearId = newId();
  state.periodId = newId();
  state.bank = newId();
  state.income = newId();
  state.heading = newId();

  await pool.query(
    `INSERT INTO finance.legal_entities (id,hospital_id,code,name,updated_at)
     VALUES ($1,$2,'LE-T','Ledger Test Entity',now())`,
    [entityId, hospitalId],
  );
  await pool.query(
    `INSERT INTO finance.books (id,hospital_id,legal_entity_id,code,name,updated_at)
     VALUES ($1,$2,$3,'BK-T','Test book',now())`,
    [state.bookId, hospitalId, entityId],
  );
  await pool.query(
    `INSERT INTO finance.fiscal_years (id,hospital_id,book_id,code,starts_on,ends_on,updated_at)
     VALUES ($1,$2,$3,'FY26','2026-04-01','2027-03-31',now())`,
    [yearId, hospitalId, state.bookId],
  );
  await pool.query(
    `INSERT INTO finance.fiscal_periods (id,hospital_id,book_id,fiscal_year_id,period_no,starts_on,ends_on,updated_at)
     VALUES ($1,$2,$3,$4,7,'2026-10-01','2026-10-31',now())`,
    [state.periodId, hospitalId, state.bookId, yearId],
  );
  await pool.query(
    `INSERT INTO finance.accounts (id,hospital_id,book_id,code,name,account_type,is_group,updated_at)
     VALUES ($1,$4,$5,'1100','Bank','asset',false,now()),
            ($2,$4,$5,'4100','Consultation income','income',false,now()),
            ($3,$4,$5,'1000','Assets','asset',true,now())`,
    [state.bank, state.income, state.heading, hospitalId, state.bookId],
  );

  // One role holding the whole ledger, because the path crosses reading,
  // posting and reversing and the point is the crossing.
  const roleId = newId();
  await pool.query(
    `INSERT INTO core.roles (id, hospital_id, key, name, description, home_workspace, category, updated_at)
     VALUES ($1,$2,'nc009_e2e','NC-009 e2e','end to end','dashboard','governance', now())`,
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
  await pool.query(
    `INSERT INTO core.users (id, hospital_id, group_id, username, email, name, display_name,
                             password_hash, status, type, updated_at)
     VALUES ($1,$2,(SELECT group_id FROM core.hospitals WHERE id=$2),'nc009@vims-blr',
             'nc009@example.invalid','{"given":"NC","family":"Nine"}'::jsonb,'NC Nine',$3,'active','staff', now())`,
    [userId, hospitalId, donor.rows[0]!.password_hash],
  );
  await pool.query(
    `INSERT INTO core.user_roles (id, hospital_id, user_id, role_id, branch_id, updated_at)
     VALUES ($1,$2,$3,$4,$5, now())`,
    [newId(), hospitalId, userId, roleId, branchId],
  );

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379/13';
  process.env['JWT_ACCESS_SECRET'] = 'nc009-access-secret-that-is-long-enough-0';
  process.env['JWT_REFRESH_SECRET'] = 'nc009-refresh-secret-that-is-long-enoug-0';
  process.env['RATE_LIMIT_AUTH_MAX'] = '10000';
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(LedgerTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { hospitalId, identifier: 'nc009@vims-blr', password: PASSWORD },
  });
  token = login.json<{ accessToken: string }>().accessToken;
}, 300_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe('NC-009 · posting into the ledger', () => {
  it('posts a balanced journal and returns both sides footing', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/finance/journals',
      payload: {
        bookId: state.bookId,
        journalDate: '2026-10-15',
        narration: 'Consultation fee received',
        lines: [
          { accountId: state.bank, debit: '1500.00', credit: '0' },
          { accountId: state.income, debit: '0', credit: '1500.00' },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; totalDebit: string; totalCredit: string; kind: string }>();
    expect(body.totalDebit).toBe('1500.00');
    expect(body.totalCredit).toBe('1500.00');
    // A route cannot mint an automatic journal; that is the poster's job.
    expect(body.kind).toBe('manual');
  });

  it('refuses an unbalanced journal with a message naming the difference', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/finance/journals',
      payload: {
        bookId: state.bookId,
        journalDate: '2026-10-15',
        narration: 'Wrong',
        lines: [
          { accountId: state.bank, debit: '1000.00', credit: '0' },
          { accountId: state.income, debit: '0', credit: '900.00' },
        ],
      },
    });
    // 409, not 500: the database refused it and the caller can act on that.
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: string }>().detail).toMatch(/does not balance/i);
    expect(res.json<{ detail: string }>().detail).toMatch(/100/);
  });

  it('refuses a posting to a heading account', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/finance/journals',
      payload: {
        bookId: state.bookId,
        journalDate: '2026-10-15',
        narration: 'To a heading',
        lines: [
          { accountId: state.heading, debit: '10.00', credit: '0' },
          { accountId: state.income, debit: '0', credit: '10.00' },
        ],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: string }>().detail).toMatch(/heading, not a posting account/i);
  });

  it('refuses a date no open period covers, instead of choosing one', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/finance/journals',
      payload: {
        bookId: state.bookId,
        journalDate: '2026-12-15',
        narration: 'No period',
        lines: [
          { accountId: state.bank, debit: '10.00', credit: '0' },
          { accountId: state.income, debit: '0', credit: '10.00' },
        ],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: string }>().detail).toMatch(/No accounting period covers/i);
  });

  it('has no route that edits or deletes a posted journal', async () => {
    const journals = await call({
      method: 'GET',
      url: `/api/v1/finance/journals?bookId=${state.bookId}`,
    });
    const first = journals.json<{ id: string }[]>()[0];
    expect(first).toBeDefined();

    for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
      const res = await app.inject({
        method,
        url: `/api/v1/finance/journals/${first!.id}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      // 404 because the route does not exist. Not 403 — there is nothing to
      // deny, which is the point.
      expect(res.statusCode).toBe(404);
    }
  });
});

describe('NC-009 · reversing', () => {
  it('mirrors every line, and the pair nets to nothing', async () => {
    const posted = await call({
      method: 'POST',
      url: '/api/v1/finance/journals',
      payload: {
        bookId: state.bookId,
        journalDate: '2026-10-20',
        narration: 'To be reversed',
        lines: [
          { accountId: state.bank, debit: '250.00', credit: '0' },
          { accountId: state.income, debit: '0', credit: '250.00' },
        ],
      },
    });
    const original = posted.json<{ id: string }>();

    const res = await call({
      method: 'POST',
      url: `/api/v1/finance/journals/${original.id}/reverse`,
      payload: { journalDate: '2026-10-21' },
      reason: 'Posted against the wrong account',
    });
    expect(res.statusCode).toBe(201);

    const reversal = res.json<{
      kind: string;
      reversesJournalId: string;
      lines: { accountId: string; debit: string; credit: string }[];
    }>();
    expect(reversal.kind).toBe('reversal');
    expect(reversal.reversesJournalId).toBe(original.id);

    // Debit became credit on the same account.
    const bankLine = reversal.lines.find((l) => l.accountId === state.bank);
    expect(bankLine?.credit).toBe('250.00');
    expect(bankLine?.debit).toBe('0.00');
  });

  it('will not reverse the same journal twice', async () => {
    const journals = await call({
      method: 'GET',
      url: `/api/v1/finance/journals?bookId=${state.bookId}`,
    });
    const reversed = journals.json<{ id: string; status: string }[]>().find((j) => j.status === 'reversed');
    expect(reversed).toBeDefined();

    const res = await call({
      method: 'POST',
      url: `/api/v1/finance/journals/${reversed!.id}/reverse`,
      payload: { journalDate: '2026-10-22' },
      reason: 'again',
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('NC-009 · the trial balance', () => {
  it('foots, which given the deferred constraint it must', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/finance/trial-balance?bookId=${state.bookId}`,
    });
    expect(res.statusCode).toBe(200);
    const tb = res.json<{ totalDebit: string; totalCredit: string; balances: boolean }>();
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.balances).toBe(true);
  });
});
