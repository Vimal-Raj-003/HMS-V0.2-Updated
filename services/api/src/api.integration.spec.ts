import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';

/**
 * The request lifecycle, proven end to end against a real PostgreSQL 17.
 *
 * Unit tests can prove the policy engine decides correctly; only this can prove
 * that a request actually passes through auth, tenancy, policy and the
 * `SET LOCAL` transaction in that order, and that row-level security — not a
 * WHERE clause — is what stops one hospital reading another's staff list.
 */

let pg: TestPostgres;
let app: NestFastifyApplication;
let tenants: TenantFixture;

const PASSWORD = 'Correct-Horse-Battery-9!';
const users = { a: newId(), b: newId() };
const roles = { a: newId(), b: newId() };

async function seedUserWithRole(
  hospitalId: string,
  branchId: string,
  userId: string,
  roleId: string,
  username: string,
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
     VALUES ($1, $2, $3, $4, 'Integration test role', 'admin_console', 'admin', now())`,
    [roleId, hospitalId, `it_admin_${username}`, `IT Admin ${username}`],
  );

  // Grant every admin.user.* key the route might need, from the real catalogue.
  const keys = PERMISSION_CATALOGUE.filter((p) => p.key.startsWith('admin.user.')).map((p) => p.key);
  for (const key of keys) {
    await pool.query(
      `INSERT INTO core.role_permissions (role_id, permission_key) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [roleId, key],
    );
  }

  await pool.query(
    `INSERT INTO core.users (
       id, hospital_id, username, email, name, display_name, password_hash,
       status, type, updated_at
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'active', 'staff', now())`,
    [
      userId,
      hospitalId,
      username,
      `${username}@example.invalid`,
      JSON.stringify({ given: 'Test', family: 'User' }),
      `Test ${username}`,
      hash,
    ],
  );

  await pool.query(
    `INSERT INTO core.user_roles (id, hospital_id, user_id, role_id, branch_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [newId(), hospitalId, userId, roleId, branchId],
  );
}

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

async function login(hospitalId: string, identifier: string, password: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { hospitalId, identifier, password },
  });
}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg);

  // `core.role_permissions` has a foreign key to `core.permissions`, so the
  // catalogue must exist before any role can be granted anything. In production
  // `PermissionRegistryService` does this at boot; here we do it first because
  // the fixtures are seeded before the app starts.
  await syncPermissionCatalogue();

  await seedUserWithRole(tenants.hospitalA, tenants.branchA, users.a, roles.a, 'alpha');
  await seedUserWithRole(tenants.hospitalB, tenants.branchB, users.b, roles.b, 'bravo');

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 300_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe('health', () => {
  it('reports liveness without touching the database', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('reports readiness by actually reaching the database', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', database: true });
  });
});

describe('login', () => {
  it('issues tokens for correct credentials', async () => {
    const res = await login(tenants.hospitalA, 'alpha', PASSWORD);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).toEqual(expect.any(String));
    expect(body.roles).toContain('it_admin_alpha');
    expect(body.accessToken).not.toBe(body.refreshToken);
  });

  it('rejects a wrong password as problem+json', async () => {
    const res = await login(tenants.hospitalA, 'alpha', 'wrong-password');
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json();
    expect(body.type).toContain('unauthenticated');
    expect(body.reference).toEqual(expect.any(String));
  });

  /**
   * A different message or status for "no such user" turns the login form into
   * an account-enumeration oracle — you can discover who works at the hospital
   * without a single valid credential.
   */
  it('does not distinguish an unknown user from a wrong password', async () => {
    const unknown = await login(tenants.hospitalA, 'nobody-here', PASSWORD);
    const wrong = await login(tenants.hospitalA, 'alpha', 'wrong-password');
    expect(unknown.statusCode).toBe(wrong.statusCode);
    expect(unknown.json().detail).toBe(wrong.json().detail);
  });

  /**
   * The same username in another tenant must not authenticate: the hospital is
   * part of the identity, not a filter applied afterwards.
   */
  it('refuses a valid password against the wrong hospital', async () => {
    const res = await login(tenants.hospitalB, 'alpha', PASSWORD);
    expect(res.statusCode).toBe(401);
  });

  it('echoes a trace id on every response, including failures', async () => {
    const res = await login(tenants.hospitalA, 'alpha', 'wrong-password');
    expect(res.headers['x-trace-id']).toEqual(expect.any(String));
    expect(res.json().reference).toBe(res.headers['x-trace-id']);
  });

  it('rejects a malformed body with field-level errors', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { hospitalId: 'not-a-uuid', identifier: '', password: '' },
    });
    // primitives/problem.ts maps VALIDATION_FAILED to 400.
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors[0]).toHaveProperty('path');
  });
});

describe('the guard chain is closed by default', () => {
  it('refuses an unauthenticated request to a permissioned route', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/users' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('refuses a forged token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { authorization: 'Bearer not.a.real.token' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('an authenticated request completes the whole chain', () => {
  let tokenA = '';
  let tokenB = '';

  beforeAll(async () => {
    tokenA = (await login(tenants.hospitalA, 'alpha', PASSWORD)).json().accessToken;
    tokenB = (await login(tenants.hospitalB, 'bravo', PASSWORD)).json().accessToken;
  });

  it('returns the caller’s own hospital users', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(200);
    const usernames = res.json().items.map((u: { username: string }) => u.username);
    expect(usernames).toContain('alpha');
  });

  /**
   * The decisive test. The query in `UsersService.list` has NO `hospital_id`
   * predicate — the only thing separating these two tenants is the RLS policy
   * activated by `SET LOCAL` in step 8. If tenant B ever appears in tenant A's
   * list, row-level security is not doing the work we believe it is.
   */
  it('never returns another hospital’s users, with no WHERE clause doing the work', async () => {
    const a = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const b = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${tokenB}` },
    });

    const namesA = a.json().items.map((u: { username: string }) => u.username);
    const namesB = b.json().items.map((u: { username: string }) => u.username);

    expect(namesA).toContain('alpha');
    expect(namesA).not.toContain('bravo');
    expect(namesB).toContain('bravo');
    expect(namesB).not.toContain('alpha');
  });

  it('writes an audit row for the read, in the same transaction', async () => {
    const before = await pg
      .pool('migrator')
      .query(
        `SELECT count(*)::int AS n FROM core.audit_log WHERE hospital_id = $1 AND entity = 'core.users'`,
        [tenants.hospitalA],
      );
    await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const after = await pg
      .pool('migrator')
      .query(
        `SELECT count(*)::int AS n FROM core.audit_log WHERE hospital_id = $1 AND entity = 'core.users'`,
        [tenants.hospitalA],
      );
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
  });

  it('records the acting user and trace id on the audit row', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const traceId = res.headers['x-trace-id'];
    const row = await pg
      .pool('migrator')
      .query(`SELECT actor_user_id, trace_id, action, data_class FROM core.audit_log WHERE trace_id = $1`, [
        traceId,
      ]);
    expect(row.rows[0]).toMatchObject({
      actor_user_id: users.a,
      trace_id: traceId,
      action: 'read_phi',
      data_class: 'hr',
    });
  });
});

describe('account lockout', () => {
  it('locks the account after the configured number of failures', async () => {
    await seedUserWithRole(tenants.hospitalA, tenants.branchA, newId(), newId(), 'lockme');

    for (let i = 0; i < 5; i += 1) {
      const res = await login(tenants.hospitalA, 'lockme', 'wrong');
      expect(res.statusCode).toBe(401);
    }

    // Correct password now, but the account is locked — the lock must win.
    const res = await login(tenants.hospitalA, 'lockme', PASSWORD);
    // primitives/problem.ts maps ACCOUNT_LOCKED to 403.
    expect(res.statusCode).toBe(403);
    expect(res.json().type).toContain('account-locked');
  });
});
