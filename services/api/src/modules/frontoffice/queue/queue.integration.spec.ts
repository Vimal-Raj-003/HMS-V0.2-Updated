import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, SETTING_DEFINITIONS, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import { QueueModule } from './queue.module.js';

/**
 * EN-006 against a real PostgreSQL 17.
 *
 * The properties here cannot be checked by reading the code:
 *
 *  1. **One active token per patient per queue per day**, under genuine
 *     concurrency. The rule cannot be a unique index (a unique index on a
 *     partitioned table may not be partial), so the only proof that the issuer's
 *     lock actually holds is to fire simultaneous requests at it.
 *  2. **Call-next never double-calls.** Two consoles pressing F9 at the same
 *     instant must take two different tokens — `FOR UPDATE SKIP LOCKED` or a
 *     patient is called into two rooms (EN-006 AC2).
 *  3. **A cross-tenant id is 404, not 403.** No query in this module carries a
 *     `hospital_id` predicate, so if isolation holds it is row-level security
 *     doing it.
 *  4. **Every state change leaves one audit row and its registered outbox
 *     event**, written inside the transaction that made the change.
 */

@Module({ imports: [AppModule, QueueModule] })
class QueueTestApp {}

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

const receptionA: Actor = { userId: newId(), roleId: newId(), username: 'queue-reception-a', token: '' };
const readerA: Actor = { userId: newId(), roleId: newId(), username: 'queue-reader-a', token: '' };
const receptionB: Actor = { userId: newId(), roleId: newId(), username: 'queue-reception-b', token: '' };

const QUEUE_KEYS = PERMISSION_CATALOGUE.filter((p) => p.key.startsWith('queue.')).map((p) => p.key);
const READ_ONLY_KEYS = ['queue.token.read'];

const queueA = newId();
const queueA2 = newId();
const queueB = newId();

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
     VALUES ($1, $2, $3, $4, 'Integration test role', 'front_office', 'operational', now())`,
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

async function seedQueue(
  id: string,
  hospitalId: string,
  branchId: string,
  code: string,
  prefix: string,
): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO queue.queue_definitions
       (id, hospital_id, branch_id, code, name, kind, stage_key, series_prefix, series_scope,
        number_width, avg_service_sec_seed, skip_policy, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'doctor'::queue."QueueKind", 'doctor', $6,
             'per_queue'::queue."QueueSeriesScope", 3, 600, '{"max_skips": 2}'::jsonb, now())`,
    [id, hospitalId, branchId, code, `Queue ${code}`, prefix],
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
  readonly payload?: Record<string, unknown>;
}

async function call(options: CallOptions) {
  const headers: Record<string, string> = { authorization: `Bearer ${options.token}` };
  if (options.reason !== undefined) headers['x-reason'] = options.reason;
  return app.inject({
    method: options.method,
    url: options.url,
    headers,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

async function auditRowsForTrace(traceId: unknown): Promise<Array<Record<string, unknown>>> {
  const result = await pg.pool('migrator').query(
    `SELECT id, actor_user_id, entity, action::text AS action, row_id, business_key, reason_text
         FROM core.audit_log WHERE trace_id = $1`,
    [String(traceId)],
  );
  return result.rows as Array<Record<string, unknown>>;
}

async function outboxRowsForTrace(traceId: unknown): Promise<Array<Record<string, unknown>>> {
  const result = await pg.pool('migrator').query(
    `SELECT id, event_type, aggregate, aggregate_id, payload FROM core.outbox_events
        WHERE trace_id = $1 ORDER BY event_type`,
    [String(traceId)],
  );
  return result.rows as Array<Record<string, unknown>>;
}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'QUE' });
  await syncCatalogues();

  await seedActor(tenants.hospitalA, tenants.branchA, receptionA, QUEUE_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, readerA, READ_ONLY_KEYS);
  await seedActor(tenants.hospitalB, tenants.branchB, receptionB, QUEUE_KEYS);

  await seedQueue(queueA, tenants.hospitalA, tenants.branchA, 'OPD-1', 'A');
  await seedQueue(queueA2, tenants.hospitalA, tenants.branchA, 'OPD-2', 'B');
  await seedQueue(queueB, tenants.hospitalB, tenants.branchB, 'OPD-1', 'A');

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['DATABASE_POOL_MAX'] = '10';
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(QueueTestApp, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  receptionA.token = await login(tenants.hospitalA, receptionA.username);
  readerA.token = await login(tenants.hospitalA, readerA.username);
  receptionB.token = await login(tenants.hospitalB, receptionB.username);
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe('token issue', () => {
  it('issues a numbered token and records exactly one audit row and one outbox event', async () => {
    const patientId = newId();
    const res = await call({
      method: 'POST',
      url: '/api/v1/queue/tokens',
      token: receptionA.token,
      payload: { queueId: queueA, patientId },
    });

    expect(res.statusCode).toBe(201);
    const token = res.json<{ id: string; token_display: string; status: string; token_no: number }>();
    expect(token.token_display).toMatch(/^A-\d{3}$/);
    expect(token.status).toBe('waiting');

    const audit = await auditRowsForTrace(res.headers['x-trace-id']);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      entity: 'queue.queue_tokens',
      action: 'insert',
      row_id: token.id,
      actor_user_id: receptionA.userId,
    });

    const events = await outboxRowsForTrace(res.headers['x-trace-id']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: 'queue.token.issued', aggregate_id: token.id });
  });

  it('numbers tokens consecutively within the day', async () => {
    const first = await call({
      method: 'POST',
      url: '/api/v1/queue/tokens',
      token: receptionA.token,
      payload: { queueId: queueA2, patientId: newId() },
    });
    const second = await call({
      method: 'POST',
      url: '/api/v1/queue/tokens',
      token: receptionA.token,
      payload: { queueId: queueA2, patientId: newId() },
    });
    expect(second.json<{ token_no: number }>().token_no).toBe(
      first.json<{ token_no: number }>().token_no + 1,
    );
  });

  it('refuses a role that does not hold queue.token.issue', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/queue/tokens',
      token: readerA.token,
      payload: { queueId: queueA, patientId: newId() },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('returns 404 — not 403 — for another hospital’s queue, and the same 404 for one that does not exist', async () => {
    const foreign = await call({
      method: 'POST',
      url: '/api/v1/queue/tokens',
      token: receptionA.token,
      payload: { queueId: queueB, patientId: newId() },
    });
    const ghost = await call({
      method: 'POST',
      url: '/api/v1/queue/tokens',
      token: receptionA.token,
      payload: { queueId: newId(), patientId: newId() },
    });

    expect(foreign.statusCode).toBe(404);
    expect(ghost.statusCode).toBe(404);
    expect(foreign.json<{ detail: string }>().detail).toBe(ghost.json<{ detail: string }>().detail);
  });

  /**
   * The property the whole issuer design exists for.
   *
   * Remove the duplicate check (or move it outside the series lock) and this
   * test fails with several tokens for one patient — which in the hospital is a
   * patient called twice and a doctor's queue that does not add up.
   */
  it('issues exactly one token when eight requests for the same patient arrive at once', async () => {
    const patientId = newId();
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        call({
          method: 'POST',
          url: '/api/v1/queue/tokens',
          token: receptionA.token,
          payload: { queueId: queueA, patientId },
        }),
      ),
    );

    const created = attempts.filter((r) => r.statusCode === 201);
    const refused = attempts.filter((r) => r.statusCode === 409);
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(7);

    const rows = await pg
      .pool('migrator')
      .query(`SELECT id FROM queue.queue_tokens WHERE patient_id = $1`, [patientId]);
    expect(rows.rows).toHaveLength(1);
  });
});

describe('calling', () => {
  it('never calls the same token on two consoles at once', async () => {
    const queueId = newId();
    await seedQueue(queueId, tenants.hospitalA, tenants.branchA, `OPD-${queueId.slice(-6)}`, 'C');
    await call({
      method: 'POST',
      url: '/api/v1/queue/tokens',
      token: receptionA.token,
      payload: { queueId, patientId: newId() },
    });
    await call({
      method: 'POST',
      url: '/api/v1/queue/tokens',
      token: receptionA.token,
      payload: { queueId, patientId: newId() },
    });

    const [first, second] = await Promise.all([
      call({
        method: 'POST',
        url: `/api/v1/queue/queues/${queueId}/call-next`,
        token: receptionA.token,
        payload: {},
      }),
      call({
        method: 'POST',
        url: `/api/v1/queue/queues/${queueId}/call-next`,
        token: receptionA.token,
        payload: {},
      }),
    ]);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json<{ id: string }>().id).not.toBe(second.json<{ id: string }>().id);
  });

  it('calls in priority order, and an emergency token goes first', async () => {
    const queueId = newId();
    await seedQueue(queueId, tenants.hospitalA, tenants.branchA, `OPD-${queueId.slice(-6)}`, 'D');
    await call({
      method: 'POST',
      url: '/api/v1/queue/tokens',
      token: receptionA.token,
      payload: { queueId, patientId: newId() },
    });
    const emergency = await call({
      method: 'POST',
      url: '/api/v1/queue/tokens',
      token: receptionA.token,
      payload: { queueId, patientId: newId(), class: 'priority_emergency' },
    });

    const called = await call({
      method: 'POST',
      url: `/api/v1/queue/queues/${queueId}/call-next`,
      token: receptionA.token,
      payload: {},
    });
    expect(called.json<{ id: string }>().id).toBe(emergency.json<{ id: string }>().id);
  });

  it('refuses a skip with no reason, and records the reason when one is given', async () => {
    const issued = await call({
      method: 'POST',
      url: '/api/v1/queue/tokens',
      token: receptionA.token,
      payload: { queueId: queueA2, patientId: newId() },
    });
    const tokenId = issued.json<{ id: string }>().id;

    const silent = await call({
      method: 'POST',
      url: `/api/v1/queue/tokens/${tokenId}/skip`,
      token: receptionA.token,
      payload: {},
    });
    expect(silent.statusCode).toBe(400);

    const skipped = await call({
      method: 'POST',
      url: `/api/v1/queue/tokens/${tokenId}/skip`,
      token: receptionA.token,
      payload: { reason: 'no response at the door' },
    });
    expect(skipped.statusCode).toBe(201);
    expect(skipped.json<{ status: string }>().status).toBe('skipped');

    const events = await pg.pool('migrator').query(
      `SELECT event::text AS event, reason, actor_id FROM queue.queue_events
          WHERE token_id = $1 AND event = 'skipped'`,
      [tokenId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({
      reason: 'no response at the door',
      actor_id: receptionA.userId,
    });

    const outbox = await outboxRowsForTrace(skipped.headers['x-trace-id']);
    expect(outbox.map((e) => e['event_type'])).toEqual(['queue.token.skipped']);
  });

  it('marks a token no-show once the skip limit is reached', async () => {
    const issued = await call({
      method: 'POST',
      url: '/api/v1/queue/tokens',
      token: receptionA.token,
      payload: { queueId: queueA2, patientId: newId() },
    });
    const tokenId = issued.json<{ id: string }>().id;

    // `skip_policy.max_skips` is 2 on this queue, so the first skip returns the
    // token to the queue and the second retires it as a no-show (EN-006 §5).
    const first = await call({
      method: 'POST',
      url: `/api/v1/queue/tokens/${tokenId}/skip`,
      token: receptionA.token,
      payload: { reason: 'absent' },
    });
    expect(first.json<{ status: string }>().status).toBe('skipped');

    await pg
      .pool('migrator')
      .query(`UPDATE queue.queue_tokens SET status = 'waiting'::queue."QueueTokenStatus" WHERE id = $1`, [
        tokenId,
      ]);

    const second = await call({
      method: 'POST',
      url: `/api/v1/queue/tokens/${tokenId}/skip`,
      token: receptionA.token,
      payload: { reason: 'absent again' },
    });
    expect(second.json<{ status: string }>().status).toBe('no_show');
  });

  it('completes a token and publishes queue.token.completed with the wait', async () => {
    const issued = await call({
      method: 'POST',
      url: '/api/v1/queue/tokens',
      token: receptionA.token,
      payload: { queueId: queueA2, patientId: newId() },
    });
    const tokenId = issued.json<{ id: string }>().id;

    // A waiting token has not been called, so there is nothing to complete.
    const done = await call({
      method: 'POST',
      url: `/api/v1/queue/tokens/${tokenId}/complete`,
      token: receptionA.token,
      payload: {},
    });
    expect(done.statusCode).toBe(409);

    const called = await pg.pool('migrator').query(
      `UPDATE queue.queue_tokens SET status = 'called'::queue."QueueTokenStatus", called_at = now()
          WHERE id = $1 RETURNING id`,
      [tokenId],
    );
    expect(called.rows).toHaveLength(1);

    const completed = await call({
      method: 'POST',
      url: `/api/v1/queue/tokens/${tokenId}/complete`,
      token: receptionA.token,
      payload: {},
    });
    expect(completed.statusCode).toBe(201);
    expect(completed.json<{ status: string }>().status).toBe('served');

    const outbox = await outboxRowsForTrace(completed.headers['x-trace-id']);
    expect(outbox.map((e) => e['event_type'])).toEqual(['queue.token.completed']);
  });
});

describe('transfer', () => {
  it('needs a reason header, then moves the patient and announces both facts', async () => {
    const issued = await call({
      method: 'POST',
      url: '/api/v1/queue/tokens',
      token: receptionA.token,
      payload: { queueId: queueA, patientId: newId() },
    });
    const tokenId = issued.json<{ id: string }>().id;

    const noReason = await call({
      method: 'POST',
      url: `/api/v1/queue/tokens/${tokenId}/transfer`,
      token: receptionA.token,
      payload: { toQueueId: queueA2, reason: 'doctor called to theatre' },
    });
    expect(noReason.statusCode).toBe(403);

    const moved = await call({
      method: 'POST',
      url: `/api/v1/queue/tokens/${tokenId}/transfer`,
      token: receptionA.token,
      reason: 'doctor called to theatre',
      payload: { toQueueId: queueA2, reason: 'doctor called to theatre' },
    });
    expect(moved.statusCode).toBe(201);
    expect(moved.json<{ queue_id: string }>().queue_id).toBe(queueA2);

    const outbox = await outboxRowsForTrace(moved.headers['x-trace-id']);
    expect(outbox.map((e) => e['event_type'])).toEqual(['queue.token.issued', 'queue.token.transferred']);

    const source = await pg
      .pool('migrator')
      .query(`SELECT status::text AS status FROM queue.queue_tokens WHERE id = $1`, [tokenId]);
    expect(source.rows[0]).toMatchObject({ status: 'transferred' });
  });
});

describe('board', () => {
  it('shows tokens and counts and no patient identifier at all', async () => {
    const queueId = newId();
    await seedQueue(queueId, tenants.hospitalA, tenants.branchA, `OPD-${queueId.slice(-6)}`, 'E');
    const patientId = newId();
    await call({
      method: 'POST',
      url: '/api/v1/queue/tokens',
      token: receptionA.token,
      payload: { queueId, patientId },
    });

    const res = await call({
      method: 'GET',
      url: `/api/v1/queue/queues/${queueId}/live`,
      token: receptionA.token,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(patientId);
    const board = res.json<{ next: Array<{ tokenDisplay: string }>; waiting: number }>();
    expect(board.waiting).toBe(1);
    expect(board.next[0]?.tokenDisplay).toMatch(/^E-\d{3}$/);
  });

  it('does not show another hospital’s board', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/queue/queues/${queueB}/live`,
      token: receptionA.token,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('list', () => {
  it('never returns another hospital’s tokens', async () => {
    await call({
      method: 'POST',
      url: '/api/v1/queue/tokens',
      token: receptionB.token,
      payload: { queueId: queueB, patientId: newId() },
    });

    const mine = await call({
      method: 'GET',
      url: '/api/v1/queue/tokens?limit=100',
      token: receptionA.token,
    });
    const theirs = await call({
      method: 'GET',
      url: '/api/v1/queue/tokens?limit=100',
      token: receptionB.token,
    });

    const idsA = mine.json<{ items: Array<{ queue_id: string }> }>().items.map((t) => t.queue_id);
    const idsB = theirs.json<{ items: Array<{ queue_id: string }> }>().items.map((t) => t.queue_id);
    expect(idsA).not.toContain(queueB);
    expect(idsB).toEqual([queueB]);
  });
});
