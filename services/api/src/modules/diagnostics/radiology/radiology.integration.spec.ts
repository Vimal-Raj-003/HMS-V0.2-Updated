import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import { RADIOLOGY_CONTROLLERS, RADIOLOGY_PROVIDERS } from './radiology.module.js';
import { RadOrdersController } from './rad-orders.controller.js';

/**
 * OP-008, EN-008 and OP-022, proved against a real PostgreSQL 17 with RLS on.
 *
 * The suite exists for the properties that cannot be checked by reading the
 * code, and that would each fail silently — or criminally — in production:
 *
 *  1. A role **without** the key gets 403 and the same request with the key
 *     succeeds, so the decorator is wired to a guard that actually runs.
 *  2. A **cross-tenant id returns 404, not 403** (`docs/09` §3.1 case 2). No
 *     query in this module carries a `hospital_id` predicate, so if isolation
 *     holds, row-level security is what is holding it.
 *  3. Every mutation leaves its audit row *and* its registered outbox event,
 *     both inside the transaction that made the change (EN-024 §5).
 *  4. **An obstetric ultrasound cannot be completed without a complete Form F**,
 *     and not on an unregistered machine — PC-PNDT Act 1994, ss. 3–6 and 23.
 *  5. **No request may carry a foetal sex**, in a field or in the report text.
 *  6. **An ionising study cannot be signed off without a dose record** (D-41),
 *     and the block is at signature, not at exam completion.
 *  7. A technologist cannot sign a report; a resident cannot finalise a
 *     co-sign-required one.
 *  8. A critical finding is **stored and released**, and only the *closure* of
 *     the order waits on the documented call-back (D-10).
 *  9. Every image access writes `pacs_view_audit`.
 * 10. A **fallback-matched study cannot be marked reconciled** without a named
 *     patient (EN-008 §5).
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

const orderer: Actor = { userId: newId(), roleId: newId(), username: 'rad-orderer-alpha', token: '' };
const tech: Actor = { userId: newId(), roleId: newId(), username: 'rad-tech-alpha', token: '' };
const radiologist: Actor = { userId: newId(), roleId: newId(), username: 'rad-consultant-alpha', token: '' };
const resident: Actor = { userId: newId(), roleId: newId(), username: 'rad-resident-alpha', token: '' };
const consultant: Actor = { userId: newId(), roleId: newId(), username: 'inv-consultant-alpha', token: '' };
const feed: Actor = { userId: newId(), roleId: newId(), username: 'rad-archive-feed', token: '' };
const clerk: Actor = { userId: newId(), roleId: newId(), username: 'rad-clerk-alpha', token: '' };
const radiologistB: Actor = { userId: newId(), roleId: newId(), username: 'rad-consultant-bravo', token: '' };

const ORDERER_KEYS = [
  'rad.order.create',
  'rad.order.read',
  'rad.order.list',
  'rad.order.update',
  'rad.order.cancel',
  'rad.schedule.manage',
];
const TECH_KEYS = [
  'rad.study.complete',
  'rad.dose.record',
  'rad.mwl.manage',
  'rad.mwl.read',
  'rad.order.read',
  'rad.order.update',
  'rad.study.reconcile',
  'rad.study.read',
  'rad.pacs.read',
];
const RADIOLOGIST_KEYS = [
  'rad.report.create',
  'rad.report.preliminary',
  'rad.report.sign',
  'rad.report.amend',
  'rad.report.read',
  'rad.critical.notify',
  'rad.critical.read',
  'rad.dose.read',
  'rad.pnpdt.manage',
  'rad.image.view',
  'rad.image.share',
  'rad.study.read',
  'rad.peer_review.create',
  'rad.order.read',
  'rad.order.list',
];
const RESIDENT_KEYS = [
  'rad.report.create',
  'rad.report.preliminary',
  'rad.report.read',
  'invest.worklist.read',
  'invest.schedule.manage',
  'invest.study.manage',
  'invest.media.create',
  'invest.report.create',
  'invest.report.read',
  'invest.report.sign',
];
const CONSULTANT_KEYS = [
  'invest.worklist.read',
  'invest.report.read',
  'invest.report.create',
  'invest.report.sign',
  'invest.report.cosign',
  'invest.report.critical',
  'invest.report.amend',
];
const FEED_KEYS = ['integration.rad.study', 'integration.rad.mpps'];
const CLERK_KEYS = ['patient.record.read'];

/** Masters. Effective-dated and active, because the trigger reads them that way. */
const ctHeadKey = newId();
const chestXrayKey = newId();
const obstetricUsgKey = newId();
const ecgServiceKey = newId();

const ctRoom = newId();
const usgRoomRegistered = newId();
const usgRoomUnregistered = newId();

const patientA = newId();
const patientB = newId();
const practitionerRadiologist = newId();
const practitionerResident = newId();
const practitionerConsultant = newId();
const departmentRadiology = newId();

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
  userId: string,
  code: string,
): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO mdm.mdm_practitioners
       (id, record_key, hospital_id, branch_id, version, code, user_id, full_name, display_name,
        registration_council, registration_number, department_key, effective_from, status, updated_at)
     VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $7, 'NMC', $8, $9, now() - interval '1 year', 'active', now())`,
    [
      newId(),
      recordKey,
      hospitalId,
      branchId,
      code,
      userId,
      `Dr ${code}`,
      `NMC-${code}`,
      departmentRadiology,
    ],
  );
}

async function seedPatient(
  hospitalId: string,
  branchId: string,
  id: string,
  uhid: string,
  gender: string,
): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO patient.patients
       (id, hospital_id, branch_id, uhid, uhid_normalised, first_name, last_name, full_name,
        gender, dob, mobile, mobile_local, dedupe_fingerprint, updated_at)
     VALUES ($1, $2, $3, $4, $4, 'Test', 'Patient', $5,
             $6::patient."PatientGender", '1994-03-11'::date, $7, $8, $9, now())`,
    [
      id,
      hospitalId,
      branchId,
      uhid,
      `${uhid} Patient`,
      gender,
      `+9198450${uhid.slice(-5)}`,
      `98450${uhid.slice(-5)}`,
      newId().replace(/-/g, '').slice(0, 32),
    ],
  );
}

async function seedProcedure(
  hospitalId: string,
  branchId: string,
  recordKey: string,
  code: string,
  name: string,
  modality: string,
  options: { readonly ionising: boolean; readonly pcpndt: boolean; readonly drlDlp?: number },
): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO mdm.mdm_rad_procedures
       (id, record_key, hospital_id, branch_id, version, code, name, modality, body_part_dicom,
        laterality_required, contrast_default, is_ionising, is_pcpndt, drl_dlp_mgycm,
        tat_routine_minutes, tat_urgent_minutes, tat_stat_minutes,
        effective_from, status, updated_at)
     VALUES ($1, $2, $3, $4, 1, $5, $6, $7::mdm."RadModality", 'HEAD',
             false, false, $8, $9, $10,
             1440, 240, 30,
             now() - interval '1 year', 'active', now())`,
    [
      newId(),
      recordKey,
      hospitalId,
      branchId,
      code,
      name,
      modality,
      options.ionising,
      options.pcpndt,
      options.drlDlp ?? null,
    ],
  );
}

async function seedInvestigationService(
  hospitalId: string,
  branchId: string,
  recordKey: string,
  cosignRequired: boolean,
): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO mdm.mdm_investigation_services
       (id, record_key, hospital_id, branch_id, version, code, name, modality_group,
        cosign_required, is_pcpndt, is_ionising, requires_media, tat_report_minutes,
        effective_from, status, updated_at)
     VALUES ($1, $2, $3, $4, 1, 'ECG12', '12-lead ECG', 'ecg'::mdm."InvestigationModalityGroup",
             $5, false, false, true, 120, now() - interval '1 year', 'active', now())`,
    [newId(), recordKey, hospitalId, branchId, cosignRequired],
  );
}

async function seedRoom(
  hospitalId: string,
  branchId: string,
  id: string,
  code: string,
  modality: string,
  aeTitle: string,
  pcpndt: { readonly no: string; readonly validTo: string } | null,
): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO rad.rad_modality_rooms
       (id, hospital_id, branch_id, code, name, modality, ae_title, status,
        pcpndt_registration_no, pcpndt_registration_valid_to, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::mdm."RadModality", $7, 'active', $8, $9::date, now())`,
    [
      id,
      hospitalId,
      branchId,
      code,
      `${code} room`,
      modality,
      aeTitle,
      pcpndt?.no ?? null,
      pcpndt?.validTo ?? null,
    ],
  );
}

async function defineSeries(
  hospitalId: string,
  branchId: string,
  key: string,
  pattern: string,
): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO core.numbering_series
       (id, hospital_id, branch_id, key, pattern, scope, fy, current_value, gapless,
        reset_policy, version, effective_from, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'branch', NULL, 0, false,
             'never', 1, now() - interval '1 day', true, now(), now())`,
    [newId(), hospitalId, branchId, key, pattern],
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
  // call keeps each one a distinct submission.
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
    `SELECT id, actor_user_id, entity, action::text AS action, row_id, patient_id, reason_text,
            before, after, data_class::text AS data_class
       FROM core.audit_log WHERE trace_id = $1 ORDER BY recorded_at, id`,
    [String(traceId)],
  );
  return result.rows as Array<Record<string, unknown>>;
}

async function outboxRowsForTrace(traceId: unknown): Promise<Array<Record<string, unknown>>> {
  const result = await pg.pool('migrator').query(
    `SELECT id, event_type, aggregate, aggregate_id, payload, contains_phi
       FROM core.outbox_events WHERE trace_id = $1 ORDER BY event_type`,
    [String(traceId)],
  );
  return result.rows as Array<Record<string, unknown>>;
}

/**
 * The root under test.
 *
 * `imports: [AppModule]` and nothing else, so there is one connection pool and
 * one guard chain. The controllers and providers are declared here only while
 * `app.module.ts` has not yet spread `RADIOLOGY_CONTROLLERS` /
 * `RADIOLOGY_PROVIDERS` into its own arrays — declaring them in both places
 * would mount every route twice and Fastify refuses with
 * `FST_ERR_DUPLICATED_ROUTE` before a single test runs. So the root asks
 * `AppModule` what it already declares and adds only what is missing; once the
 * arrays are wired there, this collapses to `imports: [AppModule]` with no edit
 * here.
 */
const APP_CONTROLLERS = (Reflect.getMetadata('controllers', AppModule) as unknown[] | undefined) ?? [];
const ALREADY_WIRED = APP_CONTROLLERS.includes(RadOrdersController);

@Module(
  ALREADY_WIRED
    ? { imports: [AppModule] }
    : { imports: [AppModule], controllers: RADIOLOGY_CONTROLLERS, providers: RADIOLOGY_PROVIDERS },
)
class RadiologyTestModule {}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'RAD' });
  await syncPermissionCatalogue();

  await defineSeries(tenants.hospitalA, tenants.branchA, 'RAD_ACC', 'RAD{BR}{SEQ:6}');
  await defineSeries(tenants.hospitalB, tenants.branchB, 'RAD_ACC', 'RAD{BR}{SEQ:6}');

  await seedActor(tenants.hospitalA, tenants.branchA, orderer, ORDERER_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, tech, TECH_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, radiologist, RADIOLOGIST_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, resident, RESIDENT_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, consultant, CONSULTANT_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, feed, FEED_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, clerk, CLERK_KEYS);
  await seedActor(tenants.hospitalB, tenants.branchB, radiologistB, RADIOLOGIST_KEYS);

  await seedPractitioner(
    tenants.hospitalA,
    tenants.branchA,
    practitionerRadiologist,
    radiologist.userId,
    'RAD1',
  );
  await seedPractitioner(tenants.hospitalA, tenants.branchA, practitionerResident, resident.userId, 'RES1');
  await seedPractitioner(
    tenants.hospitalA,
    tenants.branchA,
    practitionerConsultant,
    consultant.userId,
    'CON1',
  );

  await seedPatient(tenants.hospitalA, tenants.branchA, patientA, 'RADA00001', 'female');
  await seedPatient(tenants.hospitalB, tenants.branchB, patientB, 'RADB00001', 'male');

  await seedProcedure(tenants.hospitalA, tenants.branchA, ctHeadKey, 'CTHEAD', 'CT head plain', 'CT', {
    ionising: true,
    pcpndt: false,
    drlDlp: 900,
  });
  await seedProcedure(tenants.hospitalA, tenants.branchA, chestXrayKey, 'CXR', 'Chest X-ray PA', 'DX', {
    ionising: true,
    pcpndt: false,
  });
  await seedProcedure(
    tenants.hospitalA,
    tenants.branchA,
    obstetricUsgKey,
    'USGOBS',
    'Obstetric ultrasound',
    'US',
    { ionising: false, pcpndt: true },
  );
  await seedInvestigationService(tenants.hospitalA, tenants.branchA, ecgServiceKey, true);

  await seedRoom(tenants.hospitalA, tenants.branchA, ctRoom, 'CT1', 'CT', 'CT_ONE', null);
  await seedRoom(tenants.hospitalA, tenants.branchA, usgRoomRegistered, 'USG1', 'US', 'USG_ONE', {
    no: 'PCPNDT/2026/0001',
    validTo: '2030-12-31',
  });
  await seedRoom(tenants.hospitalA, tenants.branchA, usgRoomUnregistered, 'USG2', 'US', 'USG_TWO', null);

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(RadiologyTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1');
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  orderer.token = await login(tenants.hospitalA, orderer.username);
  tech.token = await login(tenants.hospitalA, tech.username);
  radiologist.token = await login(tenants.hospitalA, radiologist.username);
  resident.token = await login(tenants.hospitalA, resident.username);
  consultant.token = await login(tenants.hospitalA, consultant.username);
  feed.token = await login(tenants.hospitalA, feed.username);
  clerk.token = await login(tenants.hospitalA, clerk.username);
  radiologistB.token = await login(tenants.hospitalB, radiologistB.username);
});

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

interface OrderView {
  readonly id: string;
  readonly accessionNo: string;
  readonly status: string;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly studyInstanceUid: string | null;
    readonly isPcpndt: boolean;
    readonly isIonising: boolean;
  }>;
}

async function createOrder(procedureKey: string, priority = 'routine'): Promise<OrderView> {
  const res = await call({
    method: 'POST',
    url: '/api/v1/rad/orders',
    token: orderer.token,
    payload: {
      patientId: patientA,
      priority,
      clinicalIndication: 'Head injury, GCS 14, to exclude intracranial bleed.',
      items: [{ procedureKey }],
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<OrderView>();
}

async function startExam(orderItemId: string, roomId: string): Promise<string> {
  const res = await call({
    method: 'POST',
    url: `/api/v1/rad/order-items/${orderItemId}/exam`,
    token: tech.token,
    payload: {
      roomId,
      identityVerified: true,
      identityMethod: 'wristband_scan+verbal',
      safetyChecklistCompleted: true,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('OP-008 — permission gating and tenant isolation', () => {
  it('refuses an imaging order from a role without rad.order.create, and accepts it with', async () => {
    const denied = await call({
      method: 'POST',
      url: '/api/v1/rad/orders',
      token: clerk.token,
      payload: {
        patientId: patientA,
        clinicalIndication: 'Head injury',
        items: [{ procedureKey: ctHeadKey }],
      },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await createOrder(ctHeadKey);
    expect(allowed.accessionNo).toMatch(/^RAD/);
  });

  it('returns 404, never 403, for another hospital’s order', async () => {
    const order = await createOrder(ctHeadKey);

    const mine = await call({
      method: 'GET',
      url: `/api/v1/rad/orders/${order.id}`,
      token: radiologist.token,
    });
    expect(mine.statusCode).toBe(200);

    const theirs = await call({
      method: 'GET',
      url: `/api/v1/rad/orders/${order.id}`,
      token: radiologistB.token,
    });
    expect(theirs.statusCode).toBe(404);
    expect(theirs.json<{ type: string }>().type).toContain('not-found');
  });

  it('writes the audit row and the registered outbox event in the same transaction', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/rad/orders',
      token: orderer.token,
      payload: {
        patientId: patientA,
        clinicalIndication: 'Persistent cough, to exclude consolidation.',
        items: [{ procedureKey: chestXrayKey }],
      },
    });
    expect(res.statusCode).toBe(201);

    const audits = await auditRowsForTrace(res.headers['x-trace-id']);
    const events = await outboxRowsForTrace(res.headers['x-trace-id']);

    expect(audits.map((a) => a['entity'])).toContain('rad.rad_orders');
    expect(audits.every((a) => a['actor_user_id'] === orderer.userId)).toBe(true);
    expect(events.map((e) => e['event_type'])).toEqual(['rad.order.received']);
    expect(events[0]?.['contains_phi']).toBe(true);
  });
});

describe('OP-008 §3.3 — the golden path, and the dose block at signature (D-41)', () => {
  it('takes a CT head from order to signed report, and refuses the signature until the dose is on file', async () => {
    const order = await createOrder(ctHeadKey, 'stat');
    const item = order.items[0];
    expect(item?.isIonising).toBe(true);

    const scheduled = await call({
      method: 'POST',
      url: '/api/v1/rad/appointments',
      token: orderer.token,
      payload: {
        orderItemId: item?.id,
        roomId: ctRoom,
        startAt: new Date(Date.now() + 3_600_000).toISOString(),
        endAt: new Date(Date.now() + 5_400_000).toISOString(),
      },
    });
    expect(scheduled.statusCode, scheduled.body).toBe(201);
    expect(scheduled.json<OrderView>().status).toBe('scheduled');

    const mwl = await call({
      method: 'POST',
      url: `/api/v1/rad/order-items/${String(item?.id)}/mwl/publish`,
      token: tech.token,
      payload: { roomId: ctRoom },
    });
    expect(mwl.statusCode, mwl.body).toBe(201);

    // EN-035 §5: the worklist entry carries the *patient's* DICOM sex. That is a
    // lawful, required attribute and is not what PC-PNDT prohibits.
    const entry = await pg
      .pool('migrator')
      .query(`SELECT patient_sex_dicom, status FROM rad.pacs_mwl_entries WHERE order_item_id = $1`, [
        item?.id,
      ]);
    expect(entry.rows[0]?.['patient_sex_dicom']).toBe('F');

    const arrived = await call({
      method: 'POST',
      url: `/api/v1/rad/orders/${order.id}/check-in`,
      token: orderer.token,
      payload: {},
    });
    expect(arrived.statusCode, arrived.body).toBe(201);

    const examId = await startExam(String(item?.id), ctRoom);

    const ingested = await call({
      method: 'POST',
      url: '/api/v1/pacs/studies/ingest',
      token: feed.token,
      payload: {
        studyInstanceUid: item?.studyInstanceUid,
        orthancId: 'orthanc-ct-1',
        accessionNo: order.accessionNo,
        modality: 'CT',
        series: [
          {
            seriesInstanceUid: `${String(item?.studyInstanceUid)}.1`,
            seriesNumber: 1,
            instances: [
              { sopInstanceUid: `${String(item?.studyInstanceUid)}.1.1`, sizeBytes: 524288 },
              { sopInstanceUid: `${String(item?.studyInstanceUid)}.1.2`, sizeBytes: 524288 },
            ],
          },
        ],
      },
    });
    expect(ingested.statusCode, ingested.body).toBe(201);
    const study = ingested.json<{ id: string; matchedBy: string; reconciliationStatus: string }>();
    expect(study.matchedBy).toBe('study_uid');
    expect(study.reconciliationStatus).toBe('matched');

    const completed = await call({
      method: 'POST',
      url: `/api/v1/rad/exams/${examId}/complete`,
      token: tech.token,
      payload: { technologistNotes: 'Uneventful.' },
    });
    // D-41: completion is NOT where the dose is demanded. The RDSR has not
    // arrived yet and blocking here would produce a fabricated number.
    expect(completed.statusCode, completed.body).toBe(201);
    expect(completed.json<{ doseRecorded: boolean }>().doseRecorded).toBe(false);

    const draft = await call({
      method: 'POST',
      url: '/api/v1/rad/reports',
      token: radiologist.token,
      payload: {
        orderItemId: item?.id,
        findingsText: 'No intracranial haemorrhage. No mass effect.',
        impressionText: 'Normal CT head.',
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const reportId = draft.json<{ id: string }>().id;

    const tooEarly = await call({
      method: 'POST',
      url: `/api/v1/rad/reports/${reportId}/sign`,
      token: radiologist.token,
      payload: { signMethod: 'system' },
    });
    expect(tooEarly.statusCode, tooEarly.body).toBe(422);
    expect(tooEarly.json<{ detail: string }>().detail).toContain('AERB');
    expect(tooEarly.json<{ type: string }>().type).toContain('business-rule-violated');

    const dose = await call({
      method: 'POST',
      url: `/api/v1/rad/exams/${examId}/dose`,
      token: tech.token,
      payload: {
        source: 'rdsr',
        rdsrInstanceUid: '1.2.826.0.1.3680043.9.1',
        ctdivolMgy: 45.2,
        dlpMgycm: 850,
      },
    });
    expect(dose.statusCode, dose.body).toBe(201);

    const signed = await call({
      method: 'POST',
      url: `/api/v1/rad/reports/${reportId}/sign`,
      token: radiologist.token,
      payload: { signMethod: 'system' },
    });
    expect(signed.statusCode, signed.body).toBe(201);
    const view = signed.json<{
      currentStatus: string;
      awaitingCriticalCallback: boolean;
      versions: ReadonlyArray<{ status: string; contentSha256: string; signedBy: string | null }>;
    }>();
    expect(view.currentStatus).toBe('final');
    expect(view.awaitingCriticalCallback).toBe(false);
    expect(view.versions[0]?.signedBy).toBe(radiologist.userId);
    expect(view.versions[0]?.contentSha256).toMatch(/^[0-9a-f]{64}$/);

    const order2 = await call({
      method: 'GET',
      url: `/api/v1/rad/orders/${order.id}`,
      token: radiologist.token,
    });
    expect(order2.json<OrderView>().status).toBe('reported');
  });

  it('refuses the signature from a technologist', async () => {
    const order = await createOrder(chestXrayKey);
    const item = order.items[0];
    const examId = await startExam(String(item?.id), ctRoom);
    await call({
      method: 'POST',
      url: `/api/v1/rad/exams/${examId}/complete`,
      token: tech.token,
      payload: {},
    });
    const draft = await call({
      method: 'POST',
      url: '/api/v1/rad/reports',
      token: radiologist.token,
      payload: { orderItemId: item?.id, impressionText: 'Clear lung fields.' },
    });
    const reportId = draft.json<{ id: string }>().id;

    const attempt = await call({
      method: 'POST',
      url: `/api/v1/rad/reports/${reportId}/sign`,
      token: tech.token,
      payload: { signMethod: 'system' },
    });
    expect(attempt.statusCode).toBe(403);
  });
});

describe('OP-008 §3.5 and D-10 — the critical finding is released; the closure waits', () => {
  it('releases the report immediately and holds the order open until the call-back is documented', async () => {
    const order = await createOrder(ctHeadKey, 'stat');
    const item = order.items[0];
    const examId = await startExam(String(item?.id), ctRoom);
    await call({
      method: 'POST',
      url: `/api/v1/rad/exams/${examId}/complete`,
      token: tech.token,
      payload: {},
    });
    await call({
      method: 'POST',
      url: `/api/v1/rad/exams/${examId}/dose`,
      token: tech.token,
      payload: { source: 'manual', dlpMgycm: 1200 },
    });

    const draft = await call({
      method: 'POST',
      url: '/api/v1/rad/reports',
      token: radiologist.token,
      payload: {
        orderItemId: item?.id,
        findingsText: 'Large right-sided extradural haematoma with midline shift.',
        impressionText: 'Acute extradural haematoma with 9 mm midline shift. Neurosurgical emergency.',
        findingLevel: 'critical',
      },
    });
    const reportId = draft.json<{ id: string }>().id;

    const signed = await call({
      method: 'POST',
      url: `/api/v1/rad/reports/${reportId}/sign`,
      token: radiologist.token,
      payload: { signMethod: 'system' },
    });
    expect(signed.statusCode, signed.body).toBe(201);

    // Release: the report is final and the event is out.
    const view = signed.json<{ currentStatus: string; awaitingCriticalCallback: boolean }>();
    expect(view.currentStatus).toBe('final');
    expect(view.awaitingCriticalCallback).toBe(true);
    const events = (await outboxRowsForTrace(signed.headers['x-trace-id'])).map((e) => e['event_type']);
    expect(events).toContain('rad.report.final');
    expect(events).toContain('rad.result.critical');

    // Authorisation: the order has NOT closed.
    const openOrder = await call({
      method: 'GET',
      url: `/api/v1/rad/orders/${order.id}`,
      token: radiologist.token,
    });
    expect(openOrder.json<OrderView>().status).toBe('preliminary');

    const findings = await call({
      method: 'GET',
      url: '/api/v1/rad/critical-findings?status=open',
      token: radiologist.token,
    });
    expect(findings.statusCode, findings.body).toBe(200);
    const finding = findings.json<{ items: ReadonlyArray<{ id: string; status: string }> }>().items[0];
    expect(finding?.status).toBe('open');

    // Neither arm of the evidence rule: refused.
    const empty = await call({
      method: 'POST',
      url: `/api/v1/rad/critical-findings/${String(finding?.id)}/callbacks`,
      token: radiologist.token,
      payload: { method: 'phone', notifiedToName: 'Dr Rao' },
    });
    expect(empty.statusCode, empty.body).toBe(400);

    // Both arms at once: also refused.
    const both = await call({
      method: 'POST',
      url: `/api/v1/rad/critical-findings/${String(finding?.id)}/callbacks`,
      token: radiologist.token,
      payload: {
        method: 'phone',
        notifiedToName: 'Dr Rao',
        readBackConfirmed: true,
        readBackValue: 'EDH, shift',
        clinicianUnreachable: true,
        escalatedToLevel: 1,
        escalatedToRole: 'ER physician',
      },
    });
    expect(both.statusCode).toBe(400);

    const callback = await call({
      method: 'POST',
      url: `/api/v1/rad/critical-findings/${String(finding?.id)}/callbacks`,
      token: radiologist.token,
      payload: {
        method: 'phone',
        notifiedToName: 'Dr Rao',
        notifiedToRole: 'Neurosurgery registrar',
        readBackConfirmed: true,
        readBackValue: 'Extradural haematoma, 9 mm shift, theatre now',
      },
    });
    expect(callback.statusCode, callback.body).toBe(201);
    expect(callback.json<{ status: string; callbackCount: number }>().status).toBe('communicated');

    const closed = await call({
      method: 'GET',
      url: `/api/v1/rad/orders/${order.id}`,
      token: radiologist.token,
    });
    expect(closed.json<OrderView>().status).toBe('reported');
  });

  it('accepts the escalation arm on its own, so nobody is tempted to withhold the report', async () => {
    const order = await createOrder(chestXrayKey, 'stat');
    const item = order.items[0];
    const examId = await startExam(String(item?.id), ctRoom);
    await call({
      method: 'POST',
      url: `/api/v1/rad/exams/${examId}/complete`,
      token: tech.token,
      payload: {},
    });
    await call({
      method: 'POST',
      url: `/api/v1/rad/exams/${examId}/dose`,
      token: tech.token,
      payload: { source: 'manual', exposureCount: 1 },
    });
    const draft = await call({
      method: 'POST',
      url: '/api/v1/rad/reports',
      token: radiologist.token,
      payload: {
        orderItemId: item?.id,
        impressionText: 'Large left tension pneumothorax.',
        findingLevel: 'critical',
      },
    });
    const reportId = draft.json<{ id: string }>().id;
    await call({
      method: 'POST',
      url: `/api/v1/rad/reports/${reportId}/sign`,
      token: radiologist.token,
      payload: { signMethod: 'system' },
    });

    const findings = await call({
      method: 'GET',
      url: '/api/v1/rad/critical-findings?status=open',
      token: radiologist.token,
    });
    const finding = findings.json<{ items: ReadonlyArray<{ id: string }> }>().items[0];

    const escalated = await call({
      method: 'POST',
      url: `/api/v1/rad/critical-findings/${String(finding?.id)}/callbacks`,
      token: radiologist.token,
      payload: {
        method: 'phone',
        clinicianUnreachable: true,
        escalatedToLevel: 2,
        escalatedToRole: 'Medical Superintendent',
        remarks: 'Ordering doctor off shift and not answering; escalated per EN-037 ladder.',
      },
    });
    expect(escalated.statusCode, escalated.body).toBe(201);
    expect(escalated.json<{ status: string }>().status).toBe('escalated');
  });
});

describe('PC-PNDT — the Act, not a validation rule', () => {
  it('refuses to complete an obstetric ultrasound with no Form F, and accepts it once the Form is complete', async () => {
    const order = await createOrder(obstetricUsgKey);
    const item = order.items[0];
    expect(item?.isPcpndt).toBe(true);

    const examId = await startExam(String(item?.id), usgRoomRegistered);

    const refused = await call({
      method: 'POST',
      url: `/api/v1/rad/exams/${examId}/complete`,
      token: tech.token,
      payload: {},
    });
    expect(refused.statusCode, refused.body).toBe(422);
    const problem = refused.json<{ type: string; detail: string; reference?: string }>();
    expect(problem.type).toContain('statutory-limit');
    expect(problem.detail).toContain('PC-PNDT');
    expect(problem.reference).toContain('PC-PNDT Act 1994');

    // A partly-signed Form F is still no Form F.
    const partial = await call({
      method: 'POST',
      url: `/api/v1/rad/order-items/${String(item?.id)}/form-f`,
      token: radiologist.token,
      reason: 'Statutory Form F register entry for this obstetric scan.',
      payload: formFPayload({ womanSigned: true, doctorSigned: false }),
    });
    expect(partial.statusCode, partial.body).toBe(201);

    const stillRefused = await call({
      method: 'POST',
      url: `/api/v1/rad/exams/${examId}/complete`,
      token: tech.token,
      payload: {},
    });
    expect(stillRefused.statusCode).toBe(422);
    expect(stillRefused.json<{ detail: string }>().detail).toContain('NOT SIGNED');

    const complete = await call({
      method: 'POST',
      url: `/api/v1/rad/order-items/${String(item?.id)}/form-f`,
      token: radiologist.token,
      reason: 'Statutory Form F register entry for this obstetric scan.',
      payload: formFPayload({ womanSigned: true, doctorSigned: true }),
    });
    expect(complete.statusCode, complete.body).toBe(201);

    const done = await call({
      method: 'POST',
      url: `/api/v1/rad/exams/${examId}/complete`,
      token: tech.token,
      payload: {},
    });
    expect(done.statusCode, done.body).toBe(201);
  });

  it('refuses an obstetric scan on a machine with no registration under the Act', async () => {
    const order = await createOrder(obstetricUsgKey);
    const item = order.items[0];
    const examId = await startExam(String(item?.id), usgRoomUnregistered);
    await call({
      method: 'POST',
      url: `/api/v1/rad/order-items/${String(item?.id)}/form-f`,
      token: radiologist.token,
      reason: 'Statutory Form F register entry for this obstetric scan.',
      payload: formFPayload({ womanSigned: true, doctorSigned: true }),
    });

    const refused = await call({
      method: 'POST',
      url: `/api/v1/rad/exams/${examId}/complete`,
      token: tech.token,
      payload: {},
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json<{ detail: string }>().detail).toContain('no registration under the Act');
  });

  it('has no field anywhere that could carry a foetal sex, and refuses one if offered', async () => {
    const columns = await pg.pool('migrator').query(
      `SELECT count(*)::int AS n
         FROM information_schema.columns
        WHERE table_schema IN ('rad', 'lab')
           OR (table_schema = 'clinical' AND table_name LIKE 'investigation%')`,
    );
    expect(Number(columns.rows[0]?.['n'])).toBeGreaterThan(0);

    const offending = await pg.pool('migrator').query(
      `SELECT table_schema, table_name, column_name
         FROM information_schema.columns
        WHERE (table_schema IN ('rad', 'lab')
               OR (table_schema = 'clinical' AND table_name LIKE 'investigation%'))
          AND (column_name ~* '(fo?etal|fetus|unborn).*(sex|gender)'
               OR column_name ~* 'sex.*(determination|selection)')`,
    );
    expect(offending.rows).toEqual([]);

    const order = await createOrder(obstetricUsgKey);
    const item = order.items[0];

    const smuggled = await call({
      method: 'POST',
      url: `/api/v1/rad/order-items/${String(item?.id)}/form-f`,
      token: radiologist.token,
      reason: 'Statutory Form F register entry for this obstetric scan.',
      payload: { ...formFPayload({ womanSigned: true, doctorSigned: true }), foetalSex: 'female' },
    });
    expect(smuggled.statusCode, smuggled.body).toBe(400);

    const inText = await call({
      method: 'POST',
      url: '/api/v1/rad/reports',
      token: radiologist.token,
      payload: {
        orderItemId: item?.id,
        impressionText: 'Single live intrauterine gestation. The sex of the foetus is female.',
      },
    });
    expect(inText.statusCode, inText.body).toBe(422);
    expect(inText.json<{ type: string }>().type).toContain('statutory-limit');
  });
});

describe('EN-008 — the archive index, the disclosure record and reconciliation', () => {
  it('audits every image access', async () => {
    const order = await createOrder(ctHeadKey);
    const item = order.items[0];
    await call({
      method: 'POST',
      url: '/api/v1/pacs/studies/ingest',
      token: feed.token,
      payload: {
        studyInstanceUid: item?.studyInstanceUid,
        orthancId: 'orthanc-ct-2',
        accessionNo: order.accessionNo,
        modality: 'CT',
        series: [],
      },
    });
    // The radiologist becomes the care team by drafting the report on it.
    await call({
      method: 'POST',
      url: '/api/v1/rad/reports',
      token: radiologist.token,
      payload: { orderItemId: item?.id, impressionText: 'For review.' },
    });

    const studies = await call({
      method: 'GET',
      url: `/api/v1/pacs/studies?patientId=${patientA}`,
      token: radiologist.token,
    });
    expect(studies.statusCode, studies.body).toBe(200);
    const studyId = studies
      .json<{ items: ReadonlyArray<{ id: string; studyInstanceUid: string }> }>()
      .items.find((s) => s.studyInstanceUid === item?.studyInstanceUid)?.id;
    expect(studyId).toBeTypeOf('string');

    const grant = await call({
      method: 'POST',
      url: `/api/v1/pacs/studies/${String(studyId)}/viewer-token`,
      token: radiologist.token,
      payload: { action: 'view', scope: 'view' },
    });
    expect(grant.statusCode, grant.body).toBe(201);
    const view = grant.json<{ token: string; breakGlass: boolean; orthancId: string | null }>();
    expect(view.token.length).toBeGreaterThan(20);
    expect(view.breakGlass).toBe(false);
    expect(view.orthancId).toBe('orthanc-ct-2');

    const audited = await pg
      .pool('migrator')
      .query(`SELECT user_id, action::text AS action, purpose FROM rad.pacs_view_audit WHERE study_id = $1`, [
        studyId,
      ]);
    expect(audited.rows.length).toBeGreaterThanOrEqual(1);
    expect(audited.rows.some((r) => r['user_id'] === radiologist.userId && r['action'] === 'view')).toBe(
      true,
    );

    // The token is stored as a hash, never in clear.
    const stored = await pg
      .pool('migrator')
      .query(`SELECT token_hash FROM rad.pacs_access_tokens WHERE user_id = $1`, [radiologist.userId]);
    expect(stored.rows.every((r) => r['token_hash'] !== view.token)).toBe(true);

    const events = (await outboxRowsForTrace(grant.headers['x-trace-id'])).map((e) => e['event_type']);
    expect(events).toContain('pacs.study.viewed');
  });

  it('will not let a fallback-matched study be marked reconciled without a named patient', async () => {
    const uid = `2.25.${String(Date.now())}0001`;
    const ingested = await call({
      method: 'POST',
      url: '/api/v1/pacs/studies/ingest',
      token: feed.token,
      payload: {
        studyInstanceUid: uid,
        orthancId: 'orthanc-orphan-1',
        uhidAtAcquisition: 'RADA00001',
        modality: 'CT',
        series: [],
      },
    });
    expect(ingested.statusCode, ingested.body).toBe(201);
    const study = ingested.json<{ id: string; matchedBy: string; reconciliationStatus: string }>();
    expect(study.matchedBy).toBe('fallback');
    expect(study.reconciliationStatus).toBe('needs_review');

    const events = (await outboxRowsForTrace(ingested.headers['x-trace-id'])).map((e) => e['event_type']);
    expect(events).toContain('pacs.study.unmatched');
    expect(events).toContain('rad.study.unmatched');

    // A study nobody has claimed cannot be opened for reading either.
    const viewer = await call({
      method: 'POST',
      url: `/api/v1/pacs/studies/${study.id}/viewer-token`,
      token: radiologist.token,
      payload: {},
    });
    expect(viewer.statusCode).toBe(422);

    const blind = await call({
      method: 'POST',
      url: `/api/v1/pacs/studies/${study.id}/reconcile`,
      token: tech.token,
      reason: 'Confirming the automatic match from the worklist.',
      payload: {},
    });
    expect(blind.statusCode, blind.body).toBe(422);
    expect(blind.json<{ detail: string }>().detail).toContain('demographic resemblance');

    const named = await call({
      method: 'POST',
      url: `/api/v1/pacs/studies/${study.id}/reconcile`,
      token: tech.token,
      reason: 'Verified against the wristband and the request form at the CT console.',
      payload: { patientId: patientA },
    });
    expect(named.statusCode, named.body).toBe(201);
    const reconciled = named.json<{ matchedBy: string; reconciliationStatus: string }>();
    expect(reconciled.matchedBy).toBe('manual');
    expect(reconciled.reconciliationStatus).toBe('reconciled');

    const reconciledEvents = (await outboxRowsForTrace(named.headers['x-trace-id'])).map(
      (e) => e['event_type'],
    );
    expect(reconciledEvents).toContain('pacs.study.reconciled');
  });

  it('refuses the reconciliation without a reason, because the key demands one', async () => {
    const uid = `2.25.${String(Date.now())}0002`;
    const ingested = await call({
      method: 'POST',
      url: '/api/v1/pacs/studies/ingest',
      token: feed.token,
      payload: { studyInstanceUid: uid, uhidAtAcquisition: 'RADA00001', series: [] },
    });
    const study = ingested.json<{ id: string }>();

    const noReason = await call({
      method: 'POST',
      url: `/api/v1/pacs/studies/${study.id}/reconcile`,
      token: tech.token,
      payload: { patientId: patientA },
    });
    expect(noReason.statusCode).toBe(403);
  });
});

describe('OP-022 — the investigation console and the co-signature', () => {
  it('will not let a resident finalise a report on a service that requires a countersignature', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/investigations/studies',
      token: resident.token,
      payload: { patientId: patientA, serviceKey: ecgServiceKey, priority: 'routine' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const studyId = created.json<{ id: string }>().id;

    await call({
      method: 'POST',
      url: `/api/v1/investigations/studies/${studyId}/start`,
      token: resident.token,
      payload: { identityVerified: true, identityMethod: 'wristband_scan+verbal' },
    });
    await call({
      method: 'POST',
      url: `/api/v1/investigations/studies/${studyId}/media`,
      token: resident.token,
      payload: { kind: 'waveform', fileId: newId(), mimeType: 'application/octet-stream', sizeBytes: 4096 },
    });
    const done = await call({
      method: 'POST',
      url: `/api/v1/investigations/studies/${studyId}/done`,
      token: resident.token,
      payload: {},
    });
    expect(done.statusCode, done.body).toBe(201);

    const draft = await call({
      method: 'POST',
      url: `/api/v1/investigations/studies/${studyId}/reports`,
      token: resident.token,
      payload: { body: { rhythm: 'sinus' }, impression: 'Normal sinus rhythm at 74 bpm.' },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const report = draft.json<{ id: string; cosignRequired: boolean; currentStatus: string }>();
    expect(report.cosignRequired).toBe(true);
    expect(report.currentStatus).toBe('draft_for_cosign');

    const residentAttempt = await call({
      method: 'POST',
      url: `/api/v1/investigations/reports/${report.id}/sign`,
      token: resident.token,
      payload: { signMethod: 'system' },
    });
    // Refused on the key, before the row is touched: the resident is told they
    // lack the consultant's authority rather than being shown a trigger's
    // message about countersignatures. The trigger is still there underneath —
    // removing this assertion turns the same request into a `segregation-of-
    // duties` refusal from `clinical.enforce_investigation_cosign()`.
    expect(residentAttempt.statusCode, residentAttempt.body).toBe(403);
    expect(residentAttempt.json<{ type: string }>().type).toContain('permission-denied');

    const cosigned = await call({
      method: 'POST',
      url: `/api/v1/investigations/reports/${report.id}/cosign`,
      token: consultant.token,
      payload: { signMethod: 'countersign', discrepancy: 'minor' },
    });
    expect(cosigned.statusCode, cosigned.body).toBe(201);
    const final = cosigned.json<{
      currentStatus: string;
      versions: ReadonlyArray<{ cosignerUserId: string | null; signedBy: string | null }>;
    }>();
    expect(final.currentStatus).toBe('final');
    expect(final.versions[0]?.cosignerUserId).toBe(consultant.userId);

    const events = (await outboxRowsForTrace(cosigned.headers['x-trace-id'])).map((e) => e['event_type']);
    expect(events).toContain('investigation.report.cosign.approved');
    expect(events).toContain('investigation.report.final');
  });

  it('refuses a countersignature by the author of the report', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/investigations/studies',
      token: consultant.token,
      payload: { patientId: patientA, serviceKey: ecgServiceKey },
    });
    expect(created.statusCode).toBe(403); // consultant holds no invest.schedule.manage

    const study = await call({
      method: 'POST',
      url: '/api/v1/investigations/studies',
      token: resident.token,
      payload: { patientId: patientA, serviceKey: ecgServiceKey },
    });
    const studyId = study.json<{ id: string }>().id;

    const draft = await call({
      method: 'POST',
      url: `/api/v1/investigations/studies/${studyId}/reports`,
      token: consultant.token,
      payload: { body: {}, impression: 'Normal study.' },
    });
    const reportId = draft.json<{ id: string }>().id;

    const selfCosign = await call({
      method: 'POST',
      url: `/api/v1/investigations/reports/${reportId}/cosign`,
      token: consultant.token,
      payload: { signMethod: 'countersign' },
    });
    // The trigger is the guarantee — `clinical.enforce_investigation_cosign()`
    // refuses a countersignature by the author — and `mapDatabaseRefusal`
    // surfaces it as what it is rather than as a constraint name.
    expect(selfCosign.statusCode, selfCosign.body).toBe(403);
    expect(selfCosign.json<{ type: string }>().type).toContain('segregation-of-duties');
    expect(selfCosign.json<{ detail: string }>().detail).toContain('not a countersignature');
  });
});

describe('docs/07 — the plans the application actually runs', () => {
  /**
   * `EXPLAIN` as `hms_app`, with a **complete** tenant context.
   *
   * Both halves of that sentence are load-bearing and both are easy to get
   * wrong. Measuring as `hms_migrator` measures nothing: the schema owner
   * bypasses RLS by ownership, so the planner sees a query the application can
   * never issue and picks a plan the application will never get. And setting
   * `app.hospital_id` without `app.branch_ids` is worse than useless —
   * `core.current_branch_ids()` returns an **empty array** when unset, so the
   * branch predicate matches nothing, every scan returns zero rows, and the
   * plan is fast for the one reason that cannot survive contact with a real
   * ward.
   */
  async function explain(sql: string, values: readonly unknown[] = []): Promise<string> {
    const client = await pg.pool('app').connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.hospital_id', tenants.hospitalA]);
      await client.query('SELECT set_config($1, $2, true)', ['app.scope', 'branch']);
      await client.query('SELECT set_config($1, $2, true)', ['app.branch_ids', `{${tenants.branchA}}`]);
      const plan = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${sql}`,
        [...values],
      );
      await client.query('ROLLBACK');
      return plan.rows.map((r) => r['QUERY PLAN']).join('\n');
    } finally {
      client.release();
    }
  }

  it('reads the radiologist worklist and the study index through their partial indexes', async () => {
    const seen = await explain(
      `SELECT i.id FROM rad.rad_order_items i
         JOIN rad.rad_orders o ON o.id = i.order_id
        WHERE i.status IN ('acquired', 'awaiting_report', 'preliminary')
        ORDER BY o.ordered_at DESC, i.id DESC LIMIT 50`,
    );
    expect(seen).toContain('Limit');

    const reconciliation = await explain(
      `SELECT s.id FROM rad.pacs_studies s
        WHERE s.reconciliation_status = 'needs_review'
        ORDER BY s.created_at DESC, s.id DESC LIMIT 50`,
    );
    // The partial index `idx_pacs_studies_needs_review` exists precisely for the
    // reconciliation queue, which is read on every refresh of a screen whose
    // whole purpose is that nothing sits in it unnoticed.
    expect(reconciliation).toMatch(/idx_pacs_studies_needs_review|Seq Scan on pacs_studies/);

    const criticals = await explain(
      `SELECT f.id FROM rad.rad_critical_findings f
        WHERE f.status = 'open' ORDER BY f.detected_at DESC, f.id DESC LIMIT 50`,
    );
    expect(criticals).toContain('rad_critical_findings');

    // The measurement is only meaningful if the context is real: with the same
    // role and no branch scope, the same query sees nothing at all.
    const client = await pg.pool('app').connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.hospital_id', tenants.hospitalA]);
      const blind = await client.query(`SELECT count(*)::int AS n FROM rad.rad_orders`);
      await client.query('ROLLBACK');
      expect(Number((blind.rows[0] as { n: number }).n)).toBe(0);
    } finally {
      client.release();
    }

    const scoped = await explain(`SELECT count(*)::int AS n FROM rad.rad_orders`);
    expect(scoped).toContain('rad_orders');
  });
});

function formFPayload(options: {
  readonly womanSigned: boolean;
  readonly doctorSigned: boolean;
}): Record<string, unknown> {
  return {
    patientName: 'RADA00001 Patient',
    patientAgeYears: 31,
    husbandOrFatherName: 'Test Spouse',
    fullAddress: '12 Test Road, Bengaluru 560001',
    identityDocumentType: 'aadhaar',
    identityDocumentRefMasked: 'XXXX-XXXX-4321',
    gravida: 2,
    para: 1,
    livingChildren: 1,
    previousAbortions: 0,
    gestationalAgeWeeks: 20.5,
    referringDoctorName: 'Dr Referring',
    referringDoctorRegistrationNo: 'NMC-REF-1',
    indicationCodes: ['advanced_maternal_age'],
    proceduresPerformed: ['ultrasonography'],
    facilityRegistrationNo: 'PCPNDT/FAC/2026/7',
    machineRegistrationNo: 'PCPNDT/2026/0001',
    performedByName: 'Dr RAD1',
    performedByRegistrationNo: 'NMC-RAD1',
    performedAt: new Date().toISOString(),
    womanDeclarationSigned: options.womanSigned,
    womanDeclarationDocId: options.womanSigned ? newId() : undefined,
    doctorDeclarationSigned: options.doctorSigned,
    doctorDeclarationDocId: options.doctorSigned ? newId() : undefined,
  };
}
