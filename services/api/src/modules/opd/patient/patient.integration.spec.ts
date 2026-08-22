import { createHash } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import { PatientModule } from './patient.module.js';

/**
 * The patient master / MPI, proven against a real PostgreSQL 17.
 *
 * What this suite exists for is the set of properties that cannot be checked by
 * reading the code, and that would each fail silently in production:
 *
 *  1. A role **without** the key gets 403 and the same request with the key
 *     succeeds — so the decorator is wired to a guard that actually runs.
 *  2. A **cross-tenant id returns 404, not 403** (`docs/09` §3.1 case 2). No
 *     query in this module carries a `hospital_id` predicate, so if isolation
 *     holds, row-level security is what is holding it.
 *  3. Every mutation leaves **exactly one** audit row *and* its registered
 *     outbox event, both inside the transaction that made the change
 *     (`EN-024` §5) — asserted by trace id, so a stray second write is caught.
 *  4. The duplicate hard-stop blocks a registration at ≥ 0.85 and the override
 *     passes it only with the second permission and a reason (OP-001 §14 AC-2).
 *  5. A merge re-points, survives, and is reversible (§14 AC-11); the victim
 *     UHID stays searchable and the event carries it.
 *  6. Cursor pages do not overlap and reach every row.
 *  7. `allergy_statement = 'none_known'` can never be written without an
 *     asserter — the arm of the four-arm statement whose absence is a
 *     prescribing error (`docs/06` §10).
 */

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

/** A receptionist: register, read, search, amend. No override, no merge. */
const deskA: Actor = { userId: newId(), roleId: newId(), username: 'desk-alpha', token: '' };
/** MRD: everything the receptionist has, plus the override and the merge. */
const mrdA: Actor = { userId: newId(), roleId: newId(), username: 'mrd-alpha', token: '' };
/** Read-only: holds `patient.record.read` and nothing else. */
const readerA: Actor = { userId: newId(), roleId: newId(), username: 'reader-alpha', token: '' };
/** The same receptionist role, in the other hospital. */
const deskB: Actor = { userId: newId(), roleId: newId(), username: 'desk-bravo', token: '' };

const DESK_KEYS = [
  'patient.record.create',
  'patient.record.read',
  'patient.record.list',
  'patient.record.update',
];
const MRD_KEYS = [
  ...DESK_KEYS,
  'patient.record.create_override',
  'patient.merge.review',
  'patient.merge.execute',
];
const READER_KEYS = ['patient.record.read'];

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

/**
 * The `UHID` series, exactly as `packages/db/src/seed/platform.ts` configures it
 * (`{BR}{SEQ:8}`, not gapless, never reset). Without it registration cannot
 * complete — which is itself the correct behaviour, and is asserted below.
 */
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
     VALUES ($1, $2, $3, $4, 'Integration test role', 'front_office', 'clinical', now())`,
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
    `SELECT id, actor_user_id, trace_id, entity, action::text AS action, row_id, patient_id,
            business_key, reason_code, reason_text, before, after, data_class::text AS data_class
       FROM core.audit_log WHERE trace_id = $1 ORDER BY recorded_at, id`,
    [String(traceId)],
  );
  return result.rows as Array<Record<string, unknown>>;
}

async function outboxRowsForTrace(traceId: unknown): Promise<Array<Record<string, unknown>>> {
  const result = await pg.pool('migrator').query(
    `SELECT id, event_type, aggregate, aggregate_id, payload, contains_phi, retention_days
       FROM core.outbox_events WHERE trace_id = $1 ORDER BY event_type`,
    [String(traceId)],
  );
  return result.rows as Array<Record<string, unknown>>;
}

/** A minimal, valid registration. Callers override the fields they care about. */
function registration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    firstName: 'Asha',
    lastName: 'Rao',
    gender: 'female',
    dob: '1988-03-04',
    mobile: '9845012345',
    ...overrides,
  };
}

/**
 * `AppModule` does not import `PatientModule` — wiring it there is the caller's
 * change, deliberately left out of this module's diff. Composing both here is
 * what that wiring will look like, and proves `PatientModule` resolves its
 * platform dependencies through the `forwardRef` rather than duplicating them.
 */
@Module({ imports: [AppModule, PatientModule] })
class TestRootModule {}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'PAT' });
  await syncPermissionCatalogue();

  await defineUhidSeries(tenants.hospitalA, tenants.branchA);
  await defineUhidSeries(tenants.hospitalB, tenants.branchB);

  await seedActor(tenants.hospitalA, tenants.branchA, deskA, DESK_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, mrdA, MRD_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, readerA, READER_KEYS);
  await seedActor(tenants.hospitalB, tenants.branchB, deskB, DESK_KEYS);

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(TestRootModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  deskA.token = await login(tenants.hospitalA, deskA.username);
  mrdA.token = await login(tenants.hospitalA, mrdA.username);
  readerA.token = await login(tenants.hospitalA, readerA.username);
  deskB.token = await login(tenants.hospitalB, deskB.username);
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('registration', () => {
  const first = { id: '', uhid: '', version: 0 };

  it('registers a patient, allocates a UHID from the series, and announces it', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: deskA.token,
      payload: registration({
        titleCode: 'MS',
        preferredLanguage: 'ta',
        address: { line1: '12 Gandhi Road', city: 'Bengaluru', pincode: '560001' },
        contacts: [{ kind: 'emergency', name: 'Ravi Rao', relationshipCode: 'SPOUSE', phone: '9845012399' }],
      }),
    });

    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{
      id: string;
      uhid: string;
      version: number;
      full_name: string;
      banner: { allergy_statement: string; age_display: string };
      contacts: Array<{ name: string }>;
    }>();

    first.id = body.id;
    first.uhid = body.uhid;
    first.version = body.version;

    // `{BR}{SEQ:8}` from the branch short code, per the seeded series.
    expect(body.uhid).toMatch(/^[A-Za-z0-9-]+0{7}1$/);
    expect(body.full_name).toBe('Asha Rao');
    expect(body.contacts.map((c) => c.name)).toContain('Ravi Rao');

    // The banner never renders "no allergies" from an empty table: with nobody
    // asked, the statement is `not_recorded`, which is a different thing.
    expect(body.banner.allergy_statement).toBe('not_recorded');
    expect(body.banner.age_display).toMatch(/y$/);

    const traceId = res.headers['x-trace-id'];
    const audit = await auditRowsForTrace(traceId);
    // Exactly one row describes the mutation. The others are the `read_phi`
    // written by the read this route does to build its response body.
    const inserts = audit.filter((row) => row['action'] === 'insert');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      entity: 'patient.patients',
      actor_user_id: deskA.userId,
      row_id: body.id,
      patient_id: body.id,
      business_key: body.uhid,
      data_class: 'phi',
    });

    const events = await outboxRowsForTrace(traceId);
    const registered = events.filter((e) => e['event_type'] === 'patient.registered');
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ aggregate: 'patient', aggregate_id: body.id });
    expect(registered[0]?.['payload']).toMatchObject({ uhid: body.uhid, channel: 'counter' });
    // A registration is part of the record's provenance; the outbox's 7-day
    // default would destroy it long before anyone asks.
    expect(Number(registered[0]?.['retention_days'])).toBeGreaterThan(365);
    expect(registered[0]?.['contains_phi']).toBe(true);
  });

  it('stores the mobile canonically in both the forms the indexes need', async () => {
    const row = await pg
      .pool('migrator')
      .query(
        `SELECT mobile, mobile_local, uhid_normalised, dedupe_fingerprint FROM patient.patients WHERE id = $1`,
        [first.id],
      );
    expect(row.rows[0]).toMatchObject({
      mobile: '+919845012345',
      mobile_local: '9845012345',
      uhid_normalised: first.uhid.toUpperCase().replace(/[^A-Z0-9]/g, ''),
    });
    expect(String(row.rows[0]?.dedupe_fingerprint)).toHaveLength(40);
  });

  it('rejects a body with no basis for an age, with field-level errors', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: deskA.token,
      payload: { firstName: 'No', lastName: 'Age', gender: 'male', mobile: '9845099999' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ errors: Array<{ path: string }> }>().errors.map((e) => e.path)).toContain('dob');
  });

  it('refuses a second patient carrying an identifier another patient already holds', async () => {
    const payload = (firstName: string, lastName: string, mobile: string, dob: string) =>
      registration({
        firstName,
        lastName,
        mobile,
        dob,
        identifiers: [{ type: 'passport', value: 'Z9876543' }],
      });

    const first = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: deskA.token,
      payload: payload('Prakash', 'Menon', '9845061111', '1955-01-30'),
    });
    expect(first.statusCode, first.body).toBe(201);

    // Deliberately nothing like the first patient, so what is being tested is
    // the identifier collision and not the duplicate hard stop.
    const second = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: deskA.token,
      payload: payload('Fatima', 'Sheikh', '9845062222', '2001-12-05'),
    });
    expect(second.statusCode).toBe(409);

    // The whole registration rolled back, so the UHID the series had already
    // issued is given back rather than burnt on a row that does not exist.
    const orphan = await pg
      .pool('migrator')
      .query(`SELECT count(*)::int AS n FROM patient.patients WHERE mobile = '+919845062222'`);
    expect(orphan.rows[0]?.n).toBe(0);
    expect(await auditRowsForTrace(second.headers['x-trace-id'])).toHaveLength(0);
  });

  /**
   * OP-001 §14 AC-12 and the DPDP Rules 2025. Only the guardian *contact* half is
   * enforced — verifiable parental consent is EN-028's artefact and is not wired
   * to this route.
   */
  it('refuses a registration for a minor with no guardian on the record', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: deskA.token,
      payload: {
        firstName: 'Small',
        lastName: 'Child',
        gender: 'female',
        mobile: '9845063333',
        ageYears: 7,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ errors: Array<{ code: string }> }>().errors.map((e) => e.code)).toContain(
      'guardian_required',
    );
  });

  it('accepts the same minor once a guardian is named', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: deskA.token,
      payload: {
        firstName: 'Small',
        lastName: 'Child',
        gender: 'female',
        mobile: '9845063333',
        ageYears: 7,
        contacts: [
          {
            kind: 'guardian',
            name: 'Radha Child',
            relationshipCode: 'MOTHER',
            phone: '9845063334',
            isGuardian: true,
          },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    // Age-only capture estimates the date of birth to 1 January and says so, so
    // a report can exclude estimated ages rather than averaging them in.
    expect(res.json<{ dob_is_estimated: boolean; age_years: number }>()).toMatchObject({
      dob_is_estimated: true,
      age_years: 7,
    });
  });

  it('refuses a corporate patient with no employee or policy number', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: deskA.token,
      payload: registration({
        firstName: 'Corporate',
        lastName: 'Unbacked',
        mobile: '9845064444',
        payerType: 'corporate',
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ errors: Array<{ path: string }> }>().errors.map((e) => e.path)).toContain('payerRef');
  });

  it('refuses a role that does not hold patient.record.create', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: readerA.token,
      payload: registration({ mobile: '9845077777', firstName: 'Denied' }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('lets the same limited role through on the one key it does hold', async () => {
    const res = await call({ method: 'GET', url: `/api/v1/patients/${first.id}`, token: readerA.token });
    expect(res.statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the duplicate hard-stop (OP-001 §5, §14 AC-2)', () => {
  const original = { id: '', uhid: '' };

  beforeAll(async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: deskA.token,
      payload: registration({
        firstName: 'Meena',
        lastName: 'Iyer',
        mobile: '9845022222',
        dob: '1975-11-09',
      }),
    });
    const body = res.json<{ id: string; uhid: string }>();
    original.id = body.id;
    original.uhid = body.uhid;
  });

  it('blocks a second registration of the same mobile and date of birth', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: deskA.token,
      payload: registration({
        firstName: 'Meena',
        lastName: 'Iyer',
        mobile: '9845022222',
        dob: '1975-11-09',
      }),
    });

    // 422, not 409: the request was well formed and the caller was entitled to
    // make it — the refusal is about the content.
    expect(res.statusCode, res.body).toBe(422);
    const body = res.json<{ type: string; errors: Array<{ code: string; message: string }> }>();
    expect(body.type).toContain('clinical-hard-stop');
    expect(body.errors[0]?.code).toBe('duplicate_suspected');
    // The desk is told *which* record it is being warned about, or it cannot
    // choose between opening it and overriding.
    expect(body.errors[0]?.message).toContain(original.uhid);
    expect(body.errors[0]?.message).toContain(original.id);
  });

  it('writes nothing at all when it blocks — no patient, no audit, no event', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: deskA.token,
      payload: registration({
        firstName: 'Meena',
        lastName: 'Iyer',
        mobile: '9845022222',
        dob: '1975-11-09',
      }),
    });
    expect(res.statusCode).toBe(422);

    const traceId = res.headers['x-trace-id'];
    expect(await auditRowsForTrace(traceId)).toHaveLength(0);
    expect(await outboxRowsForTrace(traceId)).toHaveLength(0);

    const count = await pg
      .pool('migrator')
      .query(`SELECT count(*)::int AS n FROM patient.patients WHERE mobile = '+919845022222'`);
    expect(count.rows[0]?.n).toBe(1);
  });

  it('refuses the override to a role that does not hold patient.record.create_override', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: deskA.token,
      reason: 'Genuinely a different person with the same name and number',
      payload: registration({
        firstName: 'Meena',
        lastName: 'Iyer',
        mobile: '9845022222',
        dob: '1975-11-09',
        overrideDuplicate: {
          acknowledgedPatientIds: [original.id],
          reason: 'Genuinely a different person with the same name and number',
        },
      }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses the override even to MRD when no reason accompanies it', async () => {
    // `patient.record.create_override` is `requiresReason` in the catalogue, so
    // the policy engine refuses before the handler runs.
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: mrdA.token,
      payload: registration({
        firstName: 'Meena',
        lastName: 'Iyer',
        mobile: '9845022222',
        dob: '1975-11-09',
        overrideDuplicate: {
          acknowledgedPatientIds: [original.id],
          reason: 'Genuinely a different person with the same name and number',
        },
      }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toMatch(/reason is required/i);
  });

  it('refuses an override that acknowledges the wrong record', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: mrdA.token,
      reason: 'Twin sister, separate record',
      payload: registration({
        firstName: 'Meena',
        lastName: 'Iyer',
        mobile: '9845022222',
        dob: '1975-11-09',
        overrideDuplicate: {
          acknowledgedPatientIds: [newId()],
          reason: 'Twin sister, separate record',
        },
      }),
    });
    // The candidate that was actually found is still unacknowledged, so the
    // hard stop stands: an override is consent to a specific comparison, not a
    // blanket flag.
    expect(res.statusCode).toBe(422);
  });

  it('passes with the permission, a reason, and the right records acknowledged', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: mrdA.token,
      reason: 'Twin sister; separate Aadhaar and separate treatment history',
      payload: registration({
        firstName: 'Meena',
        lastName: 'Iyer',
        mobile: '9845022222',
        dob: '1975-11-09',
        overrideDuplicate: {
          acknowledgedPatientIds: [original.id],
          reason: 'Twin sister; separate Aadhaar and separate treatment history',
        },
      }),
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json<{ id: string; uhid: string; created_override_reason: string }>();
    expect(created.uhid).not.toBe(original.uhid);
    // The reason lives on the record, not only in the register: whoever opens
    // this patient later sees why two records exist.
    expect(created.created_override_reason).toMatch(/Twin sister/);

    const audit = await auditRowsForTrace(res.headers['x-trace-id']);
    // An override, not an insert: `override` is one of EN-024 §5's four
    // reason-mandatory actions, and recording it as `insert` would hide it from
    // the register that exists to find them.
    const overrides = audit.filter((row) => row['action'] === 'override');
    expect(overrides).toHaveLength(1);
    expect(overrides[0]?.['reason_text']).toMatch(/Twin sister/);
    expect(overrides[0]?.['after']).toMatchObject({ overridden_patient_ids: [original.id] });
    expect(audit.filter((row) => row['action'] === 'insert')).toHaveLength(0);
  });

  it('puts the overridden pair in front of MRD, scored and with its evidence', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/patients/dedupe', token: mrdA.token });
    expect(res.statusCode).toBe(200);
    const items = res.json<{
      items: Array<{ patient_a_id: string; patient_b_id: string; score: string; rule_hits: unknown }>;
    }>().items;

    const pair = items.find((i) => i.patient_a_id === original.id || i.patient_b_id === original.id);
    expect(pair).toBeDefined();
    expect(Number(pair?.score)).toBeGreaterThanOrEqual(0.85);
    // Evidence, not a bare number: the officer reviews which rules fired.
    expect(pair?.rule_hits).toMatchObject({ rules: expect.arrayContaining(['mobile_dob']) });
  });

  it('refuses the dedupe queue to a role without patient.merge.review', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/patients/dedupe', token: deskA.token });
    expect(res.statusCode).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the allergy statement (docs/06 §10)', () => {
  it('stamps an asserter on “none known”, because nobody can assert it', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: deskA.token,
      payload: registration({
        firstName: 'Kiran',
        lastName: 'Bose',
        mobile: '9845033333',
        dob: '1990-06-15',
        allergy: { statement: 'none_known' },
      }),
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ id: string }>().id;

    const row = await pg.pool('migrator').query(
      `SELECT allergy_statement::text AS s, allergy_asserted_by, allergy_asserted_at
           FROM patient.patients WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]?.s).toBe('none_known');
    // The CHECK `patients_allergy_assertion_attributed` would have refused the
    // row otherwise — this asserts the service supplies what the CHECK demands
    // rather than relying on the CHECK to catch it.
    expect(row.rows[0]?.allergy_asserted_by).toBe(deskA.userId);
    expect(row.rows[0]?.allergy_asserted_at).not.toBeNull();
  });

  it('refuses “unable to assess” with no reason', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: deskA.token,
      payload: registration({
        firstName: 'Unknown',
        lastName: 'Male',
        mobile: '9845044444',
        dob: '1970-01-01',
        allergy: { statement: 'unable_to_assess' },
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ errors: Array<{ path: string }> }>().errors.map((e) => e.path)).toContain(
      'allergy/unableReason',
    );
  });

  it('accepts “unable to assess” with a reason and keeps it', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: deskA.token,
      payload: registration({
        firstName: 'Unknown',
        lastName: 'Male',
        mobile: '9845044444',
        dob: '1970-01-01',
        allergy: {
          statement: 'unable_to_assess',
          unableReason: 'Unconscious on arrival; no attendant present.',
        },
      }),
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<{ banner: { allergy_unable_reason: string } }>().banner.allergy_unable_reason).toMatch(
      /Unconscious/,
    );
  });

  it('will not accept “known” from a client, because the allergy rows own it', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: deskA.token,
      payload: registration({
        firstName: 'Claims',
        lastName: 'Allergic',
        mobile: '9845055555',
        dob: '1980-02-02',
        allergy: { statement: 'known' },
      }),
    });
    // A banner reading "allergies recorded" over an empty list is worse than one
    // reading "not recorded".
    expect(res.statusCode).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('tenant isolation', () => {
  const inB = { id: '' };

  beforeAll(async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: deskB.token,
      payload: registration({ firstName: 'Bravo', lastName: 'Patient', mobile: '9845088888' }),
    });
    inB.id = res.json<{ id: string }>().id;
  });

  /**
   * `docs/09` §3.1 case 2: 404, **not** 403. A 403 would confirm the record
   * exists, which turns the API into an existence oracle across tenants.
   */
  it('returns 404 — not 403 — for a patient id belonging to another hospital', async () => {
    const res = await call({ method: 'GET', url: `/api/v1/patients/${inB.id}`, token: deskA.token });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ type: expect.stringContaining('not-found') });
  });

  it('returns the same 404 for an id that exists nowhere, so the two are indistinguishable', async () => {
    const ghost = await call({ method: 'GET', url: `/api/v1/patients/${newId()}`, token: deskA.token });
    const foreign = await call({ method: 'GET', url: `/api/v1/patients/${inB.id}`, token: deskA.token });
    expect(ghost.statusCode).toBe(foreign.statusCode);
    expect(ghost.json<{ detail: string }>().detail).toBe(foreign.json<{ detail: string }>().detail);
  });

  it('returns 404 on a cross-tenant amendment too, not 403', async () => {
    const res = await call({
      method: 'PATCH',
      url: `/api/v1/patients/${inB.id}`,
      token: deskA.token,
      reason: 'Cross-tenant probe',
      payload: { version: 0, reason: 'Cross-tenant probe', firstName: 'Probed' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 on a cross-tenant history read', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/patients/${inB.id}/history`,
      token: deskA.token,
    });
    expect(res.statusCode).toBe(404);
  });

  it('never returns another hospital’s patient from a search', async () => {
    const a = await call({ method: 'GET', url: '/api/v1/patients?limit=100', token: deskA.token });
    const b = await call({ method: 'GET', url: '/api/v1/patients?limit=100', token: deskB.token });
    const idsA = a.json<{ items: Array<{ id: string }> }>().items.map((p) => p.id);
    const idsB = b.json<{ items: Array<{ id: string }> }>().items.map((p) => p.id);

    expect(idsB).toContain(inB.id);
    expect(idsA).not.toContain(inB.id);
    expect(idsA.length).toBeGreaterThan(0);
  });

  it('does not find another hospital’s patient by their exact mobile', async () => {
    // The strongest form of the probe: hospital A knows the number and searches
    // the index directly. RLS, not a filter in the query, is what empties it.
    const res = await call({
      method: 'GET',
      url: '/api/v1/patients?mobile=9845088888',
      token: deskA.token,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: unknown[] }>().items).toHaveLength(0);
  });

  it('refuses a merge that names another hospital’s patient, as a 404', async () => {
    const survivor = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: mrdA.token,
      payload: registration({ firstName: 'Cross', lastName: 'Tenant', mobile: '9845066666' }),
    });
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients/merge',
      token: mrdA.token,
      reason: 'Cross-tenant merge probe',
      payload: {
        step: 'prepare',
        survivorId: survivor.json<{ id: string }>().id,
        victimId: inB.id,
        reason: 'Cross-tenant merge probe',
      },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('search', () => {
  it('finds a patient by exact mobile', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/patients?mobile=9845012345', token: deskA.token });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: Array<{ mobile: string }> }>().items[0]?.mobile).toBe('+919845012345');
  });

  it('finds a patient by mobile prefix', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/patients?mobile=98450', token: deskA.token });
    expect(res.json<{ items: unknown[] }>().items.length).toBeGreaterThan(1);
  });

  it('finds a patient by name trigram, tolerating a misspelling', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/patients?q=Meena Iyar', token: deskA.token });
    expect(res.statusCode).toBe(200);
    const names = res.json<{ items: Array<{ full_name: string }> }>().items.map((p) => p.full_name);
    expect(names).toContain('Meena Iyer');
  });

  it('finds a patient by UHID prefix', async () => {
    const all = await call({ method: 'GET', url: '/api/v1/patients?limit=100', token: deskA.token });
    const uhid = all.json<{ items: Array<{ uhid: string }> }>().items[0]?.uhid ?? '';
    const res = await call({
      method: 'GET',
      url: `/api/v1/patients?uhid=${encodeURIComponent(uhid.slice(0, uhid.length - 1))}`,
      token: deskA.token,
    });
    expect(res.json<{ items: Array<{ uhid: string }> }>().items.map((p) => p.uhid)).toContain(uhid);
  });

  it('refuses a name search too short for a trigram rather than scanning the MPI', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/patients?q=Me', token: deskA.token });
    expect(res.statusCode).toBe(400);
  });

  it('audits the read with the mode and the count, never the search term', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/patients?q=Meena', token: deskA.token });
    const audit = await auditRowsForTrace(res.headers['x-trace-id']);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'read_phi', entity: 'patient.patients', row_id: null });
    // The mode is recorded; the term — which is PHI — is not.
    expect(JSON.stringify(audit[0])).not.toContain('Meena');
    expect(JSON.stringify(audit[0])).toContain('search:name_trigram');
  });

  it('returns stable, non-overlapping pages that reach every row', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url = `/api/v1/patients?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const res = await call({ method: 'GET', url, token: deskA.token });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<{ items: Array<{ id: string }>; nextCursor: string | null }>();
      expect(body.items.length).toBeLessThanOrEqual(2);
      seen.push(...body.items.map((p) => p.id));
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(40);
    } while (cursor !== null);

    expect(pages).toBeGreaterThan(1);
    // No row twice and none skipped: the whole point of keyset paging.
    expect(new Set(seen).size).toBe(seen.length);

    const total = await call({ method: 'GET', url: '/api/v1/patients?limit=100', token: deskA.token });
    expect(seen.sort()).toEqual(
      total
        .json<{ items: Array<{ id: string }> }>()
        .items.map((p) => p.id)
        .sort(),
    );
  });

  it('refuses a cursor minted for another tenant', async () => {
    const first = await call({ method: 'GET', url: '/api/v1/patients?limit=1', token: deskA.token });
    const cursor = first.json<{ nextCursor: string | null }>().nextCursor ?? '';
    expect(cursor.length).toBeGreaterThan(0);

    const replayed = await call({
      method: 'GET',
      url: `/api/v1/patients?limit=1&cursor=${encodeURIComponent(cursor)}`,
      token: deskB.token,
    });
    expect(replayed.statusCode).toBe(400);
  });

  it('refuses the list to a role without patient.record.list', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/patients', token: readerA.token });
    expect(res.statusCode).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('demographic amendment (OP-001 §14 AC-14)', () => {
  const target = { id: '', version: 0 };

  beforeAll(async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: deskA.token,
      payload: registration({
        firstName: 'Latha',
        lastName: 'Nair',
        mobile: '9845011111',
        dob: '1996-09-21',
      }),
    });
    const body = res.json<{ id: string; version: number }>();
    target.id = body.id;
    target.version = body.version;
  });

  it('refuses an amendment without x-reason, because the key is reason-required', async () => {
    const res = await call({
      method: 'PATCH',
      url: `/api/v1/patients/${target.id}`,
      token: deskA.token,
      payload: { version: target.version, reason: 'Corrected from the ID card', lastName: 'Nayar' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toMatch(/reason is required/i);
  });

  it('versions the change, writes one audit row, one history row and one event', async () => {
    const res = await call({
      method: 'PATCH',
      url: `/api/v1/patients/${target.id}`,
      token: deskA.token,
      reason: 'Corrected from the ID card',
      payload: { version: target.version, reason: 'Corrected from the ID card', lastName: 'Nayar' },
    });
    expect(res.statusCode, res.body).toBe(200);

    const body = res.json<{ full_name: string; version: number }>();
    // The derived columns follow their sources rather than being settable.
    expect(body.full_name).toBe('Latha Nayar');
    expect(body.version).toBe(target.version + 1);
    target.version = body.version;

    const traceId = res.headers['x-trace-id'];
    const audit = await auditRowsForTrace(traceId);
    const updates = audit.filter((row) => row['action'] === 'update');
    expect(updates).toHaveLength(1);
    // Changed columns only — an unchanged field in a diff is noise an
    // investigator has to read past.
    expect(updates[0]?.['before']).toEqual({ last_name: 'Nair' });
    expect(updates[0]?.['after']).toEqual({ last_name: 'Nayar' });
    expect(updates[0]?.['reason_text']).toBe('Corrected from the ID card');

    const events = await outboxRowsForTrace(traceId);
    const updated = events.filter((e) => e['event_type'] === 'patient.updated');
    expect(updated).toHaveLength(1);
    expect(updated[0]?.['payload']).toMatchObject({ changedFields: ['last_name'] });

    const history = await pg.pool('migrator').query(
      `SELECT changed_fields, before, after, reason, changed_by, audit_id
                FROM patient.demographic_history WHERE patient_id = $1`,
      [target.id],
    );
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]).toMatchObject({
      changed_fields: ['last_name'],
      reason: 'Corrected from the ID card',
      changed_by: deskA.userId,
    });
    // Chained to the audit row by id, so the register and the clinical history
    // resolve to one another.
    expect(history.rows[0]?.audit_id).toBe(updates[0]?.['id']);
  });

  it('recomputes the fingerprint when identity changes, so duplicate detection keeps working', async () => {
    const before = await pg
      .pool('migrator')
      .query(`SELECT dedupe_fingerprint FROM patient.patients WHERE id = $1`, [target.id]);

    const res = await call({
      method: 'PATCH',
      url: `/api/v1/patients/${target.id}`,
      token: deskA.token,
      reason: 'Patient changed their number',
      payload: { version: target.version, reason: 'Patient changed their number', mobile: '9845011122' },
    });
    expect(res.statusCode, res.body).toBe(200);
    target.version = res.json<{ version: number }>().version;

    const after = await pg
      .pool('migrator')
      .query(`SELECT dedupe_fingerprint, mobile, mobile_local FROM patient.patients WHERE id = $1`, [
        target.id,
      ]);
    expect(after.rows[0]?.dedupe_fingerprint).not.toBe(before.rows[0]?.dedupe_fingerprint);
    expect(after.rows[0]).toMatchObject({ mobile: '+919845011122', mobile_local: '9845011122' });
  });

  it('refuses a stale version rather than overwriting somebody else’s edit', async () => {
    const res = await call({
      method: 'PATCH',
      url: `/api/v1/patients/${target.id}`,
      token: deskA.token,
      reason: 'Stale write',
      payload: { version: 0, reason: 'Stale write', lastName: 'Stale' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses a no-op rather than writing an empty history entry', async () => {
    const res = await call({
      method: 'PATCH',
      url: `/api/v1/patients/${target.id}`,
      token: deskA.token,
      reason: 'No change',
      payload: { version: target.version, reason: 'No change at all', lastName: 'Nayar' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('pages the history without overlap', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url = `/api/v1/patients/${target.id}/history?limit=1${
        cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
      }`;
      const res = await call({ method: 'GET', url, token: deskA.token });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: Array<{ id: string }>; nextCursor: string | null }>();
      seen.push(...body.items.map((h) => h.id));
      cursor = body.nextCursor;
    } while (cursor !== null);

    expect(seen.length).toBe(2);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('merge and unmerge (OP-001 §3.8, §14 AC-11)', () => {
  const survivor = { id: '', uhid: '' };
  const victim = { id: '', uhid: '' };
  let mergeId = '';

  beforeAll(async () => {
    const a = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: mrdA.token,
      payload: registration({
        firstName: 'Sundar',
        lastName: 'Pillai',
        mobile: '9845090001',
        dob: '1962-04-18',
        identifiers: [{ type: 'passport', value: 'Z1234567' }],
        contacts: [{ kind: 'emergency', name: 'Vasanthi', phone: '9845090003' }],
      }),
    });
    const aBody = a.json<{ id: string; uhid: string }>();
    survivor.id = aBody.id;
    survivor.uhid = aBody.uhid;

    const b = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: mrdA.token,
      reason: 'Legacy record from the paper register; merging under review',
      payload: registration({
        firstName: 'Sundar',
        lastName: 'Pillai',
        mobile: '9845090002',
        dob: '1962-04-18',
        identifiers: [{ type: 'old_mrn', value: 'MRN-88123' }],
        contacts: [{ kind: 'attendant', name: 'Ramesh', phone: '9845090004' }],
        overrideDuplicate: {
          acknowledgedPatientIds: [aBody.id],
          reason: 'Legacy record from the paper register; merging under review',
        },
      }),
    });
    expect(b.statusCode, b.body).toBe(201);
    const bBody = b.json<{ id: string; uhid: string }>();
    victim.id = bBody.id;
    victim.uhid = bBody.uhid;
  });

  it('refuses the merge to a role without patient.merge.execute', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients/merge',
      token: deskA.token,
      reason: 'Same patient',
      payload: { step: 'prepare', survivorId: survivor.id, victimId: victim.id, reason: 'Same patient' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses the merge without a reason, because the key is reason-required', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients/merge',
      token: mrdA.token,
      payload: { step: 'prepare', survivorId: survivor.id, victimId: victim.id, reason: 'Same patient' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toMatch(/reason is required/i);
  });

  it('step one previews the impact and snapshots both records without moving anything', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients/merge',
      token: mrdA.token,
      reason: 'Same person; the second record came from the paper register',
      payload: {
        step: 'prepare',
        survivorId: survivor.id,
        victimId: victim.id,
        reason: 'Same person; the second record came from the paper register',
        fieldChoices: { mobile: 'survivor' },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{
      mergeId: string;
      status: string;
      victimUhid: string;
      unmergeDeadline: string;
      impact: Array<{ table: string; rows: number }>;
    }>();
    mergeId = body.mergeId;

    expect(body.status).toBe('pending');
    expect(body.victimUhid).toBe(victim.uhid);
    expect(body.impact.find((i) => i.table === 'identifiers')?.rows).toBe(1);
    expect(body.impact.find((i) => i.table === 'contacts')?.rows).toBe(1);
    // 30 days, stored rather than computed at read time.
    const days = (Date.parse(body.unmergeDeadline) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);

    // Nothing has moved.
    const victimRow = await pg
      .pool('migrator')
      .query(`SELECT status::text AS s, merged_into_id FROM patient.patients WHERE id = $1`, [victim.id]);
    expect(victimRow.rows[0]).toMatchObject({ s: 'active', merged_into_id: null });

    const snapshots = await pg
      .pool('migrator')
      .query(`SELECT survivor_snapshot, victim_snapshot, field_choices FROM patient.merges WHERE id = $1`, [
        mergeId,
      ]);
    expect(snapshots.rows[0]?.victim_snapshot).toMatchObject({ uhid: victim.uhid });
    expect(snapshots.rows[0]?.field_choices).toMatchObject({ mobile: 'survivor' });
  });

  it('step two re-points, marks the victim, and announces both ids and the victim UHID', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients/merge',
      token: mrdA.token,
      reason: 'Confirmed after side-by-side comparison',
      payload: { step: 'commit', mergeId },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{ status: string; repointed: Array<{ table: string; rows: number }> }>();
    expect(body.status).toBe('completed');
    expect(body.repointed.find((r) => r.table === 'identifiers')?.rows).toBe(1);

    const traceId = res.headers['x-trace-id'];
    const audit = await auditRowsForTrace(traceId);
    // One audit row for the whole merge: it is one business fact, and a register
    // reporting two merges that never happened is as wrong as one reporting none.
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      entity: 'patient.merges',
      action: 'update',
      actor_user_id: mrdA.userId,
      patient_id: victim.id,
      business_key: `${survivor.uhid}<-${victim.uhid}`,
    });

    const events = await outboxRowsForTrace(traceId);
    expect(events).toHaveLength(1);
    expect(events[0]?.['event_type']).toBe('patient.merged');
    // Every module holding a patient_id has to re-point; the UHID travels too
    // for anything keyed on the printed identifier.
    expect(events[0]?.['payload']).toMatchObject({
      survivorId: survivor.id,
      victimId: victim.id,
      victimUhid: victim.uhid,
    });

    const victimRow = await pg
      .pool('migrator')
      .query(`SELECT status::text AS s, merged_into_id FROM patient.patients WHERE id = $1`, [victim.id]);
    expect(victimRow.rows[0]).toMatchObject({ s: 'merged', merged_into_id: survivor.id });

    const moved = await pg
      .pool('migrator')
      .query(`SELECT count(*)::int AS n FROM patient.identifiers WHERE patient_id = $1`, [survivor.id]);
    // The survivor's passport plus the victim's legacy MRN.
    expect(moved.rows[0]?.n).toBe(2);

    const repoints = await pg
      .pool('migrator')
      .query(
        `SELECT table_name, rows_repointed, row_ids, status FROM patient.merge_repoints WHERE merge_id = $1`,
        [mergeId],
      );
    // The individual row ids are what an unmerge replays in reverse; without
    // them the reversal would be a guess.
    const identifiers = repoints.rows.find((r) => r.table_name === 'identifiers');
    expect(identifiers?.status).toBe('applied');
    expect((identifiers?.row_ids as string[]).length).toBe(1);
  });

  it('keeps the victim UHID searchable and pointing at the survivor', async () => {
    // OP-001 §3.8: the losing UHID becomes an alias that redirects. A card
    // printed before the merge still has to work at the desk.
    const res = await call({
      method: 'GET',
      url: `/api/v1/patients?uhid=${encodeURIComponent(victim.uhid)}`,
      token: deskA.token,
    });
    expect(res.statusCode).toBe(200);
    const items = res.json<{ items: Array<{ id: string; status: string; merged_into_id: string }> }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: victim.id, status: 'merged', merged_into_id: survivor.id });
  });

  it('never reissues the victim UHID', async () => {
    const next = await call({
      method: 'POST',
      url: '/api/v1/patients',
      token: mrdA.token,
      payload: registration({ firstName: 'Later', lastName: 'Arrival', mobile: '9845090009' }),
    });
    expect(next.json<{ uhid: string }>().uhid).not.toBe(victim.uhid);
    const rows = await pg
      .pool('migrator')
      .query(`SELECT count(*)::int AS n FROM patient.patients WHERE uhid = $1`, [victim.uhid]);
    expect(rows.rows[0]?.n).toBe(1);
  });

  it('refuses to hard-delete the merged record — the grant does not exist', async () => {
    // The migration revokes DELETE on every table in the `patient` schema, so
    // even a compromised application role cannot remove a clinical record.
    const client = await pg.pool('app').connect();
    try {
      await expect(client.query(`DELETE FROM patient.patients WHERE id = $1`, [victim.id])).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      client.release();
    }
  });

  it('refuses to commit the same prepared merge twice', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients/merge',
      token: mrdA.token,
      reason: 'Replay',
      payload: { step: 'commit', mergeId },
    });
    expect(res.statusCode).toBe(409);
  });

  it('reverses the merge, restoring exactly the rows it moved', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients/unmerge',
      token: mrdA.token,
      reason: 'Two different men with the same name and birthday',
      payload: { mergeId, reason: 'Two different men with the same name and birthday' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<{ restored: Array<{ table: string; rows: number }> }>().restored).toEqual(
      expect.arrayContaining([
        { table: 'identifiers', rows: 1 },
        { table: 'contacts', rows: 1 },
      ]),
    );

    const traceId = res.headers['x-trace-id'];
    const audit = await auditRowsForTrace(traceId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.['after']).toMatchObject({ status: 'unmerged', victim_status: 'active' });

    const events = await outboxRowsForTrace(traceId);
    expect(events).toHaveLength(1);
    expect(events[0]?.['event_type']).toBe('patient.unmerged');

    const victimRow = await pg
      .pool('migrator')
      .query(`SELECT status::text AS s, merged_into_id FROM patient.patients WHERE id = $1`, [victim.id]);
    expect(victimRow.rows[0]).toMatchObject({ s: 'active', merged_into_id: null });

    const back = await pg
      .pool('migrator')
      .query<{ t: string }>(`SELECT type::text AS t FROM patient.identifiers WHERE patient_id = $1`, [
        victim.id,
      ]);
    expect(back.rows.map((r) => r.t)).toEqual(['old_mrn']);

    const survivorIdentifiers = await pg
      .pool('migrator')
      .query<{ t: string }>(`SELECT type::text AS t FROM patient.identifiers WHERE patient_id = $1`, [
        survivor.id,
      ]);
    expect(survivorIdentifiers.rows.map((r) => r.t)).toEqual(['passport']);

    const repoints = await pg
      .pool('migrator')
      .query<{ status: string }>(`SELECT DISTINCT status FROM patient.merge_repoints WHERE merge_id = $1`, [
        mergeId,
      ]);
    expect(repoints.rows.map((r) => r.status)).toEqual(['reversed']);
  });

  it('puts the pair back in the dedupe queue rather than marking it decided', async () => {
    const rows = await pg.pool('migrator').query(
      `SELECT status::text AS s, merge_id FROM patient.dedupe_candidates
          WHERE patient_a_id = LEAST($1::uuid,$2::uuid) AND patient_b_id = GREATEST($1::uuid,$2::uuid)`,
      [survivor.id, victim.id],
    );
    expect(rows.rows[0]).toMatchObject({ s: 'open', merge_id: null });
  });

  it('refuses to reverse a merge that is no longer completed', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients/unmerge',
      token: mrdA.token,
      reason: 'Replay',
      payload: { mergeId, reason: 'Replaying the reversal' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses a merge of a record into itself', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/patients/merge',
      token: mrdA.token,
      reason: 'Self merge probe',
      payload: {
        step: 'prepare',
        survivorId: survivor.id,
        victimId: survivor.id,
        reason: 'Self merge probe',
      },
    });
    expect(res.statusCode).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * The claim this module is built around, put to the planner rather than left in
 * a comment — and the one place the answer came back "no".
 *
 * `phase-01` §1.2 budgets 200 ms p95 across mobile / UHID / name / ABHA / ID on
 * a million patients, and `PatientSearchService` is shaped the way it is — one
 * mode, one predicate, one index — because a query that ORs the modes together
 * uses none of them. On the twenty rows the rest of this suite creates,
 * PostgreSQL quite reasonably scans whatever is cheapest and a plan proves
 * nothing, so this block first loads a **separate tenant** with thirty thousand
 * patients and `ANALYZE`s. (Separate on purpose: thirty thousand rows in
 * hospital A would turn the pagination test above into ten thousand pages.)
 *
 * What that showed is recorded below in two halves, because the two halves
 * disagree — see `docs/PROGRESS.md` and the report accompanying this module.
 */
describe('search predicates and the planner', () => {
  const BULK_ROWS = 30_000;
  /**
   * The bulk rows are named from `md5(g)` so that thirty thousand of them are
   * genuinely distinct to a trigram index. Named "Bulk PatientN" they were not:
   * every row shared almost every trigram, `%` matched all thirty thousand, and
   * a sequential scan was the *correct* plan — which would have made this test
   * pass for the wrong reason.
   */
  const BULK_G = 4242;
  const md5hex = (value: string): string => createHash('md5').update(value).digest('hex');
  const BULK_NAME = `${md5hex(String(BULK_G)).slice(0, 10)} ${md5hex(String(BULK_G * 7 + 1)).slice(0, 10)}`;
  let bulk: TenantFixture;

  beforeAll(async () => {
    bulk = await createTenantFixture(pg, { codePrefix: 'BULK' });
    const pool = pg.pool('migrator');

    await pool.query(
      `INSERT INTO patient.patients
         (id, hospital_id, branch_id, uhid, uhid_normalised,
          first_name, last_name, full_name, gender, dob, mobile, mobile_local,
          abha_number, abha_address, dedupe_fingerprint,
          status, registered_at, created_at, updated_at)
       SELECT gen_random_uuid(), $1, $2,
              'BULK' || lpad(g::text, 8, '0'), 'BULK' || lpad(g::text, 8, '0'),
              substr(md5(g::text), 1, 10), substr(md5((g * 7 + 1)::text), 1, 10),
              substr(md5(g::text), 1, 10) || ' ' || substr(md5((g * 7 + 1)::text), 1, 10),
              'male'::patient."PatientGender",
              DATE '1960-01-01' + (g % 18000),
              '+9170' || lpad((g % 100000000)::text, 8, '0'),
              '70' || lpad((g % 100000000)::text, 8, '0'),
              CASE WHEN g % 3 = 0 THEN '77-' || lpad((g % 10000)::text, 4, '0') || '-0000-0000' END,
              CASE WHEN g % 3 = 0 THEN 'bulk' || g || '@sbx' END,
              substr(md5(g::text) || md5((g + 1)::text), 1, 40),
              'active'::patient."PatientStatus", now(), now(), now()
         FROM generate_series(1, $3::int) AS g`,
      [bulk.hospitalA, bulk.branchA, BULK_ROWS],
    );

    await pool.query(
      `INSERT INTO patient.identifiers
         (id, hospital_id, patient_id, type, value_normalised, value_masked, source, updated_at)
       SELECT gen_random_uuid(), $1, p.id, 'passport'::patient."PatientIdentifierType",
              'BULKID' || lpad((row_number() OVER (ORDER BY p.uhid))::text, 8, '0'),
              '••••0000', 'import', now()
         FROM patient.patients p WHERE p.hospital_id = $1`,
      [bulk.hospitalA],
    );

    await pool.query('ANALYZE patient.patients');
    await pool.query('ANALYZE patient.identifiers');
  }, 300_000);

  /**
   * As `hms_app`, with the tenancy GUCs set — the plan a real request gets, with
   * the row-level-security predicate in it.
   */
  async function explainUnderRls(sql: string, values: readonly unknown[]): Promise<string> {
    const client = await pg.pool('app').connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.hospital_id', bulk.hospitalA]);
      await client.query('SELECT set_config($1, $2, true)', ['app.scope', 'branch']);
      await client.query('SELECT set_config($1, $2, true)', ['app.branch_ids', `{${bulk.branchA}}`]);
      const result = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, [...values]);
      await client.query('ROLLBACK');
      return result.rows.map((r) => r['QUERY PLAN']).join('\n');
    } finally {
      client.release();
    }
  }

  /**
   * As `hms_migrator`, which owns the schema and is therefore not subject to its
   * own policies. The same query with the tenant predicate written by hand — the
   * control, isolating the index from the policy.
   */
  async function explainWithoutRls(sql: string, values: readonly unknown[]): Promise<string> {
    const result = await pg
      .pool('migrator')
      .query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, [bulk.hospitalA, ...values]);
    return result.rows.map((r) => r['QUERY PLAN']).join('\n');
  }

  // ── the half that works: leakproof equality ────────────────────────────────
  /**
   * `=` is marked leakproof in `pg_proc`, so PostgreSQL is willing to evaluate
   * it *inside* the index scan, ahead of the row-level-security predicate. These
   * four modes therefore get exactly the index probe they were designed for,
   * under RLS, at thirty thousand rows.
   */
  const equalityCases: ReadonlyArray<[name: string, sql: string, values: unknown[], index: RegExp]> = [
    [
      'exact mobile',
      `SELECT id FROM patient.patients p WHERE p.mobile = $1`,
      ['+917000004242'],
      /patients_hospital_id_mobile_idx/,
    ],
    [
      'ABHA number',
      `SELECT id FROM patient.patients p WHERE p.abha_number IS NOT NULL AND p.abha_number = ANY($1::varchar[])`,
      [['77-0424-0000-0000']],
      /idx_patients_abha_number/,
    ],
    [
      'ABHA address',
      `SELECT id FROM patient.patients p WHERE p.abha_address IS NOT NULL AND p.abha_address = $1`,
      ['bulk4242@sbx'],
      /idx_patients_abha_address/,
    ],
    [
      'dedupe fingerprint',
      `SELECT id FROM patient.patients p WHERE p.dedupe_fingerprint = $1`,
      ['c4ca4238a0b923820dcc509a6f75849b1679091c'],
      /patients_hospital_id_dedupe_fingerprint_idx/,
    ],
  ];

  it.each(equalityCases)('%s is an index probe under RLS', async (_name, sql, values, index) => {
    const plan = await explainUnderRls(sql, values);
    expect(plan, plan).toMatch(index);
    expect(plan, plan).not.toMatch(/Seq Scan on patients/);
  });

  // ── the half that does not: pattern matching under RLS ─────────────────────
  /**
   * The finding, recorded as a test so it cannot be forgotten and so the day it
   * is fixed, this fails and gets rewritten as the stronger assertion.
   *
   * `~~` (LIKE) and `%` (pg_trgm similarity) are **not** leakproof. Under a
   * row-level-security policy PostgreSQL will not evaluate a non-leakproof
   * qualifier before the security qualifier — a leaky operator could otherwise
   * reveal, through an error or a timing difference, the contents of a row the
   * policy was about to hide. The consequence is mechanical: those predicates
   * cannot become index conditions, so `idx_patients_mobile_prefix`,
   * `idx_patients_uhid_prefix` and `idx_patients_name_trgm` are unreachable from
   * an application query, and the search falls back to a sequential scan of the
   * table.
   *
   * At thirty thousand rows that is milliseconds and invisible. At the three
   * million `OP-001` §13 plans for, it is the 200 ms p95 budget, missed by a
   * wide margin, on the busiest screen in the hospital.
   *
   * This is a property of the schema and the policy, not of this module: the
   * predicates below are the exact shapes the indexes were built for, and the
   * control immediately after proves they are reachable the moment the policy is
   * out of the way. Fixing it means changing something outside
   * `services/api/src/modules/opd/patient/` — the candidates are marking the
   * pattern operators `LEAKPROOF` (a deliberate, documented trade-off a
   * superuser must make), or restructuring the policy so the tenant predicate
   * folds to a constant at plan time.
   */
  const patternCases: ReadonlyArray<[name: string, sql: string, values: unknown[], index: RegExp]> = [
    [
      'mobile prefix',
      `SELECT id FROM patient.patients p WHERE p.hospital_id = $1 AND p.mobile_local LIKE $2`,
      ['700000424%'],
      /idx_patients_mobile_prefix/,
    ],
    [
      'UHID prefix',
      `SELECT id FROM patient.patients p WHERE p.hospital_id = $1 AND p.uhid_normalised LIKE $2`,
      ['BULK0000424%'],
      /idx_patients_uhid_prefix/,
    ],
    [
      'name trigram',
      `SELECT id FROM patient.patients p
        WHERE p.hospital_id = $1 AND p.full_name % $2 AND p.status = 'active' AND p.deleted_at IS NULL`,
      [BULK_NAME],
      /idx_patients_(active_)?name_trgm/,
    ],
  ];

  it.each(patternCases)(
    '%s reaches its index only when row-level security is out of the way',
    async (_name, sql, values, index) => {
      // The control: the index exists, and the predicate is the shape it serves.
      const control = await explainWithoutRls(sql, values);
      expect(control, control).toMatch(index);
      expect(control, control).not.toMatch(/Seq Scan on patients/);

      // The real request, with the same predicate: the index is unreachable.
      const underRls = await explainUnderRls(
        sql.replace('p.hospital_id = $1 AND ', '').replace(/\$2/g, '$1'),
        values,
      );
      expect(underRls, underRls).toMatch(/Seq Scan on patients/);
    },
  );

  /**
   * The identifier path degrades rather than collapsing, which is worth
   * distinguishing: the semi-join still enters `idx_identifiers_value_prefix`,
   * but only on its leading `hospital_id` column — the `LIKE` arrives as a
   * filter over every identifier the tenant owns instead of as a prefix range.
   */
  it('identifier search keeps its index but loses the prefix range under RLS', async () => {
    const plan = await explainUnderRls(
      `SELECT id FROM patient.patients p WHERE p.id IN (
         SELECT i.patient_id FROM patient.identifiers i
          WHERE i.deleted_at IS NULL AND i.value_normalised LIKE $1)`,
      ['BULKID00004242%'],
    );
    expect(plan, plan).toMatch(/idx_identifiers_value_prefix/);
    expect(plan, plan).not.toMatch(/Seq Scan on identifiers/);
  });

  /**
   * The counterfactual, and the reason `PatientSearchService` is a routing table
   * rather than one query.
   *
   * This is the query it refuses to write, planned with the policy out of the
   * way so the comparison is against the *best* case for the disjunction. Even
   * then the planner cannot serve it with the single index probe each mode gets
   * on its own: it either scans the table or unions three bitmaps and rechecks
   * every row that falls out.
   */
  it('shows why the modes are never combined: one OR and the single-index plan is gone', async () => {
    const plan = await explainWithoutRls(
      `SELECT id FROM patient.patients p
        WHERE p.hospital_id = $1
          AND (p.uhid_normalised LIKE $2 OR p.mobile = $3 OR p.full_name % $4)`,
      ['BULK0000424%', '+917000004242', BULK_NAME],
    );
    expect(plan, plan).toMatch(/Seq Scan on patients|BitmapOr/);
  });
});
