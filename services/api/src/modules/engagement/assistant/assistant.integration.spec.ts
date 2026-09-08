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
 * PE-009 — the public assistant, end to end.
 *
 * The four unauthenticated routes are the only business endpoints in the API a
 * stranger can reach, so this spec is mostly about what they refuse: no session,
 * no clinical data, no cross-tenant read, no consent-free write, and no
 * unmetered traffic. The happy path is one test; the boundary is the rest.
 */

let pg: TestPostgres;
let app: NestFastifyApplication;

const PASSWORD = 'VimsDev#2026';

let hospitalId = '';
let otherHospitalId = '';
let branchId = '';
let token = '';

@Module({ imports: [AppModule] })
class AssistantTestModule {}

/** Hands out a fresh caller address per request, deterministically. */
let callerSeq = 0;

/** No `authorization` header anywhere in here — that is the point of the suite. */
function anonymous(options: {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly payload?: Record<string, unknown>;
  /** Distinct callers, so one test's traffic does not rate-limit the next. */
  readonly ip?: string;
}) {
  return app.inject({
    method: options.method,
    url: options.url,
    // A counter, not `Math.random()`. Two tests colliding on an address would
    // fail one of them irreproducibly, which is the whole reason the lint rule
    // forbids a random source in a suite (docs/09 §2).
    headers: { 'x-forwarded-for': options.ip ?? `10.0.0.${String((callerSeq += 1))}` },
    ...(options.method === 'GET' ? {} : { payload: options.payload ?? {} }),
  });
}

function asStaff(options: {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly url: string;
  readonly payload?: Record<string, unknown>;
  readonly reason?: string;
}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.reason !== undefined) headers['x-reason'] = options.reason;
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
  otherHospitalId = (
    await pool.query<{ id: string }>(`SELECT id FROM core.hospitals WHERE code = 'VIMS-MYS'`)
  ).rows[0]!.id;
  branchId = (
    await pool.query<{ id: string }>(`SELECT id FROM core.branches WHERE hospital_id = $1 LIMIT 1`, [
      hospitalId,
    ])
  ).rows[0]!.id;

  const roleId = newId();
  await pool.query(
    `INSERT INTO core.roles (id, hospital_id, key, name, description, home_workspace, category, updated_at)
     VALUES ($1,$2,'pe009_e2e','PE-009 e2e','end to end','dashboard','governance', now())`,
    [roleId, hospitalId],
  );
  for (const p of PERMISSION_CATALOGUE) {
    await pool.query(
      `INSERT INTO core.role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [roleId, p.key],
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
     VALUES ($1,$2,(SELECT group_id FROM core.hospitals WHERE id=$2),'pe009@vims-blr',
             'pe009@example.invalid','{"given":"PE","family":"Eleven"}'::jsonb,'PE Eleven',$3,'active','staff', now())`,
    [userId, hospitalId, donor.rows[0]!.password_hash],
  );
  await pool.query(
    `INSERT INTO core.user_roles (id, hospital_id, user_id, role_id, branch_id, updated_at)
     VALUES ($1,$2,$3,$4,$5, now())`,
    [newId(), hospitalId, userId, roleId, branchId],
  );

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379/13';
  process.env['JWT_ACCESS_SECRET'] = 'pe009-access-secret-that-is-long-enough-0';
  process.env['JWT_REFRESH_SECRET'] = 'pe009-refresh-secret-that-is-long-enoug-0';
  process.env['RATE_LIMIT_AUTH_MAX'] = '10000';
  // Small budgets, which the limiter's own tests spend deliberately from two
  // fixed addresses. Every other test in this file calls from a random address,
  // so nothing here throttles anything else.
  process.env['ASSISTANT_RATE_CHAT_MAX'] = '8';
  process.env['ASSISTANT_RATE_REQUEST_MAX'] = '5';
  // Deliberately unset: the suite must prove the assistant works with no model
  // configured, because that is a supported deployment and the fallback for
  // every deployment where the vendor is down.
  delete process.env['ASSISTANT_LLM_BASE_URL'];
  delete process.env['ASSISTANT_LLM_API_KEY'];
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(
    AssistantTestModule,
    // `trustProxy` exactly as `main.ts` sets it. Without it Fastify reports the
    // socket address for every request, `x-forwarded-for` is ignored, and every
    // caller in this file shares one rate-limit bucket — which is also what
    // would happen in production behind Cloudflare or Nginx, so the flag is
    // part of the system under test rather than test scaffolding.
    new FastifyAdapter({ trustProxy: true }),
    { logger: false },
  );
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { hospitalId, identifier: 'pe009@vims-blr', password: PASSWORD },
  });
  token = login.json<{ accessToken: string }>().accessToken;
}, 300_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe('PE-009 · the directory a stranger may read', () => {
  it('answers without a session', async () => {
    const res = await anonymous({
      method: 'GET',
      url: `/api/v1/assistant/directory?hospitalId=${hospitalId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ hospitalName: string; specialities: unknown[] }>();
    expect(body.hospitalName).toContain('Vim');
    expect(body.specialities.length).toBeGreaterThan(0);
  });

  it('shows only what the hospital chose to publish', async () => {
    // The boundary is master data, not code: flipping the flag must remove the
    // department from the public answer with no deploy.
    const pool = pg.pool('migrator');
    const before = await anonymous({
      method: 'GET',
      url: `/api/v1/assistant/directory?hospitalId=${hospitalId}`,
    });
    const names = before.json<{ specialities: { name: string }[] }>().specialities.map((s) => s.name);
    const victim = names[0]!;

    await pool.query(
      `UPDATE mdm.mdm_specialities SET website_visible = false
        WHERE hospital_id = $1 AND name = $2`,
      [hospitalId, victim],
    );
    const after = await anonymous({
      method: 'GET',
      url: `/api/v1/assistant/directory?hospitalId=${hospitalId}`,
    });
    expect(after.json<{ specialities: { name: string }[] }>().specialities.map((s) => s.name)).not.toContain(
      victim,
    );

    await pool.query(
      `UPDATE mdm.mdm_specialities SET website_visible = true
        WHERE hospital_id = $1 AND name = $2`,
      [hospitalId, victim],
    );
  });

  it('does not leak one hospital into another', async () => {
    const a = await anonymous({
      method: 'GET',
      url: `/api/v1/assistant/directory?hospitalId=${hospitalId}`,
    });
    const b = await anonymous({
      method: 'GET',
      url: `/api/v1/assistant/directory?hospitalId=${otherHospitalId}`,
    });
    expect(a.json<{ hospitalName: string }>().hospitalName).not.toBe(
      b.json<{ hospitalName: string }>().hospitalName,
    );
  });

  it('refuses a hospital id that is not one', async () => {
    const res = await anonymous({ method: 'GET', url: '/api/v1/assistant/directory?hospitalId=nope' });
    expect(res.statusCode).toBe(400);
  });
});

describe('PE-009 · the chat turn', () => {
  it('answers from the directory when no model is configured', async () => {
    const res = await anonymous({
      method: 'POST',
      url: '/api/v1/assistant/chat',
      payload: { hospitalId, messages: [{ role: 'user', content: 'which departments do you have' }] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ source: string; reply: string; safety: string }>();
    expect(body.source).toBe('directory');
    expect(body.safety).toBe('none');
    expect(body.reply).toContain('Orthopaedics');
  });

  it('short-circuits an emergency without consulting anything', async () => {
    const res = await anonymous({
      method: 'POST',
      url: '/api/v1/assistant/chat',
      payload: { hospitalId, messages: [{ role: 'user', content: 'I have severe chest pain' }] },
    });
    const body = res.json<{ source: string; safety: string; reply: string; intent: unknown }>();
    expect(body.safety).toBe('emergency');
    // `source: 'safety'` is the assertion that matters: not the model, not the
    // directory, nothing that could have been talked round.
    expect(body.source).toBe('safety');
    expect(body.reply).toContain('112');
    // And it does not try to sell an appointment to somebody having a heart attack.
    expect(body.intent).toBeNull();
  });

  it('recognises a booking intent and names the department', async () => {
    const res = await anonymous({
      method: 'POST',
      url: '/api/v1/assistant/chat',
      payload: {
        hospitalId,
        messages: [{ role: 'user', content: 'I would like to book an appointment for Orthopaedics' }],
      },
    });
    const body = res.json<{ intent: { kind: string; specialityName?: string } | null }>();
    expect(body.intent?.kind).toBe('book_appointment');
    expect(body.intent?.specialityName).toBe('Orthopaedics');
  });

  it('refuses a transcript that does not end with the visitor', async () => {
    const res = await anonymous({
      method: 'POST',
      url: '/api/v1/assistant/chat',
      payload: { hospitalId, messages: [{ role: 'assistant', content: 'hello' }] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PE-009 · the enquiry', () => {
  it('refuses to exist without consent', async () => {
    const res = await anonymous({
      method: 'POST',
      url: '/api/v1/assistant/appointment-requests',
      payload: { hospitalId, name: 'No Consent', phone: '+919876543210', consent: false },
    });
    expect(res.statusCode).toBe(400);
    const errors = res.json<{ errors: { path: string }[] }>().errors;
    expect(errors.some((e) => e.path === 'consent')).toBe(true);
  });

  it('refuses a phone number nobody could dial', async () => {
    const res = await anonymous({
      method: 'POST',
      url: '/api/v1/assistant/appointment-requests',
      payload: { hospitalId, name: 'Bad Phone', phone: 'call me maybe', consent: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('captures a request, records consent and never claims a booking', async () => {
    const res = await anonymous({
      method: 'POST',
      url: '/api/v1/assistant/appointment-requests',
      payload: {
        hospitalId,
        name: 'Meera Iyer',
        phone: '+919876500011',
        preferredPeriod: 'morning',
        consent: true,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; status: string; message: string }>();
    expect(body.status).toBe('new');
    // The sentence that stops somebody not turning up to an appointment they
    // believe they have.
    expect(body.message).toContain('not a confirmed appointment');

    const row = await pg.pool('migrator').query<{
      consent_given: boolean;
      consent_text_version: string;
      requester_ip_hash: Buffer | null;
      status: string;
    }>(
      `SELECT consent_given, consent_text_version, requester_ip_hash, status
         FROM engage.appointment_requests WHERE id = $1`,
      [body.id],
    );
    expect(row.rows[0]?.consent_given).toBe(true);
    expect(row.rows[0]?.consent_text_version).toBe('pe009-v1');
    // Hashed, and there is no column that could have held the address itself.
    expect(row.rows[0]?.requester_ip_hash).not.toBeNull();

    const audit = await pg
      .pool('migrator')
      .query<{ action: string; data_class: string }>(
        `SELECT action, data_class FROM core.audit_log WHERE entity = 'appointment_request' AND row_id = $1`,
        [body.id],
      );
    expect(audit.rows[0]?.action).toBe('insert');
    expect(audit.rows[0]?.data_class).toBe('phi');

    const event = await pg.pool('migrator').query<{
      event_type: string;
      contains_phi: boolean;
      payload: Record<string, unknown>;
    }>(`SELECT event_type, contains_phi, payload FROM core.outbox_events WHERE aggregate_id = $1`, [body.id]);
    expect(event.rows[0]?.event_type).toBe('appointment.request.received');
    // The row carries the name and the number under RLS and audit. The event is
    // relayed to Redis, read by workers and kept for a year, so it carries
    // neither — and `contains_phi: false` is a claim about the payload that
    // this asserts rather than trusts.
    expect(event.rows[0]?.contains_phi).toBe(false);
    expect(JSON.stringify(event.rows[0]?.payload)).not.toContain('Meera');
    expect(JSON.stringify(event.rows[0]?.payload)).not.toContain('9876500011');
  });

  it('meters a caller', async () => {
    const ip = '203.0.113.77';
    const send = (name: string) =>
      anonymous({
        method: 'POST',
        url: '/api/v1/assistant/appointment-requests',
        ip,
        payload: { hospitalId, name, phone: '+919876500022', consent: true },
      });

    for (let i = 0; i < 5; i += 1) {
      expect((await send(`Flood ${String(i)}`)).statusCode).toBe(201);
    }
    expect((await send('Flood 6')).statusCode).toBe(429);
  });

  it('meters work the service refused as well as work it did', async () => {
    // The property the limiter exists for. Every one of these is turned away by
    // the red-flag screen before it reaches a model, and every one still costs
    // the caller a hit — because the counter commits in its own transaction
    // before the work, not alongside it. A limiter that counted inside the
    // request transaction would roll back with the request and leave a caller
    // sending failing traffic completely unmetered.
    //
    // Known boundary, stated rather than implied: a body that fails Zod is
    // rejected by the validation pipe *before* the service runs, so it is not
    // counted here. That path touches no database and no model, and the
    // edge tier (`RATE_LIMIT_API_PER_MINUTE`, docs/04 §6) is what covers it.
    const ip = '203.0.113.99';
    const ask = () =>
      anonymous({
        method: 'POST',
        url: '/api/v1/assistant/chat',
        ip,
        payload: { hospitalId, messages: [{ role: 'user', content: 'I have chest pain' }] },
      });

    for (let i = 0; i < 8; i += 1) {
      const res = await ask();
      expect(res.statusCode).toBe(201);
      expect(res.json<{ safety: string }>().safety).toBe('emergency');
    }
    expect((await ask()).statusCode).toBe(429);
  });
});

describe('PE-009 · what front office does with it', () => {
  let requestId = '';

  it('is on a worklist somebody can actually read', async () => {
    const created = await anonymous({
      method: 'POST',
      url: '/api/v1/assistant/appointment-requests',
      payload: { hospitalId, name: 'Worklist Test', phone: '+919876500033', consent: true },
    });
    requestId = created.json<{ id: string }>().id;

    const res = await asStaff({ method: 'GET', url: '/api/v1/appointment-requests?status=new' });
    expect(res.statusCode).toBe(200);
    const rows = res.json<{ id: string; requesterName: string }[]>();
    expect(rows.some((r) => r.id === requestId)).toBe(true);
  });

  it('needs a session to read', async () => {
    const res = await anonymous({ method: 'GET', url: '/api/v1/appointment-requests' });
    expect(res.statusCode).toBe(401);
  });

  it('will not let an enquiry be declined without saying why', async () => {
    const res = await asStaff({
      method: 'PATCH',
      url: `/api/v1/appointment-requests/${requestId}`,
      payload: { status: 'declined' },
      reason: 'test',
    });
    expect(res.statusCode).toBe(400);
  });

  it('records who handled it, without being told when', async () => {
    const res = await asStaff({
      method: 'PATCH',
      url: `/api/v1/appointment-requests/${requestId}`,
      payload: { status: 'contacted' },
      reason: 'called the patient',
    });
    expect(res.statusCode).toBe(200);
    // Derived by the trigger. "When was this dealt with" should not be a thing
    // somebody typed.
    expect(res.json<{ handledAt: string | null }>().handledAt).not.toBeNull();
  });

  it('refuses to link an appointment that does not exist', async () => {
    const res = await asStaff({
      method: 'POST',
      url: `/api/v1/appointment-requests/${requestId}/convert`,
      payload: { appointmentId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.statusCode).toBe(400);
  });
});
