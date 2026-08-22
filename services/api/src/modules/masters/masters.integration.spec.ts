import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module.js';

/**
 * The EN-027 read endpoints against a real PostgreSQL 17.
 *
 * Five properties, none of which can be established by reading the code:
 *
 *  1. **Effective dating is honoured.** A superseded version is absent from the
 *     default list, `?asOf=` returns the version that was in effect then, and a
 *     version whose range has not started yet is returned by neither. This is
 *     the whole point of the module: a picker that offers both the old and the
 *     new price is not a filtering preference, it is a billing defect.
 *  2. **Permission gating is real** — the same request 403s without the key and
 *     succeeds with it, for all three keys the module uses.
 *  3. **A cross-tenant id is 404, not 403** (`docs/09` §3.1 case 2), and a
 *     cross-tenant *list* is simply empty of the other tenant's rows. No query
 *     in this module carries a `hospital_id` predicate, so if isolation holds it
 *     is row-level security doing it.
 *  4. **Cursor pages do not overlap and do not drop rows**, including across
 *     rows that share a sort label — the case a keyset without an id tie-break
 *     gets wrong.
 *  5. **The PIN lookup answers with a district**, which is the field
 *     `AddressForm` fills the address from.
 */

/**
 * Root for the test app.
 *
 * `AppModule` does **not** declare this module's controllers — they are exported
 * as arrays for `app.module.ts` to spread in, which is how every Phase-1 module
 * is wired. So they are declared here instead, exactly once: declaring them in
 * both places would mount every route twice and Fastify would refuse the second
 * with `FST_ERR_DUPLICATED_ROUTE`, failing the whole suite at bootstrap. The
 * providers resolve `DatabaseService` and `CursorService` from `AppModule`'s
 * exports, so there is still one connection pool.
 */
/**
 * `AppModule` now declares these controllers itself, so redeclaring them here
 * mounts every route twice and Fastify refuses the second with
 * FST_ERR_DUPLICATED_ROUTE -- the suite then fails to bootstrap rather than
 * failing a test.
 */
@Module({ imports: [AppModule] })
class MastersTestModule {}

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

const actor = (username: string): Actor => ({ userId: newId(), roleId: newId(), username, token: '' });

/** A receptionist: reads every master, the queues and the counters. */
const desk = actor('mdm-desk-alpha');
/** Holds no masters key at all — the control for every gating assertion. */
const stranger = actor('mdm-stranger-alpha');
/** The same desk role in hospital B, so isolation is tested between two populated tenants. */
const deskB = actor('mdm-desk-bravo');

const DESK_KEYS = ['mdm.read', 'queue.board.read', 'receipt.shift.open'];
/** A real key, so the session authenticates; just not one of the three above. */
const STRANGER_KEYS = ['org.read'];

/** The three instants the effective-dating assertions are written against. */
const SIXTY_DAYS_AGO = "now() - interval '60 days'";
const THIRTY_DAYS_AGO = "now() - interval '30 days'";
const THIRTY_DAYS_HENCE = "now() + interval '30 days'";

interface Site {
  readonly hospitalId: string;
  readonly branchId: string;
  readonly prefix: string;
  /** The practitioner with two versions: superseded, then current. */
  readonly revisedDoctorKey: string;
  /** A practitioner whose one version does not start until next month. */
  readonly futureDoctorKey: string;
  readonly specialityKey: string;
  readonly departmentKey: string;
}

let siteA: Site;
let siteB: Site;

// ── fixture helpers ──────────────────────────────────────────────────────────

async function syncPermissions(): Promise<void> {
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

async function seedActor(
  hospitalId: string,
  branchId: string,
  who: Actor,
  keys: readonly string[],
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
     VALUES ($1, $2, $3, $4, 'Masters integration role', 'front_office', 'admin', now())`,
    [who.roleId, hospitalId, `role_${who.username.replace(/-/g, '_')}`, `Role ${who.username}`],
  );
  for (const key of keys) {
    await pool.query(
      `INSERT INTO core.role_permissions (role_id, permission_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [who.roleId, key],
    );
  }
  await pool.query(
    `INSERT INTO core.users (id, hospital_id, group_id, username, email, name, display_name,
                             password_hash, status, type, updated_at)
     VALUES ($1, $2, (SELECT group_id FROM core.hospitals WHERE id = $2), $3, $4, $5::jsonb, $6, $7,
             'active', 'staff', now())`,
    [
      who.userId,
      hospitalId,
      who.username,
      `${who.username}@example.invalid`,
      JSON.stringify({ given: 'Test', family: who.username }),
      `Test ${who.username}`,
      hash,
    ],
  );
  await pool.query(
    `INSERT INTO core.user_roles (id, hospital_id, user_id, role_id, branch_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [newId(), hospitalId, who.userId, who.roleId, branchId],
  );
}

/**
 * Inserts one version of one effective-dated master.
 *
 * `from` and `to` are SQL expressions rather than parameters so the fixture can
 * say `now() - interval '60 days'` and let the database evaluate it. Every row
 * these tests reason about is positioned relative to the server's clock, which
 * is the same clock `effectivePredicate` compares against.
 */
async function insertMaster(
  table: string,
  options: {
    hospitalId: string;
    branchId?: string | null;
    recordKey: string;
    version?: number;
    status?: 'draft' | 'pending_approval' | 'active' | 'superseded' | 'retired';
    from?: string;
    to?: string | null;
    columns: Record<string, unknown>;
  },
): Promise<string> {
  const id = newId();
  const names = Object.keys(options.columns);
  const values = Object.values(options.columns);
  const placeholders = names.map((_, i) => `$${i + 5}`);

  await pg.pool('migrator').query(
    `INSERT INTO mdm.${table}
       (id, record_key, hospital_id, branch_id, version, status, effective_from, effective_to,
        updated_at${names.length === 0 ? '' : `, ${names.join(', ')}`})
     VALUES ($1, $2, $3, $4, ${options.version ?? 1}, '${options.status ?? 'active'}',
             ${options.from ?? SIXTY_DAYS_AGO}, ${options.to ?? 'NULL'}, now()
             ${names.length === 0 ? '' : `, ${placeholders.join(', ')}`})`,
    [id, options.recordKey, options.hospitalId, options.branchId ?? null, ...values],
  );
  return id;
}

/** One hospital's worth of masters — the same shape in both tenants. */
async function seedSite(hospitalId: string, branchId: string, prefix: string): Promise<Site> {
  const pool = pg.pool('migrator');
  const departmentKey = newId();
  const specialityKey = newId();

  await insertMaster('mdm_departments', {
    hospitalId,
    recordKey: departmentKey,
    columns: { code: `${prefix}-ORTHO`, name: `${prefix} Orthopaedics`, kind: 'clinical' },
  });
  await insertMaster('mdm_departments', {
    hospitalId,
    recordKey: newId(),
    columns: { code: `${prefix}-GENMED`, name: `${prefix} General Medicine`, kind: 'clinical' },
  });

  await insertMaster('mdm_specialities', {
    hospitalId,
    recordKey: specialityKey,
    columns: {
      code: `${prefix}-ORTHO`,
      name: `${prefix} Orthopaedics`,
      department_key: departmentKey,
      active_branches: [branchId],
    },
  });

  await insertMaster('mdm_consult_types', {
    hospitalId,
    recordKey: newId(),
    columns: { code: `${prefix}-NEW`, name: `${prefix} New consultation`, kind: 'new' },
  });

  // Eight services with two deliberately sharing a name. A keyset that ordered
  // on the label alone would either repeat or lose one of the pair at a page
  // boundary; ordering on `(name, id)` cannot.
  for (let i = 0; i < 8; i += 1) {
    await insertMaster('mdm_services', {
      hospitalId,
      recordKey: newId(),
      columns: {
        code: `${prefix}-SVC-${i}`,
        name: i >= 6 ? `${prefix} Shared service name` : `${prefix} Service ${String(i)}`,
        group_key: i % 2 === 0 ? 'procedure' : 'consultation',
        department_key: departmentKey,
        is_appointable: i % 2 === 0,
      },
    });
  }

  await insertMaster('mdm_rooms', {
    hospitalId,
    branchId,
    recordKey: newId(),
    columns: {
      code: `${prefix}-OPD-1`,
      name: `${prefix} Consultation Room 1`,
      display_name: 'Room 1',
      kind: 'consult',
      department_key: departmentKey,
    },
  });

  // The practitioner that has been revised: version 1 ran from 60 days ago to
  // 30 days ago and is `superseded`; version 2 has run since and is `active`.
  const revisedDoctorKey = newId();
  await insertMaster('mdm_practitioners', {
    hospitalId,
    recordKey: revisedDoctorKey,
    version: 1,
    status: 'superseded',
    from: SIXTY_DAYS_AGO,
    to: THIRTY_DAYS_AGO,
    columns: {
      code: `${prefix}-DR001`,
      full_name: 'Ananya Krishnan',
      display_name: `${prefix} Dr Ananya Krishnan (locum)`,
      department_key: departmentKey,
      speciality_keys: [specialityKey],
      active_branches: [branchId],
      registration_number: 'KMC/2011/40118',
      hpr_id: 'ananya@hpr',
      user_id: null,
    },
  });
  await insertMaster('mdm_practitioners', {
    hospitalId,
    recordKey: revisedDoctorKey,
    version: 2,
    status: 'active',
    from: THIRTY_DAYS_AGO,
    columns: {
      code: `${prefix}-DR001`,
      full_name: 'Ananya Krishnan',
      display_name: `${prefix} Dr Ananya Krishnan`,
      department_key: departmentKey,
      speciality_keys: [specialityKey],
      active_branches: [branchId],
      registration_number: 'KMC/2011/40118',
      hpr_id: 'ananya@hpr',
    },
  });

  // A consultant who joins next month. Approved and `active`, but not yet in
  // effect — the case a `status = 'active'` filter with no range check would
  // wrongly offer to the appointment book today.
  const futureDoctorKey = newId();
  await insertMaster('mdm_practitioners', {
    hospitalId,
    recordKey: futureDoctorKey,
    from: THIRTY_DAYS_HENCE,
    columns: {
      code: `${prefix}-DR002`,
      full_name: 'Rajiv Menon',
      display_name: `${prefix} Dr Rajiv Menon`,
      department_key: departmentKey,
      speciality_keys: [specialityKey],
      active_branches: [branchId],
    },
  });

  // A retired one, to prove `retired` never reaches a picker either.
  await insertMaster('mdm_practitioners', {
    hospitalId,
    recordKey: newId(),
    status: 'retired',
    columns: {
      code: `${prefix}-DR003`,
      full_name: 'Suresh Gowda',
      display_name: `${prefix} Dr Suresh Gowda`,
    },
  });

  await insertMaster('mdm_areas', {
    hospitalId,
    recordKey: newId(),
    columns: {
      pincode: '560001',
      area_name: `${prefix} Bengaluru GPO`,
      city: 'Bengaluru',
      district: 'Bengaluru Urban',
      state: 'Karnataka',
      state_code: '29',
      taluk: 'Bengaluru North',
    },
  });
  await insertMaster('mdm_areas', {
    hospitalId,
    recordKey: newId(),
    columns: {
      pincode: '560034',
      area_name: `${prefix} Koramangala`,
      city: 'Bengaluru',
      district: 'Bengaluru Urban',
      state: 'Karnataka',
      state_code: '29',
    },
  });
  await insertMaster('mdm_areas', {
    hospitalId,
    recordKey: newId(),
    columns: {
      pincode: '570001',
      area_name: `${prefix} Mysuru GPO`,
      city: 'Mysuru',
      district: 'Mysuru',
      state: 'Karnataka',
      state_code: '29',
    },
  });

  // One row in each of the eight reference lists, so `/masters/{kind}` is
  // exercised for every kind rather than for the one that happened to be easy.
  await insertMaster('mdm_id_types', {
    hospitalId,
    recordKey: newId(),
    columns: { code: 'AADHAAR', name: `${prefix} Aadhaar`, category: 'government', retention: 'hash_last4' },
  });
  await insertMaster('mdm_relationship_types', {
    hospitalId,
    recordKey: newId(),
    columns: { code: 'SPOUSE', name: `${prefix} Spouse`, inverse_code: 'SPOUSE', next_of_kin_capable: true },
  });
  await insertMaster('mdm_occupations', {
    hospitalId,
    recordKey: newId(),
    columns: { code: 'FARMER', name: `${prefix} Farmer`, nco_code: '6111' },
  });
  await insertMaster('mdm_religions', {
    hospitalId,
    recordKey: newId(),
    columns: { code: 'HINDU', name: `${prefix} Hindu` },
  });
  await insertMaster('mdm_titles', {
    hospitalId,
    recordKey: newId(),
    columns: { code: 'MR', name: `${prefix} Mr`, gender_hint: 'male' },
  });
  await insertMaster('mdm_languages', {
    hospitalId,
    recordKey: newId(),
    columns: { code: 'kn', name: `${prefix} Kannada`, native_name: 'ಕನ್ನಡ', script: 'Knda' },
  });
  await insertMaster('mdm_nationalities', {
    hospitalId,
    recordKey: newId(),
    columns: { code: 'IND', alpha2: 'IN', name: `${prefix} Indian`, calling_code: '+91' },
  });
  await insertMaster('mdm_referral_sources', {
    hospitalId,
    recordKey: newId(),
    columns: { code: 'SELF', name: `${prefix} Self / walk-in`, kind: 'self' },
  });

  await pool.query(
    `INSERT INTO queue.queue_definitions
       (id, hospital_id, branch_id, code, name, kind, department_key, series_prefix, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'department_pool', $6, 'A', now()),
            ($7, $2, $3, $8, $9, 'counter_pool', NULL, 'B', now())`,
    [
      newId(),
      hospitalId,
      branchId,
      `${prefix}-Q1`,
      `${prefix} Ortho OPD queue`,
      departmentKey,
      newId(),
      `${prefix}-Q2`,
      `${prefix} Registration counter queue`,
    ],
  );

  await pool.query(
    `INSERT INTO billing.cash_counters
       (id, hospital_id, branch_id, code, name, counter_type, allowed_modes, receipt_series_key,
        float_limit, is_active, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'general', ARRAY['cash','upi']::billing."PaymentMode"[], 'RCPT',
             25000, true, now()),
            ($6, $2, $3, $7, $8, 'pharmacy', ARRAY['cash']::billing."PaymentMode"[], 'RCPT',
             10000, false, now())`,
    [
      newId(),
      hospitalId,
      branchId,
      `${prefix}-C1`,
      `${prefix} Front desk counter`,
      newId(),
      `${prefix}-C2`,
      `${prefix} Pharmacy counter (closed)`,
    ],
  );

  return { hospitalId, branchId, prefix, revisedDoctorKey, futureDoctorKey, specialityKey, departmentKey };
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

interface PageBody {
  items: Array<Record<string, unknown>>;
  nextCursor: string | null;
  hasMore: boolean;
}

async function get(url: string, token: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}

async function getPage(url: string, token: string): Promise<PageBody> {
  const res = await get(url, token);
  if (res.statusCode !== 200) throw new Error(`GET ${url} → ${res.statusCode} ${res.body}`);
  return res.json<PageBody>();
}

function names(page: PageBody, field = 'name'): string[] {
  return page.items.map((item) => String(item[field]));
}

// ── boot ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'MDM' });
  await syncPermissions();

  siteA = await seedSite(tenants.hospitalA, tenants.branchA, 'MDMA');
  siteB = await seedSite(tenants.hospitalB, tenants.branchB, 'MDMB');

  await seedActor(tenants.hospitalA, tenants.branchA, desk, DESK_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, stranger, STRANGER_KEYS);
  await seedActor(tenants.hospitalB, tenants.branchB, deskB, DESK_KEYS);

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(MastersTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  desk.token = await login(tenants.hospitalA, desk.username);
  stranger.token = await login(tenants.hospitalA, stranger.username);
  deskB.token = await login(tenants.hospitalB, deskB.username);
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

// ── the suites ───────────────────────────────────────────────────────────────

describe('masters — permission gating', () => {
  const MDM_ROUTES = [
    '/api/v1/departments',
    '/api/v1/specialities',
    '/api/v1/consult-types',
    '/api/v1/services',
    '/api/v1/rooms',
    '/api/v1/doctors',
    '/api/v1/areas',
    '/api/v1/masters/id-types',
  ];

  it('refuses every masters route without mdm.read, and serves it with', async () => {
    for (const url of MDM_ROUTES) {
      expect([url, (await get(url, stranger.token)).statusCode]).toStrictEqual([url, 403]);
      expect([url, (await get(url, desk.token)).statusCode]).toStrictEqual([url, 200]);
    }
  });

  it('gates the queue list on queue.board.read and the counter list on receipt.shift.open', async () => {
    expect((await get('/api/v1/queues', stranger.token)).statusCode).toBe(403);
    expect((await get('/api/v1/queues', desk.token)).statusCode).toBe(200);
    expect((await get('/api/v1/cash/counters', stranger.token)).statusCode).toBe(403);
    expect((await get('/api/v1/cash/counters', desk.token)).statusCode).toBe(200);
  });

  it('refuses an unauthenticated request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/departments' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unknown reference kind with a 400 that names the valid ones', async () => {
    const res = await get('/api/v1/masters/blood-groups', desk.token);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('id-types');
  });
});

describe('masters — effective dating', () => {
  it('returns the current version and not the superseded one', async () => {
    const page = await getPage('/api/v1/doctors?limit=100', desk.token);
    const display = names(page, 'display_name');

    expect(display).toContain(`${siteA.prefix} Dr Ananya Krishnan`);
    expect(display).not.toContain(`${siteA.prefix} Dr Ananya Krishnan (locum)`);

    // And exactly one version of that record_key, which is the invariant the
    // `btree_gist` exclusion constraint exists to guarantee.
    const versions = page.items.filter((i) => i['record_key'] === siteA.revisedDoctorKey);
    expect(versions).toHaveLength(1);
  });

  it('returns the version that was in effect at ?asOf', async () => {
    const asOf = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    const page = await getPage(`/api/v1/doctors?limit=100&asOf=${encodeURIComponent(asOf)}`, desk.token);
    const display = names(page, 'display_name');

    expect(display).toContain(`${siteA.prefix} Dr Ananya Krishnan (locum)`);
    expect(display).not.toContain(`${siteA.prefix} Dr Ananya Krishnan`);
    expect(page.items.filter((i) => i['record_key'] === siteA.revisedDoctorKey)).toHaveLength(1);
  });

  it('never offers a version whose range has not started, or a retired one', async () => {
    const page = await getPage('/api/v1/doctors?limit=100', desk.token);
    expect(page.items.some((i) => i['record_key'] === siteA.futureDoctorKey)).toBe(false);
    expect(names(page, 'display_name')).not.toContain(`${siteA.prefix} Dr Suresh Gowda`);
  });

  it('offers the future version once ?asOf reaches it', async () => {
    const asOf = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString();
    const page = await getPage(`/api/v1/doctors?limit=100&asOf=${encodeURIComponent(asOf)}`, desk.token);
    expect(page.items.some((i) => i['record_key'] === siteA.futureDoctorKey)).toBe(true);
  });

  it('applies the same rule to the doctor detail route', async () => {
    const current = await get(`/api/v1/doctors/${siteA.revisedDoctorKey}`, desk.token);
    expect(current.statusCode).toBe(200);
    expect(current.json<{ display_name: string }>().display_name).toBe(`${siteA.prefix} Dr Ananya Krishnan`);

    const asOf = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    const past = await get(
      `/api/v1/doctors/${siteA.revisedDoctorKey}?asOf=${encodeURIComponent(asOf)}`,
      desk.token,
    );
    expect(past.json<{ display_name: string }>().display_name).toBe(
      `${siteA.prefix} Dr Ananya Krishnan (locum)`,
    );

    // Before either version existed there is nothing to return — and "nothing"
    // is a 404, not an empty object the appointment book would render blank.
    const before = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const none = await get(
      `/api/v1/doctors/${siteA.revisedDoctorKey}?asOf=${encodeURIComponent(before)}`,
      desk.token,
    );
    expect(none.statusCode).toBe(404);
  });

  it('rejects an asOf that is not an offset-qualified timestamp', async () => {
    expect((await get('/api/v1/doctors?asOf=2026-03-15', desk.token)).statusCode).toBe(400);
  });
});

describe('masters — tenant isolation', () => {
  it('returns 404, not 403, for another hospital’s doctor', async () => {
    const res = await get(`/api/v1/doctors/${siteB.revisedDoctorKey}`, desk.token);
    expect(res.statusCode).toBe(404);

    // And the same id is a 200 for the tenant that owns it, so the 404 above is
    // isolation rather than the row simply not existing.
    expect((await get(`/api/v1/doctors/${siteB.revisedDoctorKey}`, deskB.token)).statusCode).toBe(200);
  });

  it('never leaks another hospital’s rows into a list', async () => {
    for (const [url, field] of [
      ['/api/v1/departments?limit=100', 'name'],
      ['/api/v1/services?limit=100', 'name'],
      ['/api/v1/doctors?limit=100', 'display_name'],
      ['/api/v1/areas?limit=100', 'area_name'],
      ['/api/v1/queues?limit=100', 'name'],
      ['/api/v1/cash/counters?limit=100&includeInactive=true', 'name'],
      ['/api/v1/masters/titles?limit=100', 'name'],
    ] as const) {
      const page = await getPage(url, desk.token);
      expect(page.items.length).toBeGreaterThan(0);
      for (const value of names(page, field)) {
        expect(value.startsWith(siteA.prefix)).toBe(true);
      }
    }
  });

  it('refuses a cursor minted in another tenant’s session', async () => {
    const first = await getPage('/api/v1/services?limit=2', deskB.token);
    expect(first.nextCursor).not.toBeNull();
    const res = await get(
      `/api/v1/services?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
      desk.token,
    );
    expect(res.statusCode).toBe(400);
  });

  it('refuses a cursor minted for a different list', async () => {
    const services = await getPage('/api/v1/services?limit=2', desk.token);
    const res = await get(
      `/api/v1/departments?limit=2&cursor=${encodeURIComponent(services.nextCursor ?? '')}`,
      desk.token,
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('masters — cursor pagination', () => {
  it('walks every service exactly once, including rows that share a name', async () => {
    const all = await getPage('/api/v1/services?limit=100', desk.token);
    expect(all.items).toHaveLength(8);
    expect(all.hasMore).toBe(false);
    expect(all.nextCursor).toBeNull();

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string =
        cursor === null
          ? '/api/v1/services?limit=3'
          : `/api/v1/services?limit=3&cursor=${encodeURIComponent(cursor)}`;
      const page: PageBody = await getPage(url, desk.token);
      seen.push(...page.items.map((i) => String(i['id'])));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor !== null);

    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
    expect([...seen].sort()).toStrictEqual([...all.items.map((i) => String(i['id']))].sort());
  });

  it('orders by the label ascending', async () => {
    const page = await getPage('/api/v1/services?limit=100', desk.token);
    const labels = names(page);
    expect(labels).toStrictEqual([...labels].sort());
  });
});

describe('masters — filters and projections', () => {
  it('filters doctors by speciality and by department', async () => {
    const bySpeciality = await getPage(
      `/api/v1/doctors?limit=100&specialityId=${siteA.specialityKey}`,
      desk.token,
    );
    expect(bySpeciality.items.length).toBeGreaterThan(0);

    const otherSpeciality = await getPage(`/api/v1/doctors?limit=100&specialityId=${newId()}`, desk.token);
    expect(otherSpeciality.items).toHaveLength(0);

    const byDepartment = await getPage(
      `/api/v1/doctors?limit=100&departmentId=${siteA.departmentKey}`,
      desk.token,
    );
    expect(byDepartment.items.length).toBeGreaterThan(0);
  });

  it('searches doctors by the name the desk types', async () => {
    const page = await getPage('/api/v1/doctors?limit=100&q=Krishnan', desk.token);
    expect(page.items).toHaveLength(1);
  });

  it('keeps a practitioner’s credentials and registry ids out of the list', async () => {
    const page = await getPage('/api/v1/doctors?limit=100', desk.token);
    const first = page.items[0];
    expect(first).toBeDefined();
    for (const forbidden of [
      'registration_number',
      'registration_council',
      'registration_valid_to',
      'hpr_id',
      'signature_file_id',
      'user_id',
    ]) {
      expect(Object.keys(first ?? {})).not.toContain(forbidden);
    }
  });

  it('keeps counter float and drawer configuration out of the counter picker', async () => {
    const page = await getPage('/api/v1/cash/counters?limit=100', desk.token);
    expect(page.items).toHaveLength(1); // the closed one is excluded by default
    for (const forbidden of ['float_limit', 'drawer_alert_limit', 'receipt_series_key', 'drawer_profile']) {
      expect(Object.keys(page.items[0] ?? {})).not.toContain(forbidden);
    }
    const withClosed = await getPage('/api/v1/cash/counters?limit=100&includeInactive=true', desk.token);
    expect(withClosed.items).toHaveLength(2);
  });

  it('keeps queue policy out of the queue picker', async () => {
    const page = await getPage('/api/v1/queues?limit=100', desk.token);
    expect(page.items).toHaveLength(2);
    for (const forbidden of ['priority_rules', 'skip_policy', 'display_config', 'member_refs']) {
      expect(Object.keys(page.items[0] ?? {})).not.toContain(forbidden);
    }

    const byKind = await getPage('/api/v1/queues?limit=100&kind=counter_pool', desk.token);
    expect(byKind.items).toHaveLength(1);
  });

  it('filters services by group and by appointability', async () => {
    const procedures = await getPage('/api/v1/services?limit=100&group=procedure', desk.token);
    expect(procedures.items).toHaveLength(4);
    const appointable = await getPage('/api/v1/services?limit=100&appointableOnly=true', desk.token);
    expect(appointable.items).toHaveLength(4);
  });

  it('returns every reference kind with its kind-specific attributes', async () => {
    for (const [kind, attribute] of [
      ['id-types', 'retention'],
      ['relationship-types', 'inverseCode'],
      ['occupations', 'ncoCode'],
      ['religions', 'dietaryDefaults'],
      ['titles', 'genderHint'],
      ['languages', 'nativeName'],
      ['nationalities', 'alpha2'],
      ['referral-sources', 'kind'],
    ] as const) {
      const page = await getPage(`/api/v1/masters/${kind}?limit=100`, desk.token);
      expect([kind, page.items.length]).toStrictEqual([kind, 1]);
      const attributes = page.items[0]?.['attributes'] as Record<string, unknown>;
      expect([kind, Object.keys(attributes)]).toStrictEqual([kind, expect.arrayContaining([attribute])]);
    }
  });
});

describe('areas — the PIN-code lookup', () => {
  it('returns the district and state for a PIN', async () => {
    const page = await getPage('/api/v1/areas?pin=560001', desk.token);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      pincode: '560001',
      district: 'Bengaluru Urban',
      state: 'Karnataka',
      state_code: '29',
      city: 'Bengaluru',
    });
  });

  it('matches on a prefix, so the form can look up as the receptionist types', async () => {
    expect((await getPage('/api/v1/areas?pin=5600', desk.token)).items).toHaveLength(2);
    expect((await getPage('/api/v1/areas?pin=57', desk.token)).items).toHaveLength(1);
    expect((await getPage('/api/v1/areas?pin=999999', desk.token)).items).toHaveLength(0);
  });

  it('filters by district', async () => {
    const page = await getPage('/api/v1/areas?district=Mysuru', desk.token);
    expect(page.items).toHaveLength(1);
  });

  it('refuses a non-numeric PIN rather than treating it as a pattern', async () => {
    expect((await get('/api/v1/areas?pin=56%25', desk.token)).statusCode).toBe(400);
  });
});

describe('doctors — the detail route', () => {
  it('returns the fees in effect alongside the practitioner', async () => {
    const consultTypeKey = newId();
    await insertMaster('mdm_practitioner_fees', {
      hospitalId: siteA.hospitalId,
      recordKey: newId(),
      columns: {
        practitioner_key: siteA.revisedDoctorKey,
        consult_type_key: consultTypeKey,
        amount: '600.00',
        currency: 'INR',
      },
    });

    const res = await get(`/api/v1/doctors/${siteA.revisedDoctorKey}`, desk.token);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ fees: Array<{ amount: string; consult_type_key: string }> }>();
    expect(body.fees).toStrictEqual([
      expect.objectContaining({ amount: '600.00', consult_type_key: consultTypeKey }),
    ]);
  });

  it('404s on an id that is not a practitioner at all', async () => {
    expect((await get(`/api/v1/doctors/${newId()}`, desk.token)).statusCode).toBe(404);
  });

  it('400s on an id that is not a UUID', async () => {
    expect((await get('/api/v1/doctors/not-a-uuid', desk.token)).statusCode).toBe(400);
  });
});
