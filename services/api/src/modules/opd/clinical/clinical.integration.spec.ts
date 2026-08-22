import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { CLINICAL_CONTROLLERS, CLINICAL_PROVIDERS } from './clinical.module.js';
import { VitalsController } from './vitals.controller.js';

/**
 * OP-007 and OP-002, proved against a real PostgreSQL 17 with RLS on.
 *
 * The suite exists for the properties that cannot be checked by reading the
 * code, and that would each fail silently in production:
 *
 *  1. A role **without** the key gets 403 and the same request with the key
 *     succeeds — so the decorator is wired to a guard that actually runs.
 *  2. A **cross-tenant id returns 404, not 403** (`docs/09` §3.1 case 2). No
 *     query in this module carries a `hospital_id` predicate, so if isolation
 *     holds, row-level security is what is holding it.
 *  3. Every mutation leaves its audit row *and* its registered outbox event,
 *     both inside the transaction that made the change (EN-024 §5) — asserted
 *     by trace id, so a stray or missing write is caught.
 *  4. **An amendment creates a new version and leaves v1 intact**, with the
 *     hash chain still verifying (phase-02 exit gate 4).
 *  5. An out-of-band observation emits `vitals.abnormal` / `vitals.critical`,
 *     with the thresholds coming from the reference table rather than the code.
 *  6. **A per-kilogram dose with no recorded weight is refused** (exit gate 3).
 *  7. Cursor pages do not overlap and reach every row.
 *  8. Break-glass on a chart outside the care team is granted, recorded, and
 *     refused without a reason (OP-002 §14 AC-10).
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

/** The vitals nurse: records, reads and corrects observations. Never signs anything. */
const nurseA: Actor = { userId: newId(), roleId: newId(), username: 'vit-nurse-alpha', token: '' };
/** The consultant who owns the clinic: the whole consultation surface. */
const doctorA: Actor = { userId: newId(), roleId: newId(), username: 'vit-doctor-alpha', token: '' };
/** A doctor in the same hospital with no link to this patient: the break-glass case. */
const outsiderA: Actor = { userId: newId(), roleId: newId(), username: 'vit-outsider-alpha', token: '' };
/** Holds `patient.record.read` and nothing else: the 403 case. */
const clerkA: Actor = { userId: newId(), roleId: newId(), username: 'vit-clerk-alpha', token: '' };
/** The same consultant role, in the other hospital. */
const doctorB: Actor = { userId: newId(), roleId: newId(), username: 'vit-doctor-bravo', token: '' };

const NURSE_KEYS = [
  'vitals.record.create',
  'vitals.record.read',
  'vitals.record.correct',
  'vitals.configure',
];
const DOCTOR_KEYS = [
  'opd.encounter.create',
  'opd.encounter.read',
  'opd.encounter.update',
  'opd.encounter.sign',
  'opd.encounter.amend',
  'opd.diagnosis.update',
  'opd.allergy.update',
  'patient.record.read',
  'vitals.record.read',
  'vitals.record.create',
  'vitals.alert.acknowledge',
  'vitals.recheck.request',
];
const OUTSIDER_KEYS = ['opd.encounter.read', 'patient.record.read'];
const CLERK_KEYS = ['patient.record.read'];

/** Practitioner record keys, so care-team membership has something to match on. */
const practitionerA = newId();
const departmentA = newId();
const practitionerB = newId();
const departmentB = newId();

const patientA = newId();
const childA = newId();
const patientB = newId();
const visitA = newId();
const visitChild = newId();
const visitSecond = newId();
const visitB = newId();

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
     VALUES ($1, $2, $3, $4, 'Integration test role', 'clinical', 'clinical', now())`,
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

async function seedPractitioner(
  hospitalId: string,
  branchId: string,
  recordKey: string,
  departmentKey: string,
  userId: string,
  code: string,
): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO mdm.mdm_practitioners
       (id, record_key, hospital_id, branch_id, version, code, user_id, full_name, display_name,
        registration_council, registration_number, department_key, effective_from, status, updated_at)
     VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $7, 'NMC', $8, $9, now() - interval '1 year', 'active', now())`,
    [newId(), recordKey, hospitalId, branchId, code, userId, `Dr ${code}`, `NMC-${code}`, departmentKey],
  );
}

async function seedPatient(
  hospitalId: string,
  branchId: string,
  id: string,
  uhid: string,
  dob: string,
  gender: string,
): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO patient.patients
       (id, hospital_id, branch_id, uhid, uhid_normalised, first_name, last_name, full_name,
        gender, dob, mobile, mobile_local, dedupe_fingerprint, updated_at)
     VALUES ($1, $2, $3, $4, $4, $5, 'Test', $6, $7::patient."PatientGender", $8::date,
             $9, $10, $11, now())`,
    [
      id,
      hospitalId,
      branchId,
      uhid,
      uhid,
      `${uhid} Given`,
      gender,
      dob,
      `+9198450${uhid.slice(-5)}`,
      `98450${uhid.slice(-5)}`,
      newId().replace(/-/g, '').slice(0, 32),
    ],
  );
}

async function seedVisit(
  hospitalId: string,
  branchId: string,
  id: string,
  patientId: string,
  practitionerKey: string,
  departmentKey: string,
  visitNo: string,
  status = 'waiting_doctor',
): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO clinical.op_visits
       (id, hospital_id, branch_id, visit_no, patient_id, practitioner_key, department_key,
        status, vitals_required, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::clinical."VisitStatus", true, now())`,
    [id, hospitalId, branchId, visitNo, patientId, practitionerKey, departmentKey, status],
  );
}

/**
 * The reference bands for the test hospitals.
 *
 * Deliberately written here rather than relied on from the seed: the tenant
 * fixture creates fresh hospitals, so a suite that depended on seeded rows
 * would be testing the seed. These are the *shape* the seed writes — a normal
 * band with a critical band outside it — and every expectation in the suite is
 * derived from them.
 */
const RANGES: readonly (readonly [
  string,
  number,
  number,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  string,
])[] = [
  // parameter, ageMin, ageMax, lowAbn, highAbn, lowCrit, highCrit, lowPlaus, highPlaus, unit
  ['systolic', 6570, 43800, 100, 140, 90, 180, 60, 250, 'mmHg'],
  ['systolic', 0, 6569, 75, 110, 65, 120, 30, 200, 'mmHg'],
  ['diastolic', 6570, 43800, null, 90, 50, 110, 10, 200, 'mmHg'],
  ['pulse', 6570, 43800, 60, 100, 50, 120, 20, 300, '/min'],
  ['pulse', 0, 6569, 80, 140, 70, 160, 20, 300, '/min'],
  ['spo2', 0, 43800, 92, null, 88, null, 0, 100, '%'],
  ['temperature_c', 0, 43800, 36.1, 38.0, 35.0, 39.0, 30, 45, 'degC'],
  ['resp_rate', 6570, 43800, 12, 20, 8, 25, 4, 80, '/min'],
];

async function seedReferenceRanges(hospitalId: string): Promise<void> {
  const pool = pg.pool('migrator');
  for (const [parameter, ageMin, ageMax, lowAbn, highAbn, lowCrit, highCrit, lowP, highP, unit] of RANGES) {
    await pool.query(
      `INSERT INTO clinical.vitals_reference_ranges
         (id, hospital_id, parameter, age_min_days, age_max_days, sex, pregnancy, scale,
          low_abnormal, high_abnormal, low_critical, high_critical, low_plausible, high_plausible,
          unit, effective_from, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'any', NULL, NULL, $6, $7, $8, $9, $10, $11, $12,
               now() - interval '1 year', 'active', now())`,
      [newId(), hospitalId, parameter, ageMin, ageMax, lowAbn, highAbn, lowCrit, highCrit, lowP, highP, unit],
    );
  }
}

async function seedMrdConfiguration(hospitalId: string, branchId: string): Promise<void> {
  const pool = pg.pool('migrator');
  const rules: readonly (readonly [string, string, string, Record<string, unknown>, string])[] = [
    [
      'DX_PRESENT',
      'At least one diagnosis, or a recorded reason for none',
      'field_present',
      { table: 'clinical.encounter_diagnoses', orField: 'no_diagnosis_reason' },
      'doctor',
    ],
    [
      'NOTE_SIGNED',
      'The consultation note is signed',
      'document_signed',
      { documentType: 'consult_note' },
      'doctor',
    ],
    ['CODED', 'ICD coding complete', 'coded', { minStatus: 'coded' }, 'mrd_coder'],
  ];

  for (const [code, description, checkType, params, role] of rules) {
    await pool.query(
      `INSERT INTO clinical.mrd_deficiency_rules
         (id, hospital_id, encounter_kind, code, description, check_type, params, responsible_role,
          due_hours, active, updated_at)
       VALUES ($1, $2, 'op', $3, $4, $5::clinical."MrdDeficiencyCheckType", $6::jsonb, $7, 24, true, now())`,
      [newId(), hospitalId, code, description, checkType, JSON.stringify(params), role],
    );
  }

  await pool.query(
    `INSERT INTO core.numbering_series
       (id, hospital_id, branch_id, key, pattern, scope, fy, current_value, gapless,
        reset_policy, version, effective_from, active, created_at, updated_at)
     VALUES ($1, $2, $3, 'MRD', '{BR}-MRD-{SEQ:6}', 'branch', NULL, 0, false,
             'never', 1, now() - interval '1 day', true, now(), now())`,
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
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly token: string;
  readonly reason?: string;
  readonly idempotencyKey?: string;
  readonly payload?: Record<string, unknown>;
}

async function call(options: CallOptions) {
  const headers: Record<string, string> = { authorization: `Bearer ${options.token}` };
  if (options.reason !== undefined) headers['x-reason'] = options.reason;
  // Routes marked `@Idempotent()` refuse a POST with no key. A fresh key per
  // call keeps each one a distinct submission; a test about replay passes the
  // same key twice deliberately.
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

async function auditRowsForTrace(traceId: unknown): Promise<Array<Record<string, unknown>>> {
  const result = await pg.pool('migrator').query(
    `SELECT id, actor_user_id, entity, action::text AS action, row_id, patient_id, encounter_id,
            reason_text, before, after, data_class::text AS data_class, artifact_sha256
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

/**
 * The root under test.
 *
 * Phase 1's suites can say `@Module({ imports: [AppModule] })` and stop,
 * because `AppModule` spreads their controllers into its own arrays. This
 * module is not wired there yet — `clinical.module.ts` exports
 * `CLINICAL_CONTROLLERS` / `CLINICAL_PROVIDERS` for whoever wires it — so the
 * root has to declare them itself *until* that happens, and must stop declaring
 * them the moment it does. Declaring them twice mounts every route twice and
 * Fastify refuses with `FST_ERR_DUPLICATED_ROUTE` before a single test runs.
 *
 * So the root asks `AppModule` what it already declares and adds only what is
 * missing. Once the arrays are spread into `app.module.ts`, this collapses to
 * `imports: [AppModule]` on its own with no edit here.
 *
 * `NumberingService` is added alongside because `AppModule` provides but does
 * not *export* it, and `MrdService` needs it for the `MRD` series. It is
 * stateless and allocates inside the caller's transaction, so a second instance
 * is not a shared-state hazard — the same reasoning `scheduling.module.ts`
 * records.
 */
const APP_CONTROLLERS = (Reflect.getMetadata('controllers', AppModule) as unknown[] | undefined) ?? [];
const CLINICAL_ALREADY_WIRED = APP_CONTROLLERS.includes(VitalsController);

@Module(
  CLINICAL_ALREADY_WIRED
    ? { imports: [AppModule] }
    : {
        imports: [AppModule],
        controllers: CLINICAL_CONTROLLERS,
        providers: [...CLINICAL_PROVIDERS, NumberingService],
      },
)
class TestRootModule {}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'CLN' });
  await syncPermissionCatalogue();

  await seedPractitioner(
    tenants.hospitalA,
    tenants.branchA,
    practitionerA,
    departmentA,
    doctorA.userId,
    'DRA',
  );
  await seedPractitioner(
    tenants.hospitalB,
    tenants.branchB,
    practitionerB,
    departmentB,
    doctorB.userId,
    'DRB',
  );

  const fiveYearsAgo = new Date(Date.now() - 5 * 365 * 86_400_000).toISOString().slice(0, 10);
  await seedPatient(tenants.hospitalA, tenants.branchA, patientA, 'CLNA00001', '1988-03-04', 'female');
  await seedPatient(tenants.hospitalA, tenants.branchA, childA, 'CLNA00002', fiveYearsAgo, 'male');
  await seedPatient(tenants.hospitalB, tenants.branchB, patientB, 'CLNB00001', '1990-06-06', 'male');

  await seedVisit(
    tenants.hospitalA,
    tenants.branchA,
    visitA,
    patientA,
    practitionerA,
    departmentA,
    'CLNA-V1',
  );
  await seedVisit(
    tenants.hospitalA,
    tenants.branchA,
    visitChild,
    childA,
    practitionerA,
    departmentA,
    'CLNA-V2',
  );
  await seedVisit(
    tenants.hospitalA,
    tenants.branchA,
    visitSecond,
    patientA,
    practitionerA,
    departmentA,
    'CLNA-V3',
  );
  await seedVisit(
    tenants.hospitalB,
    tenants.branchB,
    visitB,
    patientB,
    practitionerB,
    departmentB,
    'CLNB-V1',
  );

  await seedReferenceRanges(tenants.hospitalA);
  await seedReferenceRanges(tenants.hospitalB);
  await seedMrdConfiguration(tenants.hospitalA, tenants.branchA);

  await seedActor(tenants.hospitalA, tenants.branchA, nurseA, NURSE_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, doctorA, DOCTOR_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, outsiderA, OUTSIDER_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, clerkA, CLERK_KEYS);
  await seedActor(tenants.hospitalB, tenants.branchB, doctorB, DOCTOR_KEYS);

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

  nurseA.token = await login(tenants.hospitalA, nurseA.username);
  doctorA.token = await login(tenants.hospitalA, doctorA.username);
  outsiderA.token = await login(tenants.hospitalA, outsiderA.username);
  clerkA.token = await login(tenants.hospitalA, clerkA.username);
  doctorB.token = await login(tenants.hospitalB, doctorB.username);
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('vitals — permission, flagging and alerts', () => {
  const normal = { id: '', recordedAt: '' };
  const abnormal = { id: '', alertId: '' };

  it('refuses a nurse-less role and accepts the nurse', async () => {
    const denied = await call({
      method: 'POST',
      url: '/api/v1/vitals/records',
      token: clerkA.token,
      payload: { patientId: patientA, visitId: visitA, systolic: 120, diastolic: 80 },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await call({
      method: 'POST',
      url: '/api/v1/vitals/records',
      token: nurseA.token,
      payload: {
        patientId: patientA,
        visitId: visitA,
        systolic: 120,
        diastolic: 80,
        pulse: 76,
        spo2: 98,
        temperatureC: 36.8,
        respRate: 16,
        heightCm: 160,
        weightKg: 58,
        avpu: 'alert',
        assessment: { allergiesVerified: true, chiefComplaintText: 'Cough for three days' },
      },
    });

    expect(allowed.statusCode, allowed.body).toBe(201);
    const body = allowed.json<{
      id: string;
      recorded_at: string;
      overall_flag: string;
      bmi: string;
      news2_score: number;
      news2_band: string;
      alerts: unknown[];
    }>();

    normal.id = body.id;
    normal.recordedAt = body.recorded_at;

    expect(body.overall_flag).toBe('normal');
    expect(body.alerts).toHaveLength(0);
    // BMI is derived, never accepted: 58 / 1.6² = 22.66.
    expect(Number(body.bmi)).toBeCloseTo(22.66, 2);
    expect(body.news2_score).toBe(0);
    expect(body.news2_band).toBe('low');
  });

  it('writes one audit row and its registered event, in the same transaction', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/vitals/records',
      token: nurseA.token,
      payload: { patientId: patientA, visitId: visitA, systolic: 118, diastolic: 78, pulse: 72 },
    });
    expect(res.statusCode, res.body).toBe(201);

    const audits = await auditRowsForTrace(res.headers['x-trace-id']);
    const inserts = audits.filter((row) => row['entity'] === 'clinical.vitals' && row['action'] === 'insert');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.['patient_id']).toBe(patientA);
    expect(inserts[0]?.['data_class']).toBe('phi');

    const events = await outboxRowsForTrace(res.headers['x-trace-id']);
    expect(events.map((e) => e['event_type'])).toEqual(['vitals.recorded']);
    expect(events[0]?.['contains_phi']).toBe(true);
    // The registry's retention for `vitals.recorded` is 90 days, not the 7-day
    // default — proof the event was built from the registry and not by hand.
    expect(events[0]?.['retention_days']).toBe(90);
  });

  it('flags an out-of-band reading from the reference table and raises an alert', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/vitals/records',
      token: nurseA.token,
      payload: {
        patientId: patientA,
        visitId: visitA,
        systolic: 160,
        diastolic: 84,
        pulse: 76,
        spo2: 97,
      },
    });

    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{
      id: string;
      overall_flag: string;
      flags: Record<string, string>;
      alerts: { id: string; level: string; parameters: string[] }[];
    }>();

    abnormal.id = body.id;
    abnormal.alertId = body.alerts[0]?.id ?? '';

    // 160 is outside the configured normal band (100–140) and inside the
    // critical one (90–180): abnormal, not critical.
    expect(body.overall_flag).toBe('abnormal');
    expect(body.flags['systolic']).toBe('abnormal');
    expect(body.flags['pulse']).toBe('normal');
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0]?.level).toBe('abnormal');
    expect(body.alerts[0]?.parameters).toContain('systolic');

    const events = await outboxRowsForTrace(res.headers['x-trace-id']);
    const types = events.map((e) => e['event_type']);
    expect(types).toContain('vitals.abnormal');
    expect(types).toContain('vitals.recorded');

    const alertEvent = events.find((e) => e['event_type'] === 'vitals.abnormal');
    const payload = alertEvent?.['payload'] as { parameters: string[]; patientId: string };
    expect(payload.parameters).toContain('systolic');
    expect(payload.patientId).toBe(patientA);

    const alertAudit = (await auditRowsForTrace(res.headers['x-trace-id'])).filter(
      (row) => row['entity'] === 'clinical.vitals_alerts',
    );
    expect(alertAudit).toHaveLength(1);
  });

  it('escalates to critical past the critical bound, and only past it', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/vitals/records',
      token: nurseA.token,
      payload: { patientId: patientA, visitId: visitA, systolic: 190, diastolic: 100, pulse: 96 },
    });
    expect(res.statusCode, res.body).toBe(201);

    const body = res.json<{ overall_flag: string; alerts: { level: string }[] }>();
    expect(body.overall_flag).toBe('critical');
    expect(body.alerts[0]?.level).toBe('critical');

    const types = (await outboxRowsForTrace(res.headers['x-trace-id'])).map((e) => e['event_type']);
    expect(types).toContain('vitals.critical');
    expect(types).not.toContain('vitals.abnormal');
  });

  it('uses the paediatric band for a child, so an adult-normal value flags', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/vitals/records',
      token: nurseA.token,
      payload: { patientId: childA, visitId: visitChild, pulse: 130, systolic: 100 },
    });
    expect(res.statusCode, res.body).toBe(201);

    // 130 /min is critical on the adult band (>120) and normal on the 0–18 band
    // (80–140). The row the evaluator picked is the one that matters.
    const body = res.json<{ overall_flag: string; flags: Record<string, string> }>();
    expect(body.flags['pulse']).toBe('normal');
    expect(body.overall_flag).toBe('normal');
  });

  it('refuses an implausible value against the configured bound, not a compiled-in one', async () => {
    // 280 mmHg is inside the storage CHECK (40–300) and inside the request
    // schema, and outside the *configured* plausible band for this hospital
    // (60–250). Only a check that read the row could refuse it.
    const res = await call({
      method: 'POST',
      url: '/api/v1/vitals/records',
      token: nurseA.token,
      payload: { patientId: patientA, visitId: visitA, systolic: 280, diastolic: 120 },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain('systolic');
    expect(res.body).toContain('60–250');
  });

  it('refuses a diastolic above the systolic, which the database also refuses', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/vitals/records',
      token: nurseA.token,
      payload: { patientId: patientA, visitId: visitA, systolic: 80, diastolic: 95 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('Diastolic');
  });

  it('lets the doctor acknowledge the alert once, and only once', async () => {
    const first = await call({
      method: 'POST',
      url: `/api/v1/vitals/records/${abnormal.id}/alerts/${abnormal.alertId}/ack`,
      token: doctorA.token,
      payload: { actionTaken: 'repeat', note: 'Repeat in five minutes' },
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json<{ action_taken: string }>().action_taken).toBe('repeat');

    const events = await outboxRowsForTrace(first.headers['x-trace-id']);
    expect(events.map((e) => e['event_type'])).toContain('vitals.alert.acknowledged');

    const second = await call({
      method: 'POST',
      url: `/api/v1/vitals/records/${abnormal.id}/alerts/${abnormal.alertId}/ack`,
      token: doctorA.token,
      payload: { actionTaken: 'doctor_informed' },
    });
    expect(second.statusCode).toBe(409);
  });

  it('corrects a reading by writing a new version and leaving the original readable', async () => {
    const withoutHeader = await call({
      method: 'PATCH',
      url: `/api/v1/vitals/records/${normal.id}`,
      token: nurseA.token,
      payload: { reason: 'Cuff was on the wrong arm; re-measured', systolic: 128 },
    });
    // `vitals.record.correct` is `requiresReason` in the catalogue, so the
    // policy guard demands the header before the handler is even reached.
    expect(withoutHeader.statusCode).toBe(403);

    const res = await call({
      method: 'PATCH',
      url: `/api/v1/vitals/records/${normal.id}`,
      token: nurseA.token,
      reason: 'Cuff was on the wrong arm; re-measured',
      payload: { reason: 'Cuff was on the wrong arm; re-measured', systolic: 128, diastolic: 82, pulse: 76 },
    });
    expect(res.statusCode, res.body).toBe(200);

    const correction = res.json<{ id: string; corrects_id: string; corrected_reason: string }>();
    expect(correction.corrects_id).toBe(normal.id);
    expect(correction.corrected_reason).toContain('wrong arm');
    expect(correction.id).not.toBe(normal.id);

    const original = await call({
      method: 'GET',
      url: `/api/v1/vitals/records/${normal.id}`,
      token: nurseA.token,
    });
    expect(original.statusCode).toBe(200);
    const originalBody = original.json<{ systolic: number; superseded_at: string | null }>();
    expect(originalBody.systolic).toBe(120);
    expect(originalBody.superseded_at).not.toBeNull();
  });

  it('returns 404, not 403, for another hospital’s observation set', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/vitals/records/${normal.id}`,
      token: doctorB.token,
    });
    expect(res.statusCode).toBe(404);
  });

  it('pages the trend without overlapping or dropping a row', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;

    do {
      const url =
        `/api/v1/vitals/records?patient=${patientA}&limit=2` +
        (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`);
      const res = await call({ method: 'GET', url, token: nurseA.token });
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json<{ items: { id: string }[]; nextCursor: string | null }>();
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      guard += 1;
    } while (cursor !== null && guard < 20);

    expect(new Set(seen).size).toBe(seen.length);
    const total = await pg
      .pool('migrator')
      .query(`SELECT count(*)::int AS n FROM clinical.vitals WHERE patient_id = $1`, [patientA]);
    expect(seen.length).toBe(total.rows[0].n);
  });

  it('refuses an unbounded trend query', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/vitals/records', token: nurseA.token });
    expect(res.statusCode).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('encounter — lifecycle, diagnosis and the signed note', () => {
  const encounter = { id: '', documentId: '', v1Hash: '' };

  it('refuses to start without the key and starts with it', async () => {
    const denied = await call({
      method: 'POST',
      url: '/api/v1/encounters',
      token: clerkA.token,
      payload: { visitId: visitA },
    });
    expect(denied.statusCode).toBe(403);

    const res = await call({
      method: 'POST',
      url: '/api/v1/encounters',
      token: doctorA.token,
      payload: { visitId: visitA },
    });
    expect(res.statusCode, res.body).toBe(201);

    const body = res.json<{ id: string; status: string; note_status: string; note_version: number }>();
    encounter.id = body.id;
    expect(body.status).toBe('in_progress');
    // The note draft exists from the first keystroke, not from the first save.
    expect(body.note_status).toBe('draft');
    expect(body.note_version).toBe(1);

    const audits = await auditRowsForTrace(res.headers['x-trace-id']);
    expect(
      audits.filter((row) => row['entity'] === 'clinical.encounters' && row['action'] === 'insert'),
    ).toHaveLength(1);
    expect(audits.filter((row) => row['entity'] === 'clinical.mrd_records')).toHaveLength(1);

    const events = (await outboxRowsForTrace(res.headers['x-trace-id'])).map((e) => e['event_type']);
    expect(events).toContain('visit.consult.started');
    expect(events).toContain('mrd.record.opened');

    // OP-001's visit moves in the same transaction, so the queue card cannot
    // still read "waiting" while the doctor is consulting.
    const visit = await pg
      .pool('migrator')
      .query(`SELECT status::text AS status FROM clinical.op_visits WHERE id = $1`, [visitA]);
    expect(visit.rows[0].status).toBe('in_consult');
  });

  it('refuses a second consultation on the same visit', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/encounters',
      token: doctorA.token,
      payload: { visitId: visitA },
    });
    expect(res.statusCode).toBe(409);
  });

  it('returns 404, not 403, for another hospital’s encounter', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/encounters/${encounter.id}`,
      token: doctorB.token,
    });
    expect(res.statusCode).toBe(404);
  });

  it('autosaves the note and refuses a stale version', async () => {
    const current = await call({
      method: 'GET',
      url: `/api/v1/encounters/${encounter.id}`,
      token: doctorA.token,
    });
    const version = current.json<{ version: number }>().version;

    const res = await call({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      token: doctorA.token,
      payload: {
        version,
        chiefComplaintText: 'Cough and fever for three days',
        note: { history: 'No comorbidity', examination: { chest: 'Clear' } },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ note: { history: string } }>().note.history).toBe('No comorbidity');

    const stale = await call({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      token: doctorA.token,
      payload: { version, chiefComplaintText: 'Overwritten' },
    });
    expect(stale.statusCode).toBe(409);
  });

  it('blocks completion with no diagnosis and no stated reason', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/complete`,
      token: doctorA.token,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('diagnosis');
  });

  it('records diagnoses, promotes the problem list and announces them', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/diagnoses`,
      token: doctorA.token,
      payload: {
        diagnoses: [
          {
            codeSystemKey: 'ICD10',
            code: 'J06.9',
            description: 'Acute upper respiratory infection, unspecified',
            rank: 'primary',
            certainty: 'confirmed',
          },
          {
            codeSystemKey: 'ICD10',
            code: 'E11.9',
            description: 'Type 2 diabetes mellitus without complications',
            rank: 'secondary',
            certainty: 'chronic',
            isChronic: true,
          },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<{ diagnoses: unknown[] }>().diagnoses).toHaveLength(2);

    const events = await outboxRowsForTrace(res.headers['x-trace-id']);
    const recorded = events.find((e) => e['event_type'] === 'diagnosis.recorded');
    expect(recorded).toBeDefined();
    const payload = recorded?.['payload'] as { codes: { code: string; system: string }[] };
    expect(payload.codes.map((c) => c.code).sort()).toEqual(['E11.9', 'J06.9']);
    expect(payload.codes[0]?.system).toBe('icd10');

    const problems = await call({
      method: 'GET',
      url: `/api/v1/patients/${patientA}/problems`,
      token: doctorA.token,
    });
    expect(problems.statusCode).toBe(200);
    expect(
      problems
        .json<{ code: string }[]>()
        .map((p) => p.code)
        .sort(),
    ).toEqual(['E11.9', 'J06.9']);
  });

  it('refuses two primary diagnoses in one request', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/diagnoses`,
      token: doctorA.token,
      payload: {
        diagnoses: [
          { codeSystemKey: 'ICD10', code: 'A00', description: 'Cholera', rank: 'primary' },
          { codeSystemKey: 'ICD10', code: 'A01', description: 'Typhoid', rank: 'primary' },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('completes, signs the note, closes the visit and opens the MRD deficiencies', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/complete`,
      token: doctorA.token,
      payload: {
        note: { history: 'No comorbidity', examination: { chest: 'Clear' }, plan: 'Symptomatic' },
        signMethod: 'system',
      },
    });
    expect(res.statusCode, res.body).toBe(201);

    const body = res.json<{
      status: string;
      note_status: string;
      note_version: number;
      note_document_id: string;
    }>();
    encounter.documentId = body.note_document_id;
    expect(body.status).toBe('completed');
    expect(body.note_status).toBe('final');
    expect(body.note_version).toBe(1);

    const events = (await outboxRowsForTrace(res.headers['x-trace-id'])).map((e) => e['event_type']);
    expect(events).toContain('visit.consult.completed');
    expect(events).toContain('mrd.deficiency.raised');

    const audits = await auditRowsForTrace(res.headers['x-trace-id']);
    const signature = audits.find((row) => row['action'] === 'sign');
    expect(signature).toBeDefined();
    expect(String(signature?.['artifact_sha256'])).toMatch(/^[0-9a-f]{64}$/);
    // The signer's registration is captured at signing time, from the master.
    expect(JSON.stringify(signature?.['after'])).toContain('NMC-DRA');

    const visit = await pg
      .pool('migrator')
      .query(`SELECT status::text AS status FROM clinical.op_visits WHERE id = $1`, [visitA]);
    expect(visit.rows[0].status).toBe('consult_done');

    // NC-003: coding has not happened, so the record is deficient rather than
    // complete — and says which rule is outstanding.
    const record = await pg.pool('migrator').query(
      `SELECT r.status::text AS status, r.completeness_pct, r.mrd_no,
              array_agg(f.code) FILTER (WHERE d.status = 'open') AS open_codes
         FROM clinical.mrd_records r
         LEFT JOIN clinical.mrd_deficiencies d ON d.record_id = r.id
         LEFT JOIN clinical.mrd_deficiency_rules f ON f.id = d.rule_id
        WHERE r.encounter_ref = $1
        GROUP BY r.id`,
      [encounter.id],
    );
    expect(record.rows[0].status).toBe('deficient');
    expect(record.rows[0].open_codes).toEqual(['CODED']);
    expect(String(record.rows[0].mrd_no)).toContain('MRD');
  });

  it('refuses to edit a signed note', async () => {
    const res = await call({
      method: 'PATCH',
      url: `/api/v1/encounters/${encounter.id}`,
      token: doctorA.token,
      payload: { version: 99, note: { history: 'rewritten' } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('amendment');
  });

  it('amends into a new version, leaves v1 intact, and the chain still verifies', async () => {
    const before = await call({
      method: 'GET',
      url: `/api/v1/encounters/${encounter.id}/note-versions`,
      token: doctorA.token,
    });
    expect(before.statusCode, before.body).toBe(200);
    const beforeBody = before.json<{
      versions: { version: number; status: string; content_sha256: string; content: unknown }[];
      chain: { valid: boolean };
    }>();
    expect(beforeBody.versions).toHaveLength(1);
    expect(beforeBody.chain.valid).toBe(true);
    encounter.v1Hash = beforeBody.versions[0]!.content_sha256;

    const denied = await call({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/amend`,
      token: doctorA.token,
      payload: { reason: 'Chest findings were transcribed wrongly', note: { history: 'x' } },
    });
    // `opd.encounter.amend` is `requiresReason` in the catalogue: the policy
    // guard demands the header before the handler is even reached.
    expect(denied.statusCode).toBe(403);

    const res = await call({
      method: 'POST',
      url: `/api/v1/encounters/${encounter.id}/amend`,
      token: doctorA.token,
      reason: 'Chest findings were transcribed wrongly',
      payload: {
        reason: 'Chest findings were transcribed wrongly',
        note: {
          history: 'No comorbidity',
          examination: { chest: 'Crepitations at right base' },
          plan: 'Symptomatic',
        },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<{ status: string; note_version: number }>().note_version).toBe(2);

    const after = await call({
      method: 'GET',
      url: `/api/v1/encounters/${encounter.id}/note-versions`,
      token: doctorA.token,
    });
    const afterBody = after.json<{
      versions: {
        version: number;
        status: string;
        content_sha256: string;
        prev_sha256: string | null;
        amendment_reason: string | null;
        content: { examination?: { chest?: string } };
      }[];
      chain: { valid: boolean; versions: { hash_matches: boolean; link_matches: boolean }[] };
    }>();

    expect(afterBody.versions).toHaveLength(2);
    const [v1, v2] = afterBody.versions;

    // v1 is untouched: same content, same digest, and still signed.
    expect(v1?.content_sha256).toBe(encounter.v1Hash);
    expect(v1?.content.examination?.chest).toBe('Clear');
    expect(v1?.status).toBe('amended');

    // v2 carries the correction, its reason, and a link back to v1.
    expect(v2?.version).toBe(2);
    expect(v2?.status).toBe('final');
    expect(v2?.amendment_reason).toContain('transcribed wrongly');
    expect(v2?.prev_sha256).toBe(encounter.v1Hash);
    expect(v2?.content.examination?.chest).toBe('Crepitations at right base');

    // The database re-derives every digest and re-walks every link.
    expect(afterBody.chain.valid).toBe(true);
    expect(afterBody.chain.versions.every((row) => row.hash_matches && row.link_matches)).toBe(true);
  });

  it('refuses to update a signed version even when the database is asked directly', async () => {
    // The guarantee is the trigger's, not the service's. If it were only the
    // service's, this would succeed.
    await expect(
      pg.pool('migrator').query(
        `UPDATE clinical.document_versions SET content = '{"tampered":true}'::jsonb
            WHERE document_id = $1 AND version = 1`,
        [encounter.documentId],
      ),
    ).rejects.toThrow(/immutable/i);

    await expect(
      pg
        .pool('migrator')
        .query(`DELETE FROM clinical.document_versions WHERE document_id = $1 AND version = 1`, [
          encounter.documentId,
        ]),
    ).rejects.toThrow(/append-only/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the paediatric weight hard stop', () => {
  const child = { encounterId: '', vitalsWithWeight: '', vitalsWithoutWeight: '' };

  it('starts a consultation for the child', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/encounters',
      token: doctorA.token,
      payload: { visitId: visitChild },
    });
    expect(res.statusCode, res.body).toBe(201);
    child.encounterId = res.json<{ id: string; dosing_weight_source: string }>().id;
    // The default is `unknown`, and `unknown` is what blocks weight-based dosing.
    expect(res.json<{ dosing_weight_source: string }>().dosing_weight_source).toBe('unknown');
  });

  it('refuses a per-kilogram dose while the weight is unknown', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/encounters/${child.encounterId}/dosing-weight/check`,
      token: doctorA.token,
      payload: { mgPerKg: 15, drugLabel: 'Paracetamol suspension' },
    });

    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('clinical-hard-stop');
    expect(res.body).toContain('no recorded weight');
  });

  it('refuses to take a measured weight from an observation set that has none', async () => {
    const noWeight = await call({
      method: 'POST',
      url: '/api/v1/vitals/records',
      token: nurseA.token,
      payload: { patientId: childA, visitId: visitChild, pulse: 100, spo2: 98 },
    });
    expect(noWeight.statusCode).toBe(201);
    child.vitalsWithoutWeight = noWeight.json<{ id: string }>().id;

    const res = await call({
      method: 'POST',
      url: `/api/v1/encounters/${child.encounterId}/dosing-weight`,
      token: doctorA.token,
      payload: { source: 'measured', vitalsId: child.vitalsWithoutWeight },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('no weight');
  });

  it('accepts a measured weight from an observation set that has one, and then computes the dose', async () => {
    const weighed = await call({
      method: 'POST',
      url: '/api/v1/vitals/records',
      token: nurseA.token,
      payload: { patientId: childA, visitId: visitChild, weightKg: 18.4, heightCm: 108 },
    });
    expect(weighed.statusCode, weighed.body).toBe(201);
    child.vitalsWithWeight = weighed.json<{ id: string }>().id;

    const set = await call({
      method: 'POST',
      url: `/api/v1/encounters/${child.encounterId}/dosing-weight`,
      token: doctorA.token,
      payload: { source: 'measured', vitalsId: child.vitalsWithWeight },
    });
    expect(set.statusCode, set.body).toBe(201);
    const detail = set.json<{
      dosing_weight_kg: string;
      dosing_weight_source: string;
      dosing_weight_vitals_id: string;
      dosing_weight_by: string;
    }>();
    expect(Number(detail.dosing_weight_kg)).toBe(18.4);
    expect(detail.dosing_weight_source).toBe('measured');
    // Never a weight without its asserter and its instant.
    expect(detail.dosing_weight_vitals_id).toBe(child.vitalsWithWeight);
    expect(detail.dosing_weight_by).toBe(doctorA.userId);

    const check = await call({
      method: 'POST',
      url: `/api/v1/encounters/${child.encounterId}/dosing-weight/check`,
      token: doctorA.token,
      payload: { mgPerKg: 15, drugLabel: 'Paracetamol suspension' },
    });
    expect(check.statusCode, check.body).toBe(201);
    expect(check.json<{ doseMg: number }>().doseMg).toBe(276);
  });

  it('refuses a weight the database calls implausible', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/encounters/${child.encounterId}/dosing-weight`,
      token: doctorA.token,
      payload: { source: 'stated', weightKg: 0.2 },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('allergies, timeline and break-glass', () => {
  it('records an allergy and announces the fact the hard stop evaluates against', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/patients/${patientA}/allergies`,
      token: doctorA.token,
      payload: {
        category: 'drug',
        substanceText: 'Penicillin',
        substanceCode: 'PEN',
        reaction: ['rash', 'angioedema'],
        severity: 'anaphylaxis',
        criticality: 'high',
        verification: 'confirmed',
      },
    });

    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<{ severity: string }>().severity).toBe('anaphylaxis');

    const events = await outboxRowsForTrace(res.headers['x-trace-id']);
    const recorded = events.find((e) => e['event_type'] === 'allergy.recorded');
    expect(recorded).toBeDefined();
    const payload = recorded?.['payload'] as { substanceType: string; severity: string };
    expect(payload.substanceType).toBe('drug');
    expect(payload.severity).toBe('anaphylaxis');

    // The four-arm statement on the patient is promoted by the database trigger,
    // so the banner can never say "no allergies" over a populated list.
    const patient = await pg
      .pool('migrator')
      .query(`SELECT allergy_statement::text AS s FROM patient.patients WHERE id = $1`, [patientA]);
    expect(patient.rows[0].s).toBe('known');
  });

  it('returns a timeline spanning every source, newest first', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/patients/${patientA}/timeline?limit=50`,
      token: doctorA.token,
    });
    expect(res.statusCode, res.body).toBe(200);

    const items = res.json<{ items: { kind: string; occurred_at: string }[] }>().items;
    const kinds = new Set(items.map((item) => item.kind));
    expect(kinds).toContain('vitals');
    expect(kinds).toContain('encounter');
    expect(kinds).toContain('diagnosis');
    expect(kinds).toContain('document');
    expect(kinds).toContain('visit');
    expect(kinds).toContain('allergy');

    const times = items.map((item) => Date.parse(item.occurred_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('filters the timeline to the requested sources', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/patients/${patientA}/timeline?types=vitals&limit=5`,
      token: doctorA.token,
    });
    expect(res.statusCode).toBe(200);
    expect(new Set(res.json<{ items: { kind: string }[] }>().items.map((i) => i.kind))).toEqual(
      new Set(['vitals']),
    );
  });

  it('pages the timeline without overlapping', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;

    do {
      const url =
        `/api/v1/patients/${patientA}/timeline?limit=3` +
        (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`);
      const res = await call({ method: 'GET', url, token: doctorA.token });
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json<{ items: { id: string }[]; nextCursor: string | null }>();
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      guard += 1;
    } while (cursor !== null && guard < 30);

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThan(6);
  });

  it('demands a reason from a clinician outside the care team, then records the break-glass', async () => {
    const refused = await call({
      method: 'GET',
      url: `/api/v1/patients/${patientA}/timeline?limit=5`,
      token: outsiderA.token,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain('break-glass');

    const granted = await call({
      method: 'GET',
      url: `/api/v1/patients/${patientA}/timeline?limit=5`,
      token: outsiderA.token,
      reason: 'Covering the clinic; patient collapsed in the corridor',
    });
    expect(granted.statusCode, granted.body).toBe(200);

    const audits = await auditRowsForTrace(granted.headers['x-trace-id']);
    const breakGlass = audits.filter((row) => row['action'] === 'break_glass');
    expect(breakGlass).toHaveLength(1);
    expect(String(breakGlass[0]?.['reason_text'])).toContain('collapsed');

    const events = (await outboxRowsForTrace(granted.headers['x-trace-id'])).map((e) => e['event_type']);
    expect(events).toContain('encounter.break_glass');
  });

  it('does not ask the treating doctor for a reason', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/patients/${patientA}/timeline?limit=5`,
      token: doctorA.token,
    });
    expect(res.statusCode).toBe(200);
    const audits = await auditRowsForTrace(res.headers['x-trace-id']);
    expect(audits.filter((row) => row['action'] === 'break_glass')).toHaveLength(0);
  });

  it('returns 404, not 403, for another hospital’s patient timeline', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/patients/${patientA}/timeline?limit=5`,
      token: doctorB.token,
      reason: 'Cross-tenant probe',
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the vitals room and doctor queue meet', () => {
  it('refuses to start a consultation on a visit still waiting for vitals unless a reason is given', async () => {
    await pg
      .pool('migrator')
      .query(`UPDATE clinical.op_visits SET status = 'waiting_vitals' WHERE id = $1`, [visitSecond]);

    const refused = await call({
      method: 'POST',
      url: '/api/v1/encounters',
      token: doctorA.token,
      payload: { visitId: visitSecond },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.body).toContain('vitals room');

    const started = await call({
      method: 'POST',
      url: '/api/v1/encounters',
      token: doctorA.token,
      payload: {
        visitId: visitSecond,
        seeWithoutVitals: { reason: 'Follow-up for a report review; no examination needed' },
      },
    });
    expect(started.statusCode, started.body).toBe(201);

    const audits = await auditRowsForTrace(started.headers['x-trace-id']);
    const insert = audits.find(
      (row) => row['entity'] === 'clinical.encounters' && row['action'] === 'insert',
    );
    expect(String(insert?.['reason_text'])).toContain('report review');
  });

  it('pauses, resumes and logs both', async () => {
    const encounters = await call({
      method: 'GET',
      url: `/api/v1/encounters?visit=${visitSecond}`,
      token: doctorA.token,
    });
    const id = encounters.json<{ items: { id: string }[] }>().items[0]!.id;

    const paused = await call({
      method: 'POST',
      url: `/api/v1/encounters/${id}/pause`,
      token: doctorA.token,
      payload: { reason: 'Patient stepped out for a blood test' },
    });
    expect(paused.statusCode, paused.body).toBe(201);
    expect(paused.json<{ status: string }>().status).toBe('paused');

    const resumed = await call({
      method: 'POST',
      url: `/api/v1/encounters/${id}/resume`,
      token: doctorA.token,
      payload: {},
    });
    expect(resumed.statusCode).toBe(201);
    expect(resumed.json<{ status: string }>().status).toBe('in_progress');

    const log = await pg
      .pool('migrator')
      .query(`SELECT kind::text AS kind FROM clinical.encounter_events WHERE encounter_id = $1 ORDER BY at`, [
        id,
      ]);
    expect(log.rows.map((r: { kind: string }) => r.kind)).toEqual(['started', 'paused', 'resumed']);
  });

  it('lets the doctor request a recheck, which is an event and not a second queue', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/vitals/recheck-requests',
      token: doctorA.token,
      payload: { patientId: patientA, visitId: visitA, parameters: ['systolic', 'diastolic'] },
    });
    expect(res.statusCode, res.body).toBe(201);

    const events = (await outboxRowsForTrace(res.headers['x-trace-id'])).map((e) => e['event_type']);
    expect(events).toEqual(['vitals.recheck.requested']);
  });

  /**
   * The bands are what turn a number into green, amber or red, so everyone who
   * reads a vital needs them — the nurse recording it most of all. They were
   * gated on `vitals.configure`, a management key `nurse_opd` does not hold,
   * which left the vitals room unable to colour anything. Reading a threshold
   * is not changing one, so the gate is `vitals.record.read`.
   */
  it('exposes the configured bands to everyone who reads a vital, and to nobody else', async () => {
    for (const actor of [nurseA, doctorA]) {
      const allowed = await call({
        method: 'GET',
        url: '/api/v1/vitals/reference-ranges?limit=100',
        token: actor.token,
      });
      expect(allowed.statusCode, `${actor.username} must be able to read the bands`).toBe(200);
      expect(allowed.json<{ items: unknown[] }>().items.length).toBe(RANGES.length);
    }

    // A clerk records no vitals and reads none, so the bands are not theirs.
    const denied = await call({
      method: 'GET',
      url: '/api/v1/vitals/reference-ranges',
      token: clerkA.token,
    });
    expect(denied.statusCode).toBe(403);
  });
});
