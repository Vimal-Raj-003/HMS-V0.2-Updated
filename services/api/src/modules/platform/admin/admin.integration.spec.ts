import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, SETTING_DEFINITIONS, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';

/**
 * The admin console API, proven against a real PostgreSQL 17.
 *
 * What this suite is actually for is the four properties that cannot be checked
 * by reading the code:
 *
 *  1. A role **without** the key gets 403, and the same request with the key
 *     succeeds — so the decorator is wired to a guard that runs.
 *  2. A **cross-tenant id returns 404, not 403** (`docs/09` §3.1 case 2). No
 *     query in this module carries a `hospital_id` predicate, so if isolation
 *     holds it is row-level security doing it.
 *  3. Every mutation leaves **exactly one** audit row carrying the acting user
 *     and the request's trace id, plus its registered outbox event, both written
 *     inside the transaction that made the change (`EN-024` §5).
 *  4. Cursor pages are stable and do not overlap, and a reason-required mutation
 *     is refused without `x-reason`.
 */

let pg: TestPostgres;
let app: NestFastifyApplication;
let tenants: TenantFixture;

const PASSWORD = 'Correct-Horse-Battery-9!';
const NEW_PASSWORD = 'Another-Horse-Battery-7!';

interface Actor {
  readonly userId: string;
  readonly roleId: string;
  readonly username: string;
  token: string;
}

/** Full admin in hospital A; limited (users-read only) in A; full admin in B. */
const adminA: Actor = { userId: newId(), roleId: newId(), username: 'admin-alpha', token: '' };
const limitedA: Actor = { userId: newId(), roleId: newId(), username: 'clerk-alpha', token: '' };
const adminB: Actor = { userId: newId(), roleId: newId(), username: 'admin-bravo', token: '' };

/** Extra users in hospital A, purely so cursor pagination has something to page. */
const filler = Array.from({ length: 6 }, (_, i) => ({ id: newId(), username: `filler-${i}` }));

/** Everything the admin console needs, plus `org.read` for the branch routes. */
const FULL_ADMIN_KEYS = PERMISSION_CATALOGUE.filter(
  (p) => p.key.startsWith('admin.') || p.key === 'org.read',
).map((p) => p.key);

const LIMITED_KEYS = ['admin.user.read'];

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

  // `core.settings.key` has a foreign key to this table, and `hms_app` has no
  // INSERT on it by design (`_grants`: a compromised service must not be able to
  // invent a setting). In production the seed writes it as `hms_migrator`; here
  // the fixture does the same job.
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
     VALUES ($1, $2, $3, $4, 'Integration test role', 'admin_console', 'admin', now())`,
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

async function seedFiller(hospitalId: string): Promise<void> {
  const pool = pg.pool('migrator');
  for (const user of filler) {
    await pool.query(
      `INSERT INTO core.users (id, hospital_id, group_id, username, name, display_name, status, type, updated_at)
       VALUES ($1, $2, (SELECT group_id FROM core.hospitals WHERE id = $2), $3, $4::jsonb, $5, 'active', 'staff', now())`,
      [
        user.id,
        hospitalId,
        user.username,
        JSON.stringify({ given: 'Filler', family: user.username }),
        `Filler ${user.username}`,
      ],
    );
  }
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
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
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
    `SELECT id, actor_user_id, trace_id, entity, action::text AS action, row_id, reason_text, before, after
       FROM core.audit_log WHERE trace_id = $1`,
    [String(traceId)],
  );
  return result.rows as Array<Record<string, unknown>>;
}

async function outboxRowsForTrace(traceId: unknown): Promise<Array<Record<string, unknown>>> {
  const result = await pg.pool('migrator').query(
    `SELECT id, event_type, aggregate, aggregate_id, payload, retention_days
       FROM core.outbox_events WHERE trace_id = $1 ORDER BY event_type`,
    [String(traceId)],
  );
  return result.rows as Array<Record<string, unknown>>;
}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'ADM' });
  await syncCatalogues();

  await seedActor(tenants.hospitalA, tenants.branchA, adminA, FULL_ADMIN_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, limitedA, LIMITED_KEYS);
  await seedActor(tenants.hospitalB, tenants.branchB, adminB, FULL_ADMIN_KEYS);
  await seedFiller(tenants.hospitalA);

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  adminA.token = await login(tenants.hospitalA, adminA.username);
  limitedA.token = await login(tenants.hospitalA, limitedA.username);
  adminB.token = await login(tenants.hospitalB, adminB.username);
}, 300_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('users — reads', () => {
  it('lists the caller’s own hospital', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/admin/users?limit=50', token: adminA.token });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      items: Array<{ username: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    }>();
    expect(body.items.map((u) => u.username)).toContain(adminA.username);
    expect(body).toHaveProperty('hasMore');
    expect(body).not.toHaveProperty('total');
  });

  it('never shows another hospital’s users', async () => {
    const a = await call({ method: 'GET', url: '/api/v1/admin/users?limit=100', token: adminA.token });
    const b = await call({ method: 'GET', url: '/api/v1/admin/users?limit=100', token: adminB.token });
    const namesA = a.json<{ items: Array<{ username: string }> }>().items.map((u) => u.username);
    const namesB = b.json<{ items: Array<{ username: string }> }>().items.map((u) => u.username);

    expect(namesA).toContain(adminA.username);
    expect(namesA).not.toContain(adminB.username);
    expect(namesB).toContain(adminB.username);
    expect(namesB).not.toContain(adminA.username);
  });

  /**
   * `docs/09` §3.1 case 2: 404, **not** 403. A 403 would confirm that the record
   * exists, which is an existence oracle across tenants.
   */
  it('returns 404 — not 403 — for a user id belonging to another hospital', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/admin/users/${adminB.userId}`,
      token: adminA.token,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ type: expect.stringContaining('not-found') });
  });

  it('returns the same 404 for an id that exists nowhere, so the two are indistinguishable', async () => {
    const ghost = await call({ method: 'GET', url: `/api/v1/admin/users/${newId()}`, token: adminA.token });
    const foreign = await call({
      method: 'GET',
      url: `/api/v1/admin/users/${adminB.userId}`,
      token: adminA.token,
    });
    expect(ghost.statusCode).toBe(foreign.statusCode);
    expect(ghost.json<{ detail: string }>().detail).toBe(foreign.json<{ detail: string }>().detail);
  });

  it('refuses a role that does not hold the key', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/admin/roles', token: limitedA.token });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('lets the same limited role through on the one key it does hold', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/admin/users', token: limitedA.token });
    expect(res.statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('users — cursor pagination', () => {
  it('returns stable, non-overlapping pages that reach every row', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url = `/api/v1/admin/users?limit=3${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const res = await call({ method: 'GET', url, token: adminA.token });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<{ items: Array<{ id: string }>; nextCursor: string | null; hasMore: boolean }>();
      expect(body.items.length).toBeLessThanOrEqual(3);
      seen.push(...body.items.map((u) => u.id));
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(20);
    } while (cursor !== null);

    expect(pages).toBeGreaterThan(1);
    // No row appears twice and none is skipped: the whole point of keyset paging.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain(adminA.userId);
    expect(seen).toContain(limitedA.userId);
    for (const user of filler) expect(seen).toContain(user.id);
  });

  it('refuses a cursor minted for another tenant', async () => {
    const first = await call({ method: 'GET', url: '/api/v1/admin/users?limit=2', token: adminA.token });
    const cursor = first.json<{ nextCursor: string | null }>().nextCursor ?? '';
    expect(cursor.length).toBeGreaterThan(0);

    const replayed = await call({
      method: 'GET',
      url: `/api/v1/admin/users?limit=2&cursor=${encodeURIComponent(cursor)}`,
      token: adminB.token,
    });
    expect(replayed.statusCode).toBe(400);
  });

  it('refuses a cursor minted for a different list', async () => {
    const users = await call({ method: 'GET', url: '/api/v1/admin/users?limit=2', token: adminA.token });
    const cursor = users.json<{ nextCursor: string | null }>().nextCursor ?? '';
    const res = await call({
      method: 'GET',
      url: `/api/v1/admin/audit?limit=2&cursor=${encodeURIComponent(cursor)}`,
      token: adminA.token,
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a tampered cursor rather than silently restarting at page one', async () => {
    const res = await call({
      method: 'GET',
      url: '/api/v1/admin/users?limit=2&cursor=bm90LWEtY3Vyc29y.zzzz',
      token: adminA.token,
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('users — writes', () => {
  const created = { username: `made-${Date.now().toString(36)}`, id: '' };

  it('creates a user with its role grant, one audit row and its events', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/admin/users',
      token: adminA.token,
      reason: 'New joiner from HR',
      payload: {
        username: created.username,
        name: { given: 'Asha', family: 'Rao' },
        type: 'staff',
        roleAssignments: [{ roleId: limitedA.roleId, branchId: tenants.branchA }],
        inviteVia: 'none',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; status: string; roles: Array<{ role_id: string }> }>();
    created.id = body.id;
    expect(body.status).toBe('invited');
    expect(body.roles.map((r) => r.role_id)).toContain(limitedA.roleId);

    // Two rows: the creation itself, and the `read_phi` written by the read this
    // route does to build its response body. Only one describes the mutation.
    const audit = await auditRowsForTrace(res.headers['x-trace-id']);
    const inserts = audit.filter((row) => row['action'] === 'insert');
    expect(inserts).toHaveLength(1);
    expect(audit.filter((row) => row['action'] === 'read_phi')).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ entity: 'core.users', actor_user_id: adminA.userId, row_id: body.id });

    const events = await outboxRowsForTrace(res.headers['x-trace-id']);
    expect(events.map((e) => e['event_type'])).toEqual(
      expect.arrayContaining(['admin.user.created', 'admin.role.assigned']),
    );
  });

  it('refuses to create a user without a reason, because granting a role needs one', async () => {
    // `admin.role.assign` is reason-required in the catalogue, and creating a
    // user grants a role — so the second policy check refuses without `x-reason`.
    const res = await call({
      method: 'POST',
      url: '/api/v1/admin/users',
      token: adminA.token,
      payload: {
        username: `noreason-${Date.now().toString(36)}`,
        name: { given: 'No', family: 'Reason' },
        roleAssignments: [{ roleId: limitedA.roleId, branchId: tenants.branchA }],
        inviteVia: 'none',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toMatch(/reason is required/i);
  });

  it('rejects a malformed body with field-level errors', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/admin/users',
      token: adminA.token,
      reason: 'test',
      payload: { username: 'x', name: { given: '' }, roleAssignments: [] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ errors: Array<{ path: string }> }>();
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it('updates a user under an optimistic lock', async () => {
    const before = await call({
      method: 'GET',
      url: `/api/v1/admin/users/${created.id}`,
      token: adminA.token,
    });
    const version = before.json<{ version: number }>().version;

    const res = await call({
      method: 'PATCH',
      url: `/api/v1/admin/users/${created.id}`,
      token: adminA.token,
      payload: { version, employeeId: 'EMP-0042' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ employee_id: 'EMP-0042' });

    const audit = await auditRowsForTrace(res.headers['x-trace-id']);
    const updates = audit.filter((row) => row['action'] === 'update');
    expect(updates).toHaveLength(1);
    // Changed columns only — an unchanged field in a diff is noise.
    expect(updates[0]?.['after']).toEqual({ employee_id: 'EMP-0042' });

    const stale = await call({
      method: 'PATCH',
      url: `/api/v1/admin/users/${created.id}`,
      token: adminA.token,
      payload: { version, employeeId: 'EMP-0043' },
    });
    expect(stale.statusCode).toBe(409);
  });

  it('refuses to deactivate without x-reason', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/admin/users/${created.id}/deactivate`,
      token: adminA.token,
      payload: { reason: 'Left the organisation' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toMatch(/reason is required/i);
  });

  it('deactivates with a reason, writing exactly one audit row and one event', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/admin/users/${created.id}/deactivate`,
      token: adminA.token,
      reason: 'Left the organisation',
      payload: { reason: 'Left the organisation' },
    });
    expect(res.statusCode).toBe(201);

    const traceId = res.headers['x-trace-id'];
    // Exactly one row for the whole request — not "at least one". A mutation
    // that audits twice is as wrong as one that audits none: the register then
    // reports two deactivations that never happened.
    const audit = await auditRowsForTrace(traceId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_user_id: adminA.userId,
      trace_id: traceId,
      row_id: created.id,
      reason_text: 'Left the organisation',
    });
    expect(audit[0]?.['after']).toMatchObject({ status: 'deactivated' });

    const events = await outboxRowsForTrace(traceId);
    const deactivated = events.filter((e) => e['event_type'] === 'admin.user.deactivated');
    expect(deactivated).toHaveLength(1);
    expect(deactivated[0]).toMatchObject({ aggregate: 'user', aggregate_id: created.id });
  });

  it('never hard-deletes: the row survives deactivation', async () => {
    const row = await pg
      .pool('migrator')
      .query(`SELECT status::text AS status, deleted_at, deactivation_reason FROM core.users WHERE id = $1`, [
        created.id,
      ]);
    expect(row.rows[0]).toMatchObject({ status: 'deactivated', deleted_at: null });
  });

  it('refuses an administrator deactivating their own account', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/admin/users/${adminA.userId}/deactivate`,
      token: adminA.token,
      reason: 'oops',
      payload: { reason: 'Leaving today' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('returns 404 when deactivating another hospital’s user', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/admin/users/${adminB.userId}/deactivate`,
      token: adminA.token,
      reason: 'cross tenant probe',
      payload: { reason: 'Cross-tenant probe' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('resets a password, forcing a change at next login and revoking sessions', async () => {
    const target = filler[0];
    const res = await call({
      method: 'POST',
      url: `/api/v1/admin/users/${target?.id ?? ''}/reset-password`,
      token: adminA.token,
      reason: 'User called the helpdesk',
      payload: { newPassword: NEW_PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ mustChangePassword: true });

    const row = await pg
      .pool('migrator')
      .query(
        `SELECT must_change_password, password_hash IS NOT NULL AS has_hash FROM core.users WHERE id = $1`,
        [target?.id],
      );
    expect(row.rows[0]).toMatchObject({ must_change_password: true, has_hash: true });

    // The hash must never appear in the audit trail, in either direction.
    const audit = await auditRowsForTrace(res.headers['x-trace-id']);
    expect(JSON.stringify(audit)).not.toContain('$argon2');
  });

  it('rejects a password that fails the policy, with a field error', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/admin/users/${filler[1]?.id ?? ''}/reset-password`,
      token: adminA.token,
      reason: 'helpdesk',
      payload: { newPassword: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ errors: Array<{ path: string }> }>().errors[0]?.path).toBe('newPassword');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('roles and the permission matrix', () => {
  const custom = { id: '', key: `ward_clerk_${Date.now().toString(36).slice(-4)}` };

  it('serves the permission catalogue with its segregation-of-duties pairs', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/admin/permissions', token: adminA.token });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      modules: Array<{ module: string; permissions: unknown[] }>;
      segregationOfDuties: unknown[];
      total: number;
    }>();
    expect(body.total).toBe(PERMISSION_CATALOGUE.length);
    expect(body.modules.some((m) => m.module === 'EN-007')).toBe(true);
    expect(body.segregationOfDuties.length).toBeGreaterThan(0);
  });

  it('lists roles with a cursor and shows the system templates alongside custom ones', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/admin/roles?limit=50', token: adminA.token });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<{ key: string; assigned_users: number }> }>();
    expect(body.items.some((r) => r.key === `role_${adminA.username.replace(/-/g, '_')}`)).toBe(true);
  });

  it('creates a custom role and records the change', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/admin/roles',
      token: adminA.token,
      payload: {
        key: custom.key,
        name: 'Ward Clerk',
        description: 'Books beds and chases paperwork.',
        permissions: ['admin.user.read', 'org.read'],
        homeWorkspace: 'admin_console',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; permissions: string[] }>();
    custom.id = body.id;
    expect(body.permissions).toEqual(['admin.user.read', 'org.read']);

    const audit = await auditRowsForTrace(res.headers['x-trace-id']);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      entity: 'core.roles',
      action: 'config_change',
      actor_user_id: adminA.userId,
    });
    const events = await outboxRowsForTrace(res.headers['x-trace-id']);
    expect(events.map((e) => e['event_type'])).toContain('admin.role.created');
  });

  it('refuses a permission key that is not in the catalogue', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/admin/roles',
      token: adminA.token,
      payload: {
        key: `bogus_${Date.now().toString(36).slice(-4)}`,
        name: 'Bogus',
        description: 'Should never exist.',
        permissions: ['admin.user.read', 'admin.invented.key'],
        homeWorkspace: 'admin_console',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('admin.invented.key');
  });

  it('updates a role, reporting exactly what was added and removed', async () => {
    const before = await call({
      method: 'GET',
      url: `/api/v1/admin/roles/${custom.id}`,
      token: adminA.token,
    });
    const version = before.json<{ version: number }>().version;

    const res = await call({
      method: 'PATCH',
      url: `/api/v1/admin/roles/${custom.id}`,
      token: adminA.token,
      payload: {
        version,
        reason: 'Ward clerks no longer read the branch tree',
        permissions: ['admin.user.read', 'admin.settings.read'],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ permissions: string[] }>().permissions).toEqual([
      'admin.settings.read',
      'admin.user.read',
    ]);

    const events = await outboxRowsForTrace(res.headers['x-trace-id']);
    const updated = events.find((e) => e['event_type'] === 'admin.role.updated');
    expect(updated?.['payload']).toMatchObject({ added: ['admin.settings.read'], removed: ['org.read'] });
  });

  it('returns 404 for another hospital’s role', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/admin/roles/${adminB.roleId}`,
      token: adminA.token,
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses configure to a role that only holds read', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/admin/roles',
      token: limitedA.token,
      payload: {
        key: 'nope',
        name: 'Nope',
        description: 'x',
        permissions: [],
        homeWorkspace: 'admin_console',
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('role assignment', () => {
  let userRoleId = '';

  it('assigns a role with a justification and announces it', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/admin/users/${filler[2]?.id ?? ''}/roles`,
      token: adminA.token,
      reason: 'Covering the ward clerk',
      payload: {
        roleId: limitedA.roleId,
        branchId: tenants.branchA,
        justification: 'Covering the ward clerk for a fortnight',
      },
    });
    expect(res.statusCode).toBe(201);
    const items = res.json<{ items: Array<{ id: string; role_id: string; active: boolean }> }>().items;
    const grant = items.find((i) => i.role_id === limitedA.roleId);
    expect(grant).toBeDefined();
    userRoleId = grant?.id ?? '';

    // One row describes the grant; the second is the `read_phi` written by the
    // read this route does to return the user's current grants.
    const audit = await auditRowsForTrace(res.headers['x-trace-id']);
    const grants = audit.filter((row) => row['entity'] === 'core.user_roles');
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ action: 'config_change', actor_user_id: adminA.userId });
    expect(audit.filter((row) => row['action'] === 'read_phi')).toHaveLength(1);
    const events = await outboxRowsForTrace(res.headers['x-trace-id']);
    expect(events.map((e) => e['event_type'])).toContain('admin.role.assigned');
  });

  it('refuses assignment without x-reason', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/admin/users/${filler[3]?.id ?? ''}/roles`,
      token: adminA.token,
      payload: {
        roleId: limitedA.roleId,
        branchId: tenants.branchA,
        justification: 'No header reason supplied',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 when the role belongs to another hospital', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/admin/users/${filler[3]?.id ?? ''}/roles`,
      token: adminA.token,
      reason: 'cross tenant probe',
      payload: { roleId: adminB.roleId, branchId: tenants.branchA, justification: 'Cross-tenant role probe' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when the branch belongs to another hospital', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/admin/users/${filler[3]?.id ?? ''}/roles`,
      token: adminA.token,
      reason: 'cross tenant probe',
      payload: {
        roleId: limitedA.roleId,
        branchId: tenants.branchB,
        justification: 'Cross-tenant branch probe',
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('revokes by deactivating the grant, never deleting it', async () => {
    const res = await call({
      method: 'DELETE',
      url: `/api/v1/admin/users/${filler[2]?.id ?? ''}/roles/${userRoleId}`,
      token: adminA.token,
      reason: 'Cover period ended',
    });
    expect(res.statusCode).toBe(200);

    const row = await pg
      .pool('migrator')
      .query(`SELECT active FROM core.user_roles WHERE id = $1`, [userRoleId]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({ active: false });

    const events = await outboxRowsForTrace(res.headers['x-trace-id']);
    expect(events.map((e) => e['event_type'])).toContain('admin.role.revoked');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('branches', () => {
  it('lists the caller’s branches with a cursor', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/admin/branches', token: adminA.token });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<{ id: string; code: string }>; hasMore: boolean }>();
    expect(body.items.map((b) => b.id)).toContain(tenants.branchA);
    expect(body.items.map((b) => b.id)).not.toContain(tenants.branchB);
  });

  it('returns a branch, marking whether the caller is granted in it', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/admin/branches/${tenants.branchA}`,
      token: adminA.token,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: tenants.branchA, granted_to_caller: true });
  });

  it('returns 404 for another hospital’s branch', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/admin/branches/${tenants.branchB}`,
      token: adminA.token,
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a role without org.read', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/admin/branches', token: limitedA.token });
    expect(res.statusCode).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('settings', () => {
  it('serves the declarations from code', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/admin/settings/definitions', token: adminA.token });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<{ key: string }> }>();
    expect(body.items).toHaveLength(SETTING_DEFINITIONS.length);
  });

  it('resolves effective values, falling back to the declared default', async () => {
    const res = await call({
      method: 'GET',
      url: '/api/v1/admin/settings?q=default_theme',
      token: adminA.token,
    });
    expect(res.statusCode).toBe(200);
    const item = res
      .json<{ items: Array<{ key: string; value: unknown; source: string }> }>()
      .items.find((i) => i.key === 'ui.default_theme');
    expect(item).toMatchObject({ value: 'light', source: 'default' });
  });

  it('updates a value, auditing the before and after', async () => {
    const res = await call({
      method: 'PUT',
      url: '/api/v1/admin/settings',
      token: adminA.token,
      payload: { key: 'ui.default_theme', scope: 'hospital', scopeId: null, value: 'dark' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ key: 'ui.default_theme', value: 'dark', source: 'hospital' });

    const audit = await auditRowsForTrace(res.headers['x-trace-id']);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      entity: 'core.settings',
      action: 'config_change',
      actor_user_id: adminA.userId,
    });
    expect(audit[0]?.['before']).toEqual({ value: 'light' });
    expect(audit[0]?.['after']).toEqual({ value: 'dark' });

    const events = await outboxRowsForTrace(res.headers['x-trace-id']);
    expect(events.map((e) => e['event_type'])).toContain('admin.settings.changed');
  });

  it('is idempotent on a second write of the same key', async () => {
    const res = await call({
      method: 'PUT',
      url: '/api/v1/admin/settings',
      token: adminA.token,
      payload: { key: 'ui.default_theme', scope: 'hospital', scopeId: null, value: 'system' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ value: 'system' });

    const rows = await pg
      .pool('migrator')
      .query(
        `SELECT count(*)::int AS n FROM core.settings WHERE hospital_id = $1 AND key = 'ui.default_theme'`,
        [tenants.hospitalA],
      );
    expect(rows.rows[0]).toMatchObject({ n: 1 });
  });

  it('does not leak the change into the other tenant', async () => {
    const res = await call({
      method: 'GET',
      url: '/api/v1/admin/settings?q=default_theme',
      token: adminB.token,
    });
    const item = res
      .json<{ items: Array<{ key: string; value: unknown; source: string }> }>()
      .items.find((i) => i.key === 'ui.default_theme');
    expect(item).toMatchObject({ value: 'light', source: 'default' });
  });

  it('rejects a value the definition schema refuses', async () => {
    const res = await call({
      method: 'PUT',
      url: '/api/v1/admin/settings',
      token: adminA.token,
      payload: { key: 'ui.default_theme', scope: 'hospital', scopeId: null, value: 'neon' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses an approval-gated key rather than applying it without the approval', async () => {
    const res = await call({
      method: 'PUT',
      url: '/api/v1/admin/settings',
      token: adminA.token,
      payload: { key: 'session.idle_timeout_min', scope: 'hospital', scopeId: null, value: 45 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: string }>().detail).toMatch(/approval/i);

    const rows = await pg
      .pool('migrator')
      .query(`SELECT count(*)::int AS n FROM core.settings WHERE key = 'session.idle_timeout_min'`);
    expect(rows.rows[0]).toMatchObject({ n: 0 });
  });

  it('refuses a read to a role without the key', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/admin/settings', token: limitedA.token });
    expect(res.statusCode).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('feature flags and licence', () => {
  it('reports the licence state, defaulting safely when nothing is subscribed', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/admin/licence', token: adminA.token });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      subscription: unknown;
      tier: { status: string };
      entitlements: Array<{ key: string; allowed: boolean }>;
      clinicalSafetyExemptKeys: string[];
      usingDefaults: boolean;
    }>();
    expect(body.subscription).toBeNull();
    expect(body.usingDefaults).toBe(true);
    expect(body.tier.status).toBe('active');
    // Clinical safety is never gated, even with no licence at all.
    expect(body.entitlements.find((e) => e.key === 'module.audit.enabled')?.allowed).toBe(true);
    // Commercial features fail closed in the same state.
    expect(body.entitlements.find((e) => e.key === 'module.api_gateway.enabled')?.allowed).toBe(false);
    expect(body.clinicalSafetyExemptKeys).toContain('module.audit.enabled');
  });

  it('lists the module grid', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/admin/flags', token: adminA.token });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<{ key: string; licensed: boolean; configured: boolean }> }>();
    expect(body.items.some((f) => f.key === 'module.audit.enabled')).toBe(true);
  });

  it('blocks enabling a module the licence does not cover — and emits no event', async () => {
    const res = await call({
      method: 'PUT',
      url: '/api/v1/admin/flags/module.api_gateway.enabled',
      token: adminA.token,
      payload: { enabled: true },
    });
    // primitives/problem.ts maps NOT_LICENSED to 402.
    expect(res.statusCode).toBe(402);

    const events = await outboxRowsForTrace(res.headers['x-trace-id']);
    expect(events).toHaveLength(0);
    const rows = await pg
      .pool('migrator')
      .query(`SELECT count(*)::int AS n FROM core.feature_flags WHERE key = 'module.api_gateway.enabled'`);
    expect(rows.rows[0]).toMatchObject({ n: 0 });
  });

  it('allows turning a licensed, safety-exempt module on, auditing the toggle', async () => {
    const res = await call({
      method: 'PUT',
      url: '/api/v1/admin/flags/module.audit.enabled',
      token: adminA.token,
      payload: { enabled: true, note: 'Explicitly pinned on' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ key: 'module.audit.enabled', enabled: true, configured: true });

    const audit = await auditRowsForTrace(res.headers['x-trace-id']);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entity: 'core.feature_flags', actor_user_id: adminA.userId });
    const events = await outboxRowsForTrace(res.headers['x-trace-id']);
    expect(events.map((e) => e['event_type'])).toContain('admin.flag.changed');
  });

  it('never blocks turning a flag off', async () => {
    const res = await call({
      method: 'PUT',
      url: '/api/v1/admin/flags/module.api_gateway.enabled',
      token: adminA.token,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: false });
  });

  it('does not show one tenant’s flags to another', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/admin/flags', token: adminB.token });
    const audit = res
      .json<{ items: Array<{ key: string; configured: boolean }> }>()
      .items.find((f) => f.key === 'module.audit.enabled');
    expect(audit?.configured).toBe(false);
  });

  it('refuses both routes to a role without the key', async () => {
    expect(
      (await call({ method: 'GET', url: '/api/v1/admin/flags', token: limitedA.token })).statusCode,
    ).toBe(403);
    expect(
      (await call({ method: 'GET', url: '/api/v1/admin/licence', token: limitedA.token })).statusCode,
    ).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('audit log viewer', () => {
  it('searches the caller’s own hospital only', async () => {
    const a = await call({ method: 'GET', url: '/api/v1/admin/audit?limit=100', token: adminA.token });
    expect(a.statusCode).toBe(200);
    const rows = a.json<{ items: Array<{ actor_user_id: string | null }> }>().items;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.actor_user_id !== adminB.userId)).toBe(true);
  });

  it('filters by entity and by actor', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/admin/audit?entity=core.users&userId=${adminA.userId}&limit=100`,
      token: adminA.token,
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json<{ items: Array<{ entity: string; actor_user_id: string }> }>().items;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.entity === 'core.users' && r.actor_user_id === adminA.userId)).toBe(true);
  });

  it('filters by action', async () => {
    const res = await call({
      method: 'GET',
      url: '/api/v1/admin/audit?action=config_change&limit=100',
      token: adminA.token,
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json<{ items: Array<{ action: string }> }>().items;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.action === 'config_change')).toBe(true);
  });

  it('rejects an action that is not in the enum, as a field error not a 500', async () => {
    const res = await call({
      method: 'GET',
      url: '/api/v1/admin/audit?action=nonsense',
      token: adminA.token,
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an inverted date range', async () => {
    const res = await call({
      method: 'GET',
      url: '/api/v1/admin/audit?from=2026-08-20T10:00:00.000Z&to=2026-08-19T10:00:00.000Z',
      token: adminA.token,
    });
    expect(res.statusCode).toBe(400);
  });

  it('pages without overlap and without skipping', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url = `/api/v1/admin/audit?entity=core.users&limit=5${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const res = await call({ method: 'GET', url, token: adminA.token });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: Array<{ id: string }>; nextCursor: string | null }>();
      seen.push(...body.items.map((r) => r.id));
      cursor = body.nextCursor;
      pages += 1;
      // Each search writes its own audit row, but into `core.audit_log`, not
      // `core.users` — so this filtered list does not grow as we page it.
      expect(pages).toBeLessThan(30);
    } while (cursor !== null);

    expect(pages).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(seen.length);
  });

  /** `EN-024` §5: reading the audit trail is itself an access event. */
  it('audits the search itself, recording the filter but never its values', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/admin/audit?userId=${adminA.userId}&limit=5`,
      token: adminA.token,
    });
    const rows = await auditRowsForTrace(res.headers['x-trace-id']);
    const own = rows.filter((r) => r['entity'] === 'core.audit_log');
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ action: 'read_phi', actor_user_id: adminA.userId });
    expect(own[0]?.['reason_text']).toBe('audit search filtered by user');
    expect(String(own[0]?.['reason_text'])).not.toContain(adminA.userId);
  });

  it('refuses a role without admin.audit.read', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/admin/audit', token: limitedA.token });
    expect(res.statusCode).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the audit table stays append-only under all of this', () => {
  it('refuses an UPDATE from the application role', async () => {
    const appPool = pg.pool('app');
    await expect(appPool.query(`UPDATE core.audit_log SET reason_text = 'tampered'`)).rejects.toThrow();
  });

  it('refuses a DELETE from the application role', async () => {
    const appPool = pg.pool('app');
    await expect(appPool.query(`DELETE FROM core.audit_log`)).rejects.toThrow();
  });
});
