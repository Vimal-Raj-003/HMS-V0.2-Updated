import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module.js';
import { fingerprintRequest } from './idempotency.fingerprint.js';

/**
 * `@Idempotent()` against a real PostgreSQL 17.
 *
 * Only one of these properties can be checked without a database, and it is the
 * least interesting one. The rest are all statements about what two connections
 * do to one row:
 *
 *  1. A route that declares the decorator **refuses a request with no key**.
 *  2. A repeat of the same key with the same body **replays the first response**
 *     and creates nothing — the receptionist who double-clicks gets one patient
 *     and the original 201, not a second UHID and not a confusing error.
 *  3. A repeat of the same key with a **different** body is refused with 409.
 *     Replaying here would answer a question the caller did not ask.
 *  4. **Two simultaneous requests with one key execute once.** This is the test
 *     that justifies the whole design: remove the interceptor and it fails,
 *     because both requests reach the handler.
 *  5. A **failed** attempt releases the key, so the same request may be retried.
 *  6. An **expired** key is a new key, and the purge is the retention role's.
 *  7. Two hospitals may use the same key string without meeting.
 */

/**
 * `AppModule` does not register the interceptor — that wiring is the caller's
 * change, deliberately left out of this diff. Composing it here is exactly what
 * that wiring will look like.
 */
/**
 * `AppModule` now registers the interceptor globally, so declaring
 * IDEMPOTENCY_PROVIDERS here as well would register it twice: the first pass
 * reserves the key and the second sees its own reservation as an in-flight
 * request, so every first request answers 409. Wiring it once is the thing
 * under test.
 */
@Module({ imports: [AppModule] })
class IdempotencyTestApp {}

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

const deskA: Actor = { userId: newId(), roleId: newId(), username: 'idem-desk-alpha', token: '' };
const deskB: Actor = { userId: newId(), roleId: newId(), username: 'idem-desk-bravo', token: '' };

const DESK_KEYS = [
  'patient.record.create',
  'patient.record.read',
  'patient.record.list',
  'patient.record.update',
];

async function syncPermissionCatalogue(): Promise<void> {
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
}

async function defineUhidSeries(hospitalId: string, branchId: string): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO core.numbering_series
       (id, hospital_id, branch_id, key, pattern, scope, fy, current_value, gapless,
        reset_policy, version, effective_from, active, created_at, updated_at)
     VALUES ($1, $2, $3, 'UHID', '{BR}{SEQ:8}', 'branch', NULL, 0, false,
             'never', 1, now() - interval '1 day', true, now(), now())`,
    [newId(), hospitalId, branchId],
  );
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
     VALUES ($1, $2, $3, $4, 'Idempotency test role', 'front_office', 'operational', now())`,
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

async function login(hospitalId: string, identifier: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { hospitalId, identifier, password: PASSWORD },
  });
  const body = res.json<{ accessToken?: string }>();
  if (typeof body.accessToken !== 'string') {
    throw new Error(`login failed for ${identifier}: ${String(res.statusCode)} ${res.body}`);
  }
  return body.accessToken;
}

interface CallOptions {
  readonly token: string;
  readonly payload: Record<string, unknown>;
  readonly idempotencyKey?: string;
  readonly url?: string;
}

function register(options: CallOptions) {
  const headers: Record<string, string> = { authorization: `Bearer ${options.token}` };
  if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;
  return app.inject({
    method: 'POST',
    url: options.url ?? '/api/v1/patients',
    headers,
    payload: options.payload,
  });
}

/**
 * A distinct person per slot.
 *
 * Distinct deliberately: OP-001's duplicate hard-stop scores 0.85 for a trigram
 * name match with the same gender and a DOB within a year, so a suite that
 * registered "Asha Rao, 1988-03-04" twenty times would be testing the dedupe
 * engine rather than idempotency. Names, surnames and years are all spread.
 */
const PEOPLE = [
  { firstName: 'Asha', lastName: 'Rao', gender: 'female' },
  { firstName: 'Bhaskar', lastName: 'Nair', gender: 'male' },
  { firstName: 'Chitra', lastName: 'Menon', gender: 'female' },
  { firstName: 'Devendra', lastName: 'Joshi', gender: 'male' },
  { firstName: 'Farida', lastName: 'Sheikh', gender: 'female' },
  { firstName: 'Gopal', lastName: 'Iyengar', gender: 'male' },
  { firstName: 'Hemalatha', lastName: 'Prabhu', gender: 'female' },
  { firstName: 'Irfan', lastName: 'Qureshi', gender: 'male' },
  { firstName: 'Jyothi', lastName: 'Bhandari', gender: 'female' },
  { firstName: 'Krishnan', lastName: 'Venkatesh', gender: 'male' },
  { firstName: 'Lavanya', lastName: 'Deshmukh', gender: 'female' },
  { firstName: 'Mahesh', lastName: 'Chowdhury', gender: 'male' },
  { firstName: 'Nandini', lastName: 'Fernandes', gender: 'female' },
  { firstName: 'Omprakash', lastName: 'Gaikwad', gender: 'male' },
  { firstName: 'Padmaja', lastName: 'Sundaram', gender: 'female' },
  { firstName: 'Rajashekar', lastName: 'Mukherjee', gender: 'male' },
  { firstName: 'Sushmita', lastName: 'Talwar', gender: 'female' },
  { firstName: 'Thirumalai', lastName: 'Bose', gender: 'male' },
  { firstName: 'Usha', lastName: 'Kulkarni', gender: 'female' },
  { firstName: 'Vikramaditya', lastName: 'Pillai', gender: 'male' },
] as const;

/** A minimal, valid registration for slot `n` (1-based). */
function registration(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const person = PEOPLE[(n - 1) % PEOPLE.length] ?? PEOPLE[0];
  return {
    firstName: person.firstName,
    lastName: person.lastName,
    gender: person.gender,
    // Three years apart, so no two slots fall inside the ±1-year DOB rule.
    dob: `${String(1955 + n * 3)}-03-04`,
    mobile: mobileFor(n),
    ...overrides,
  };
}

/** The mobile number slot `n` registers with. */
function mobileFor(n: number): string {
  return `98450${String(10000 + n)}`;
}

/**
 * How many patients this hospital holds for one mobile number.
 *
 * `mobile_local` and not `mobile`, because registration stores the E.164 form in
 * `mobile` (`+91…`) and the national significant number in `mobile_local` — the
 * digits the test actually sent.
 */
async function patientsWithMobile(hospitalId: string, mobile: string): Promise<number> {
  const result = await pg.pool('migrator').query<{ count: string }>(
    `SELECT count(*)::text AS count FROM patient.patients
      WHERE hospital_id = $1 AND mobile_local = $2`,
    [hospitalId, mobile],
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function keyRow(hospitalId: string, key: string) {
  const result = await pg.pool('migrator').query<{
    id: string;
    status: string;
    request_hash: string;
    response_status: number | null;
    route: string;
    method: string;
    user_id: string | null;
  }>(
    `SELECT id, status, request_hash, response_status, route, method, user_id
       FROM core.idempotency_keys WHERE hospital_id = $1 AND key = $2`,
    [hospitalId, key],
  );
  return result.rows[0];
}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'IDM' });
  await syncPermissionCatalogue();

  await defineUhidSeries(tenants.hospitalA, tenants.branchA);
  await defineUhidSeries(tenants.hospitalB, tenants.branchB);

  await seedActor(tenants.hospitalA, tenants.branchA, deskA, DESK_KEYS);
  await seedActor(tenants.hospitalB, tenants.branchB, deskB, DESK_KEYS);

  process.env['DATABASE_URL'] = pg.connectionString('app');
  // The concurrency test needs at least two connections at once; with one, the
  // second request would wait for a connection rather than for the row lock and
  // the suite would prove nothing.
  process.env['DATABASE_POOL_MAX'] = '10';
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(IdempotencyTestApp, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  deskA.token = await login(tenants.hospitalA, deskA.username);
  deskB.token = await login(tenants.hospitalB, deskB.username);
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a route that declares @Idempotent()', () => {
  it('refuses a request that carries no key', async () => {
    const res = await register({ token: deskA.token, payload: registration(1) });

    expect(res.statusCode, res.body).toBe(400);
    const problem = res.json<{ type: string; nextAction?: string }>();
    expect(problem.type).toContain('idempotency-key-missing');
    // The error has to tell the caller what to do, not merely that it failed.
    expect(problem.nextAction).toBeTruthy();
    expect(await patientsWithMobile(tenants.hospitalA, mobileFor(1))).toBe(0);
  });

  it('refuses a key too short to be unique per submission', async () => {
    const res = await register({ token: deskA.token, payload: registration(2), idempotencyKey: 'abc' });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ type: string }>().type).toContain('idempotency-key-missing');
  });

  it('accepts a keyed request and records the key against the acting user', async () => {
    const key = newId();
    const res = await register({ token: deskA.token, payload: registration(3), idempotencyKey: key });

    expect(res.statusCode, res.body).toBe(201);
    const row = await keyRow(tenants.hospitalA, key);
    expect(row?.status).toBe('completed');
    expect(row?.response_status).toBe(201);
    expect(row?.method).toBe('POST');
    // The route *pattern*, so the key is scoped to the operation.
    expect(row?.route).toBe('/api/v1/patients');
    expect(row?.user_id).toBe(deskA.userId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a repeat of the same key', () => {
  it('replays the first response verbatim and creates nothing', async () => {
    const key = newId();
    const payload = registration(4);

    const first = await register({ token: deskA.token, payload, idempotencyKey: key });
    expect(first.statusCode, first.body).toBe(201);
    const created = first.json<{ id: string; uhid: string }>();

    const second = await register({ token: deskA.token, payload, idempotencyKey: key });

    expect(second.statusCode, second.body).toBe(201);
    expect(second.json<{ id: string; uhid: string }>()).toMatchObject({
      id: created.id,
      uhid: created.uhid,
    });
    // The header is how a client tells "we created it" from "you already had it".
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(await patientsWithMobile(tenants.hospitalA, mobileFor(4))).toBe(1);
  });

  it('is insensitive to the order the client serialised the body in', async () => {
    const key = newId();
    const forward = registration(5);
    const reversed = Object.fromEntries(Object.entries(forward).reverse());

    const first = await register({ token: deskA.token, payload: forward, idempotencyKey: key });
    expect(first.statusCode, first.body).toBe(201);

    const second = await register({ token: deskA.token, payload: reversed, idempotencyKey: key });

    expect(second.statusCode, second.body).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(await patientsWithMobile(tenants.hospitalA, mobileFor(5))).toBe(1);
  });

  it('refuses a different body under the same key rather than answering the wrong question', async () => {
    const key = newId();
    const first = await register({ token: deskA.token, payload: registration(6), idempotencyKey: key });
    expect(first.statusCode, first.body).toBe(201);

    const second = await register({ token: deskA.token, payload: registration(7), idempotencyKey: key });

    expect(second.statusCode, second.body).toBe(409);
    expect(second.json<{ type: string }>().type).toContain('idempotency-key-reused');
    expect(second.headers['idempotent-replay']).toBeUndefined();
    // Nothing was created for the second body, and the first is untouched.
    expect(await patientsWithMobile(tenants.hospitalA, mobileFor(7))).toBe(0);
    expect(await patientsWithMobile(tenants.hospitalA, mobileFor(6))).toBe(1);
  });

  it('does not block two different keys carrying two different patients', async () => {
    const one = await register({ token: deskA.token, payload: registration(8), idempotencyKey: newId() });
    const two = await register({ token: deskA.token, payload: registration(9), idempotencyKey: newId() });

    expect(one.statusCode, one.body).toBe(201);
    expect(two.statusCode, two.body).toBe(201);
    expect(one.json<{ id: string }>().id).not.toBe(two.json<{ id: string }>().id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * The property the whole design exists for, and the one that cannot be checked
 * without two connections to one database.
 *
 * **Both tests here fail if the interceptor is removed**, and they fail in
 * different ways on purpose. The first is deterministic — it stages an attempt
 * that another pod is holding, so there is no timing to get lucky with — and
 * without the interceptor the request simply executes and a patient exists. The
 * second is the real race, and without the interceptor it produces two patients
 * for one submission, or one patient and a duplicate hard-stop, neither of which
 * satisfies "exactly one execution".
 */
describe('two simultaneous requests with one key', () => {
  it('refuses a request whose key is held by an attempt running elsewhere', async () => {
    const key = newId();
    const payload = registration(10);

    // Exactly what another pod would have written a moment earlier: the same
    // key, the same fingerprint, in flight and still inside its lock.
    await pg.pool('migrator').query(
      `INSERT INTO core.idempotency_keys
         (id, hospital_id, key, user_id, route, method, request_hash, status,
          locked_until, created_at, expires_at)
       VALUES ($1, $2, $3, $4, '/api/v1/patients', 'POST', $5, 'in_flight',
               now() + interval '1 minute', now(), now() + interval '1 day')`,
      [
        newId(),
        tenants.hospitalA,
        key,
        deskA.userId,
        fingerprintRequest({
          method: 'POST',
          route: '/api/v1/patients',
          params: {},
          query: {},
          body: payload,
        }),
      ],
    );

    const res = await register({ token: deskA.token, payload, idempotencyKey: key });

    expect(res.statusCode, res.body).toBe(409);
    expect(res.json<{ type: string }>().type).toContain('idempotency-key-reused');
    // The handler did not run. Without the interceptor this is 1.
    expect(await patientsWithMobile(tenants.hospitalA, mobileFor(10))).toBe(0);
  });

  it('lets the request through once the holder has forfeited its lock', async () => {
    const key = newId();
    const payload = registration(11);

    // The pod that held this key died: the lock lapsed and nothing was
    // committed, because every handler runs inside a transaction that rolls
    // back on any throw.
    await pg.pool('migrator').query(
      `INSERT INTO core.idempotency_keys
         (id, hospital_id, key, user_id, route, method, request_hash, status,
          locked_until, created_at, expires_at)
       VALUES ($1, $2, $3, $4, '/api/v1/patients', 'POST', $5, 'in_flight',
               now() - interval '1 minute', now() - interval '2 minutes', now() + interval '1 day')`,
      [
        newId(),
        tenants.hospitalA,
        key,
        deskA.userId,
        fingerprintRequest({
          method: 'POST',
          route: '/api/v1/patients',
          params: {},
          query: {},
          body: payload,
        }),
      ],
    );

    const res = await register({ token: deskA.token, payload, idempotencyKey: key });

    expect(res.statusCode, res.body).toBe(201);
    expect(await patientsWithMobile(tenants.hospitalA, mobileFor(11))).toBe(1);
  });

  it('executes one submission once, however five simultaneous retries interleave', async () => {
    const key = newId();
    const payload = registration(12);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => register({ token: deskA.token, payload, idempotencyKey: key })),
    );

    // Exactly one attempt reached the handler. The others were either refused
    // while it was running (409) or replayed after it finished (201 carrying the
    // replay header) — which of the two depends on scheduling and does not
    // matter, but "how many ran" does.
    const executed = results.filter(
      (r) => r.statusCode === 201 && r.headers['idempotent-replay'] === undefined,
    );
    const refused = results.filter((r) => r.statusCode === 409);
    const replayed = results.filter((r) => r.statusCode === 201 && r.headers['idempotent-replay'] === 'true');

    expect(executed.length, results.map((r) => `${String(r.statusCode)} ${r.body}`).join(' | ')).toBe(1);
    expect(refused.length + replayed.length).toBe(4);
    expect(await patientsWithMobile(tenants.hospitalA, mobileFor(12))).toBe(1);

    // Every refusal is the idempotency refusal, not something the handler threw.
    for (const r of refused) {
      expect(r.json<{ type: string }>().type).toContain('idempotency-key-reused');
    }

    // And a later retry is a replay of that one execution, not a sixth attempt.
    const retry = await register({ token: deskA.token, payload, idempotencyKey: key });
    expect(retry.statusCode, retry.body).toBe(201);
    expect(retry.headers['idempotent-replay']).toBe('true');
    expect(await patientsWithMobile(tenants.hospitalA, mobileFor(12))).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a failed attempt', () => {
  it('releases the key, so the same request may be retried', async () => {
    const key = newId();
    // No mobile and no age: refused by the shared Zod schema, inside the
    // interceptor, after the key was claimed.
    const invalid = { firstName: 'Asha', lastName: 'Rao', gender: 'female' };

    const first = await register({ token: deskA.token, payload: invalid, idempotencyKey: key });
    expect(first.statusCode, first.body).toBe(400);
    expect((await keyRow(tenants.hospitalA, key))?.status).toBe('failed');

    // The same request again is re-executed rather than replayed as a stored
    // error: a rolled-back attempt committed nothing, so retrying is safe.
    const second = await register({ token: deskA.token, payload: invalid, idempotencyKey: key });
    expect(second.statusCode, second.body).toBe(400);
    expect(second.headers['idempotent-replay']).toBeUndefined();
  });

  it('still refuses a corrected body under the key that already failed', async () => {
    const key = newId();
    const invalid = { firstName: 'Asha', lastName: 'Rao', gender: 'female' };

    const first = await register({ token: deskA.token, payload: invalid, idempotencyKey: key });
    expect(first.statusCode, first.body).toBe(400);

    // A corrected form is a different submission. It needs a new key — replaying
    // it or admitting it here is how one key comes to stand for two intents.
    const corrected = await register({
      token: deskA.token,
      payload: registration(13),
      idempotencyKey: key,
    });
    expect(corrected.statusCode, corrected.body).toBe(409);
    expect(await patientsWithMobile(tenants.hospitalA, mobileFor(13))).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('expiry', () => {
  it('treats a key past its TTL as a new key', async () => {
    const key = newId();
    const first = await register({ token: deskA.token, payload: registration(14), idempotencyKey: key });
    expect(first.statusCode, first.body).toBe(201);

    // 24 hours later, as far as the row is concerned.
    await pg.pool('migrator').query(
      `UPDATE core.idempotency_keys SET expires_at = now() - interval '1 minute'
        WHERE hospital_id = $1 AND key = $2`,
      [tenants.hospitalA, key],
    );

    const reused = await register({ token: deskA.token, payload: registration(15), idempotencyKey: key });

    expect(reused.statusCode, reused.body).toBe(201);
    expect(reused.headers['idempotent-replay']).toBeUndefined();
    expect(await patientsWithMobile(tenants.hospitalA, mobileFor(15))).toBe(1);
  });

  it('is swept by the retention role across every tenant', async () => {
    const staleA = newId();
    const staleB = newId();
    for (const [hospital, key] of [
      [tenants.hospitalA, staleA],
      [tenants.hospitalB, staleB],
    ] as const) {
      await pg.pool('migrator').query(
        `INSERT INTO core.idempotency_keys
           (id, hospital_id, key, route, method, request_hash, status, response_status,
            completed_at, created_at, expires_at)
         VALUES ($1, $2, $3, '/api/v1/patients', 'POST', repeat('a', 64), 'completed', 201,
                 now() - interval '2 days', now() - interval '2 days', now() - interval '1 day')`,
        [newId(), hospital, key],
      );
    }

    const purged = await pg
      .pool('retention')
      .query<{ purge_expired_idempotency_keys: string }>('SELECT core.purge_expired_idempotency_keys()');
    expect(Number(purged.rows[0]?.purge_expired_idempotency_keys ?? '0')).toBeGreaterThanOrEqual(2);

    expect(await keyRow(tenants.hospitalA, staleA)).toBeUndefined();
    expect(await keyRow(tenants.hospitalB, staleB)).toBeUndefined();
  });

  it('refuses a status the interceptor never writes', async () => {
    await expect(
      pg.pool('migrator').query(
        `INSERT INTO core.idempotency_keys
           (id, hospital_id, key, route, method, request_hash, status, locked_until, created_at, expires_at)
         VALUES ($1, $2, $3, '/api/v1/patients', 'POST', repeat('b', 64), 'pending', now(), now(),
                 now() + interval '1 day')`,
        [newId(), tenants.hospitalA, newId()],
      ),
    ).rejects.toThrow(/idempotency_keys_status_valid/);
  });

  it('refuses a completed row with nothing to replay', async () => {
    await expect(
      pg.pool('migrator').query(
        `INSERT INTO core.idempotency_keys
           (id, hospital_id, key, route, method, request_hash, status, created_at, expires_at)
         VALUES ($1, $2, $3, '/api/v1/patients', 'POST', repeat('c', 64), 'completed', now(),
                 now() + interval '1 day')`,
        [newId(), tenants.hospitalA, newId()],
      ),
    ).rejects.toThrow(/idempotency_keys_completed_has_response/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('tenancy', () => {
  it('lets two hospitals use the same key string without meeting', async () => {
    const key = newId();
    const payload = registration(16);

    const a = await register({ token: deskA.token, payload, idempotencyKey: key });
    const b = await register({ token: deskB.token, payload, idempotencyKey: key });

    expect(a.statusCode, a.body).toBe(201);
    expect(b.statusCode, b.body).toBe(201);
    expect(b.headers['idempotent-replay']).toBeUndefined();
    expect(a.json<{ id: string }>().id).not.toBe(b.json<{ id: string }>().id);

    // Two rows, one per hospital, both under the same key.
    expect((await keyRow(tenants.hospitalA, key))?.status).toBe('completed');
    expect((await keyRow(tenants.hospitalB, key))?.status).toBe('completed');
  });
});
