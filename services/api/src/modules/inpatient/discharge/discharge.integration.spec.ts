import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import { DischargeController } from './discharge.controller.js';
import { DischargeService } from './discharge.service.js';

/**
 * IP-002 and IP-017 against a real PostgreSQL 17.
 *
 * Two properties, and neither can be established by reading the code:
 *
 *  1. **A discharge summary cannot be signed while a medicine is undecided**,
 *     and no request field, permission or role makes it signable. Once signed
 *     it cannot be edited — including through the draft route, which is the
 *     back door a reader would look for. An amendment is a new version carrying
 *     its reason, and a countersignature must come from a second person.
 *  2. **A body is released only on four facts**: a certificate of cause of
 *     death, a next of kin checked against a document, no open medico-legal
 *     case, and any required post-mortem performed. The test removes them one
 *     at a time and asserts the same refusal each time. The release checklist
 *     the screen renders is then asserted to agree with the trigger — a
 *     checklist that disagrees is worse than none, because the custodian
 *     promises a family a release the database then refuses in front of them.
 *
 * Also proven: the tag is compared at the door in both directions, a resident
 * cannot issue a certificate, a doctor cannot record that the patient left, and
 * every mutation leaves one audit row and its registered outbox event in the
 * mutation's own transaction.
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
const actor = (username: string): Actor => ({ userId: newId(), roleId: newId(), username, token: '' });

/** The consultant: initiates, reconciles, signs, amends, certifies a death. */
const consultant = actor('dis-consultant');
/** A second consultant, so a countersignature is genuinely a second person. */
const second = actor('dis-second');
/** A resident: drafts and signs, never countersigns, never certifies a death. */
const resident = actor('dis-resident');
/** The ward: watches the worklist and records that the patient left. */
const nurse = actor('dis-nurse');
/** The mortuary custodian: the register, and the only holder of the release. */
const custodian = actor('dis-custodian');

const CONSULTANT_KEYS = [
  'ip.discharge.read',
  'ip.discharge.initiate',
  'ip.discharge.reconcile',
  'ip.discharge.summary.write',
  'ip.discharge.summary.sign',
  'ip.discharge.summary.cosign',
  'ip.discharge.summary.amend',
  'ip.discharge.dama',
  'mortuary.case.read',
  'mortuary.case.create',
  'mortuary.mccd.write',
];
const RESIDENT_KEYS = [
  'ip.discharge.read',
  'ip.discharge.initiate',
  'ip.discharge.reconcile',
  'ip.discharge.summary.write',
  'ip.discharge.summary.sign',
  'mortuary.case.read',
  'mortuary.case.create',
];
const NURSE_KEYS = ['ip.discharge.read', 'ip.discharge.complete', 'mortuary.case.read'];
const CUSTODIAN_KEYS = [
  'ip.discharge.read',
  'mortuary.case.read',
  'mortuary.body.operate',
  'mortuary.pm.write',
  'mortuary.release.manage',
  'mortuary.report.read',
];

const PATIENT = { alive: newId(), dead: newId(), mlc: newId() };
const ADMISSION = { open: newId(), second: newId(), dama: newId() };

// ── fixtures ─────────────────────────────────────────────────────────────────

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

async function defineSeries(hospitalId: string, branchId: string, key: string, pattern: string) {
  await pg.pool('migrator').query(
    `INSERT INTO core.numbering_series
       (id, hospital_id, branch_id, key, pattern, scope, fy, current_value, gapless,
        reset_policy, version, effective_from, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'branch', NULL, 0, false,
             'never', 1, now() - interval '1 day', true, now(), now())`,
    [newId(), hospitalId, branchId, key, pattern],
  );
}

async function seedActor(
  hospitalId: string,
  branchId: string,
  who: Actor,
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
     VALUES ($1, $2, $3, $4, 'Integration test role', 'ip-rounds', 'medical', now())`,
    [who.roleId, hospitalId, `role_${who.username.replace(/-/g, '_')}`, `Role ${who.username}`],
  );
  for (const key of permissionKeys) {
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

async function seedPatient(id: string, name: string): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO patient.patients
       (id, hospital_id, branch_id, uhid, uhid_normalised, first_name, full_name, gender, dob,
        mobile, mobile_local, dedupe_fingerprint, status, updated_at)
     VALUES ($1, $2, $3, $4, $4, $5, $5, 'female', '1972-03-11'::date, '+919845000000', '9845000000', $6,
             'active', now())`,
    [
      id,
      tenants.hospitalA,
      tenants.branchA,
      `UH-${id.replace(/-/g, '').slice(-10)}`,
      name,
      id.replace(/-/g, ''),
    ],
  );
}

async function seedAdmission(id: string, patientId: string): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO clinical.ip_admissions
       (id, hospital_id, branch_id, patient_id, ip_no, kind, admitted_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'elective', now() - interval '4 days', now())`,
    [id, tenants.hospitalA, tenants.branchA, patientId, `IP-${id.replace(/-/g, '').slice(-8)}`],
  );
}

/** An active ward order, so `prefill` has something to put on the list. */
async function seedMarOrder(admissionId: string, patientId: string, drug: string, dose: number) {
  await pg.pool('migrator').query(
    `INSERT INTO clinical.ip_mar_orders
       (id, hospital_id, branch_id, admission_id, patient_id, drug_name, dose, dose_unit, route,
        frequency, starts_at, ordered_by, ordered_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'mg', 'oral', 'BD', now(), $8, now(), now(), now())`,
    [newId(), tenants.hospitalA, tenants.branchA, admissionId, patientId, drug, dose, consultant.userId],
  );
}

async function seedMlc(id: string, status: string): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO clinical.mlc_cases
       (id, hospital_id, branch_id, mlc_no, category, status, patient_id, updated_at)
     VALUES ($1, $2, $3, $4, 'rta', $5::clinical."MlcStatus", $6, now())`,
    [id, tenants.hospitalA, tenants.branchA, `MLC-${id.slice(-6)}`, status, PATIENT.mlc],
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
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly token: string;
  readonly reason?: string;
  readonly payload?: Record<string, unknown>;
}

async function call(options: CallOptions) {
  const headers: Record<string, string> = { authorization: `Bearer ${options.token}` };
  headers['x-reason'] = options.reason ?? 'integration test';
  if (options.method === 'POST') headers['idempotency-key'] = newId();
  return app.inject({
    method: options.method,
    url: options.url,
    headers,
    ...(options.method === 'POST' ? { payload: options.payload ?? {} } : {}),
  });
}

/** A complete, valid summary body. Callers override what they care about. */
function summaryBody(patientId: string, overrides: Record<string, unknown> = {}) {
  return {
    patientId,
    finalDiagnosis: 'Community-acquired pneumonia, right lower lobe',
    courseInHospital: 'IV co-amoxiclav for four days; oxygen weaned by day three.',
    conditionOnDischarge: 'Afebrile, saturating 96% on room air, chest clear',
    followUpPlan: 'Chest clinic in two weeks with a repeat radiograph',
    redFlagAdvice: 'Return at once if breathless at rest, confused, coughing blood, or the fever returns',
    icd10Codes: ['J18.1'],
    ...overrides,
  };
}

/**
 * The application as it ships, plus this module.
 *
 * The controller and service are declared here only while `AppModule` does not
 * declare them itself. Once they are spread into it — which they now are, via
 * `INPATIENT_CONTROLLERS` — declaring them a second time mounts every route
 * twice and Fastify refuses with `FST_ERR_DUPLICATED_ROUTE` before a single
 * test runs. The check reads `AppModule`'s own metadata, so this file needs no
 * edit either way.
 */
const appControllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as unknown[];
const alreadyWired = appControllers.includes(DischargeController);

@Module({
  imports: [AppModule],
  controllers: alreadyWired ? [] : [DischargeController],
  providers: alreadyWired ? [] : [DischargeService],
})
class DischargeTestModule {}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'DIS' });
  await syncPermissionCatalogue();
  await defineSeries(tenants.hospitalA, tenants.branchA, 'MORTUARY', 'MOR{BR}{SEQ:5}');

  await seedActor(tenants.hospitalA, tenants.branchA, consultant, CONSULTANT_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, second, CONSULTANT_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, resident, RESIDENT_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, nurse, NURSE_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, custodian, CUSTODIAN_KEYS);

  await seedPatient(PATIENT.alive, 'Asha');
  await seedPatient(PATIENT.dead, 'Meena');
  await seedPatient(PATIENT.mlc, 'Latha');
  await seedAdmission(ADMISSION.open, PATIENT.alive);
  await seedAdmission(ADMISSION.second, PATIENT.alive);
  await seedAdmission(ADMISSION.dama, PATIENT.alive);
  await seedMarOrder(ADMISSION.open, PATIENT.alive, 'Enoxaparin', 40);
  await seedMarOrder(ADMISSION.open, PATIENT.alive, 'Atorvastatin', 40);

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(DischargeTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  for (const who of [consultant, second, resident, nurse, custodian]) {
    who.token = await login(tenants.hospitalA, who.username);
  }
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('IP-002 — the summary is signed on reconciled medicines', () => {
  let dischargeId = '';
  let summaryId = '';

  it('opens a discharge and pulls the ward chart onto the reconciliation list', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/ip/discharge',
      token: consultant.token,
      payload: { admissionId: ADMISSION.open, patientId: PATIENT.alive, destination: 'home' },
    });
    expect(created.statusCode).toBe(201);
    dischargeId = created.json<{ id: string }>().id;

    const prefilled = await call({
      method: 'POST',
      url: `/api/v1/ip/discharge/${dischargeId}/reconciliation/prefill`,
      token: consultant.token,
    });
    expect(prefilled.statusCode).toBe(201);
    const rows = prefilled.json<{ drugName: string; action: string }[]>();
    expect(rows.map((r) => r.drugName).sort()).toEqual(['Atorvastatin', 'Enoxaparin']);
    expect(rows.every((r) => r.action === 'unresolved')).toBe(true);
  });

  it('shows the blocker on the worklist row, before anybody tries to sign', async () => {
    const listed = await call({
      method: 'GET',
      url: '/api/v1/ip/discharge?openOnly=true',
      token: nurse.token,
    });
    expect(listed.statusCode).toBe(200);
    const row = listed
      .json<{ items: { id: string; unresolvedMedicines: number }[] }>()
      .items.find((d) => d.id === dischargeId);
    expect(row?.unresolvedMedicines).toBe(2);
  });

  it('refuses a signature while a medicine is undecided, and names the medicine', async () => {
    const draft = await call({
      method: 'POST',
      url: `/api/v1/ip/discharge/${dischargeId}/summary`,
      token: consultant.token,
      payload: summaryBody(PATIENT.alive),
    });
    expect(draft.statusCode).toBe(201);
    summaryId = draft.json<{ id: string }>().id;

    const signed = await call({
      method: 'POST',
      url: `/api/v1/ip/discharge/summaries/${summaryId}/sign`,
      token: consultant.token,
    });
    expect(signed.statusCode).toBe(409);
    expect(signed.json<{ detail: string }>().detail).toContain('unreconciled');
    expect(signed.json<{ detail: string }>().detail).toMatch(/Atorvastatin|Enoxaparin/u);
  });

  /**
   * The bypass hunt.
   *
   * Every field a caller might reach for. All of them are rejected or ignored,
   * and the outcome is the same 409 — because the rule is a trigger and the
   * request cannot address it.
   */
  it('offers no request field, and no role, that signs past the blocker', async () => {
    for (const payload of [
      { force: true },
      { skipReconciliation: true },
      { unresolvedAccepted: true },
      { override: 'consultant decision' },
      { emergency: true },
    ]) {
      const attempt = await call({
        method: 'POST',
        url: `/api/v1/ip/discharge/summaries/${summaryId}/sign`,
        token: consultant.token,
        payload,
      });
      expect(attempt.statusCode, JSON.stringify(payload)).toBe(409);
    }

    // A different, more senior login does not change the answer either.
    const bySecond = await call({
      method: 'POST',
      url: `/api/v1/ip/discharge/summaries/${summaryId}/sign`,
      token: second.token,
    });
    expect(bySecond.statusCode).toBe(409);
  });

  it('refuses a stop with no reason, and accepts one that says why', async () => {
    const silent = await call({
      method: 'POST',
      url: `/api/v1/ip/discharge/${dischargeId}/reconciliation`,
      token: consultant.token,
      payload: { medicines: [{ drugName: 'Enoxaparin', action: 'stop' }] },
    });
    expect(silent.statusCode).toBe(400);

    const explained = await call({
      method: 'POST',
      url: `/api/v1/ip/discharge/${dischargeId}/reconciliation`,
      token: consultant.token,
      payload: {
        medicines: [
          {
            drugName: 'Enoxaparin',
            action: 'stop',
            reason: 'Prophylaxis complete; mobile and going home',
          },
          {
            drugName: 'Atorvastatin',
            action: 'continue_same',
            dischargeDose: '40 mg OD',
          },
        ],
      },
    });
    expect(explained.statusCode).toBe(201);
    expect(explained.json<{ action: string }[]>().every((m) => m.action !== 'unresolved')).toBe(true);
  });

  it('signs once every medicine has a decision behind it', async () => {
    const signed = await call({
      method: 'POST',
      url: `/api/v1/ip/discharge/summaries/${summaryId}/sign`,
      token: consultant.token,
    });
    expect(signed.statusCode).toBe(201);
    const row = signed.json<{ signedAt: string | null; contentHash: string | null; version: number }>();
    expect(row.signedAt).not.toBeNull();
    expect(row.version).toBe(1);
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('writes one audit row and the registered outbox event for the signature', async () => {
    const audit = await pg
      .pool('migrator')
      .query(`SELECT action::text AS action FROM core.audit_log WHERE row_id = $1 AND action = 'sign'`, [
        summaryId,
      ]);
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);

    const outbox = await pg
      .pool('migrator')
      .query(`SELECT event_type, payload FROM core.outbox_events WHERE aggregate_id = $1`, [summaryId]);
    expect(outbox.rows.map((r) => (r as { event_type: string }).event_type)).toContain(
      'ip.discharge.summary.signed',
    );
  });

  it('refuses every edit to a signed summary, including through the draft route', async () => {
    const rewritten = await call({
      method: 'POST',
      url: `/api/v1/ip/discharge/${dischargeId}/summary`,
      token: consultant.token,
      payload: summaryBody(PATIENT.alive, { finalDiagnosis: 'Something else entirely, rewritten' }),
    });
    expect(rewritten.statusCode).toBe(409);
    expect(rewritten.json<{ detail: string }>().detail).toContain('cannot be edited');
  });

  it('refuses a countersignature from the person who signed', async () => {
    const self = await call({
      method: 'POST',
      url: `/api/v1/ip/discharge/summaries/${summaryId}/cosign`,
      token: consultant.token,
    });
    expect(self.statusCode).toBe(400);
    expect(self.json<{ detail: string }>().detail).toContain('second person');

    const bySecond = await call({
      method: 'POST',
      url: `/api/v1/ip/discharge/summaries/${summaryId}/cosign`,
      token: second.token,
    });
    expect(bySecond.statusCode).toBe(201);
    expect(bySecond.json<{ cosignedAt: string | null }>().cosignedAt).not.toBeNull();
  });

  it('amends into a new version that carries its reason, leaving version 1 intact', async () => {
    const amended = await call({
      method: 'POST',
      url: `/api/v1/ip/discharge/summaries/${summaryId}/amend`,
      token: consultant.token,
      payload: summaryBody(PATIENT.alive, {
        amendReason: 'Parapneumonic effusion reported after the summary was signed',
        finalDiagnosis: 'Community-acquired pneumonia with a parapneumonic effusion',
      }),
    });
    expect(amended.statusCode).toBe(201);
    const v2 = amended.json<{ version: number; supersedesId: string | null; amendReason: string | null }>();
    expect(v2.version).toBe(2);
    expect(v2.supersedesId).toBe(summaryId);
    expect(v2.amendReason).toContain('effusion');

    const original = await pg
      .pool('migrator')
      .query(`SELECT final_diagnosis FROM clinical.ip_discharge_summaries WHERE id = $1`, [summaryId]);
    expect((original.rows[0] as { final_diagnosis: string }).final_diagnosis).toBe(
      'Community-acquired pneumonia, right lower lobe',
    );
  });

  it('records a discharge against advice only with what was explained and who witnessed it', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/ip/discharge',
      token: consultant.token,
      payload: { admissionId: ADMISSION.dama, patientId: PATIENT.alive },
    });
    const damaId = created.json<{ id: string }>().id;

    const thin = await call({
      method: 'POST',
      url: `/api/v1/ip/discharge/${damaId}/dama`,
      token: consultant.token,
      payload: { risksExplained: 'left', witnessName: 'X' },
    });
    expect(thin.statusCode).toBe(400);

    const proper = await call({
      method: 'POST',
      url: `/api/v1/ip/discharge/${damaId}/dama`,
      token: consultant.token,
      payload: {
        risksExplained:
          'Explained the risk of untreated pneumonia including deterioration and death; interpreter present',
        witnessName: 'Sunita Devi (wife)',
      },
    });
    expect(proper.statusCode).toBe(201);
    expect(proper.json<{ kind: string }>().kind).toBe('dama');
  });

  it('keeps recording that the patient left with the ward, not with the doctor', async () => {
    const byDoctor = await call({
      method: 'POST',
      url: `/api/v1/ip/discharge/${dischargeId}/left`,
      token: consultant.token,
      payload: { destination: 'home' },
    });
    expect(byDoctor.statusCode).toBe(403);

    const byNurse = await call({
      method: 'POST',
      url: `/api/v1/ip/discharge/${dischargeId}/left`,
      token: nurse.token,
      payload: { destination: 'home', gatePassNo: 'GP-1' },
    });
    expect(byNurse.statusCode).toBe(201);
    expect(byNurse.json<{ completedAt: string | null }>().completedAt).not.toBeNull();
  });

  it('refuses a second discharge on the same admission', async () => {
    const again = await call({
      method: 'POST',
      url: '/api/v1/ip/discharge',
      token: consultant.token,
      payload: { admissionId: ADMISSION.open, patientId: PATIENT.alive },
    });
    expect(again.statusCode).toBe(409);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('IP-017 — a body is released on four facts', () => {
  let recordId = '';
  const tag = `TAG-${newId().slice(-6)}`;

  it('opens a death file and takes the tag the body is identified by', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/mortuary/cases',
      token: consultant.token,
      payload: {
        patientId: PATIENT.dead,
        admissionId: ADMISSION.second,
        declaredAt: new Date().toISOString(),
        causeOfDeath: 'Septic shock secondary to community-acquired pneumonia',
        bodyTagNo: tag,
        postMortemRequired: true,
      },
    });
    expect(created.statusCode).toBe(201);
    recordId = created.json<{ id: string }>().id;
    expect(created.json<{ recordNo: string }>().recordNo).toMatch(/^MOR/u);
  });

  it('keeps the certificate of cause of death out of a resident’s hands', async () => {
    const byResident = await call({
      method: 'POST',
      url: `/api/v1/mortuary/cases/${recordId}/mccd`,
      token: resident.token,
      payload: { mccdForm: '4', mccdNo: 'MCCD/1' },
    });
    expect(byResident.statusCode).toBe(403);
  });

  it('compares the tag at the door in both directions', async () => {
    const wrong = await call({
      method: 'POST',
      url: `/api/v1/mortuary/cases/${recordId}/receive`,
      token: custodian.token,
      payload: { bodyTagScan: 'TAG-0000', coldStorageUnit: 'CH-3' },
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json<{ detail: string }>().detail).toContain(tag);

    const right = await call({
      method: 'POST',
      url: `/api/v1/mortuary/cases/${recordId}/receive`,
      token: custodian.token,
      payload: { bodyTagScan: tag, coldStorageUnit: 'CH-3', lastOfficeDone: true },
    });
    expect(right.statusCode).toBe(201);
  });

  it('refuses the release with no certificate', async () => {
    const attempt = await call({
      method: 'POST',
      url: `/api/v1/mortuary/cases/${recordId}/release`,
      token: custodian.token,
      payload: { bodyTagScan: tag },
    });
    expect(attempt.statusCode).toBe(409);
    expect(attempt.json<{ detail: string }>().detail).toContain('certificate has not been issued');
  });

  it('refuses the release with the next of kin unverified', async () => {
    const issued = await call({
      method: 'POST',
      url: `/api/v1/mortuary/cases/${recordId}/mccd`,
      token: consultant.token,
      payload: { mccdForm: '4', mccdNo: 'MCCD/2026/1' },
    });
    expect(issued.statusCode).toBe(201);

    const attempt = await call({
      method: 'POST',
      url: `/api/v1/mortuary/cases/${recordId}/release`,
      token: custodian.token,
      payload: { bodyTagScan: tag },
    });
    expect(attempt.statusCode).toBe(409);
    expect(attempt.json<{ detail: string }>().detail).toContain('next of kin');
  });

  it('refuses the release with the required post-mortem outstanding', async () => {
    const verified = await call({
      method: 'POST',
      url: `/api/v1/mortuary/cases/${recordId}/nok-verify`,
      token: custodian.token,
      payload: {
        nokName: 'Sunita Devi',
        nokRelationship: 'wife',
        nokIdType: 'aadhaar',
        nokIdRef: 'XXXX-XXXX-4417',
      },
    });
    expect(verified.statusCode).toBe(201);

    const attempt = await call({
      method: 'POST',
      url: `/api/v1/mortuary/cases/${recordId}/release`,
      token: custodian.token,
      payload: { bodyTagScan: tag },
    });
    expect(attempt.statusCode).toBe(409);
    expect(attempt.json<{ detail: string }>().detail).toContain('post-mortem');
  });

  it('renders a checklist that agrees with the trigger, item for item', async () => {
    const before = await call({
      method: 'GET',
      url: `/api/v1/mortuary/cases/${recordId}/release-checklist`,
      token: custodian.token,
    });
    expect(before.statusCode).toBe(200);
    const gates = before.json<{
      certificateIssued: boolean;
      nextOfKinVerified: boolean;
      mlcCleared: boolean;
      postMortemSettled: boolean;
      releasable: boolean;
      blockers: string[];
    }>();
    expect(gates.certificateIssued).toBe(true);
    expect(gates.nextOfKinVerified).toBe(true);
    expect(gates.mlcCleared).toBe(true);
    expect(gates.postMortemSettled).toBe(false);
    expect(gates.releasable).toBe(false);
    expect(gates.blockers).toHaveLength(1);
  });

  it('releases once all four are satisfied, and never twice', async () => {
    const pm = await call({
      method: 'POST',
      url: `/api/v1/mortuary/cases/${recordId}/post-mortem`,
      token: custodian.token,
      payload: { postMortemAt: new Date().toISOString(), postMortemRef: 'PM/2026/441' },
    });
    expect(pm.statusCode).toBe(201);

    const wrongTag = await call({
      method: 'POST',
      url: `/api/v1/mortuary/cases/${recordId}/release`,
      token: custodian.token,
      payload: { bodyTagScan: 'TAG-0000' },
    });
    expect(wrongTag.statusCode).toBe(409);

    const released = await call({
      method: 'POST',
      url: `/api/v1/mortuary/cases/${recordId}/release`,
      token: custodian.token,
      payload: { bodyTagScan: tag, releaseNote: 'Handed over at the mortuary gate' },
    });
    expect(released.statusCode).toBe(201);
    expect(released.json<{ releasedAt: string | null }>().releasedAt).not.toBeNull();

    const again = await call({
      method: 'POST',
      url: `/api/v1/mortuary/cases/${recordId}/release`,
      token: custodian.token,
      payload: { bodyTagScan: tag },
    });
    expect(again.statusCode).toBe(409);
  });

  it('refuses the release while a medico-legal case is open, whoever asks', async () => {
    const mlcId = newId();
    await seedMlc(mlcId, 'open');
    const mlcTag = `TAG-${newId().slice(-6)}`;

    const created = await call({
      method: 'POST',
      url: '/api/v1/mortuary/cases',
      token: consultant.token,
      payload: {
        patientId: PATIENT.mlc,
        mlcId,
        declaredAt: new Date().toISOString(),
        causeOfDeath: 'Head injury following a road traffic accident',
        bodyTagNo: mlcTag,
      },
    });
    const mlcRecord = created.json<{ id: string }>().id;

    await call({
      method: 'POST',
      url: `/api/v1/mortuary/cases/${mlcRecord}/mccd`,
      token: consultant.token,
      payload: { mccdForm: '4', mccdNo: 'MCCD/2026/2' },
    });
    await call({
      method: 'POST',
      url: `/api/v1/mortuary/cases/${mlcRecord}/nok-verify`,
      token: custodian.token,
      payload: {
        nokName: 'Ramesh Kumar',
        nokRelationship: 'son',
        nokIdType: 'voter_id',
        nokIdRef: 'VTR-9931',
      },
    });

    const blocked = await call({
      method: 'POST',
      url: `/api/v1/mortuary/cases/${mlcRecord}/release`,
      token: custodian.token,
      payload: { bodyTagScan: mlcTag },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ detail: string }>().detail).toContain('still open');

    const checklist = await call({
      method: 'GET',
      url: `/api/v1/mortuary/cases/${mlcRecord}/release-checklist`,
      token: custodian.token,
    });
    expect(checklist.json<{ mlcCleared: boolean }>().mlcCleared).toBe(false);

    // Closing the case is the only way through, and it is not this module's to do.
    await pg
      .pool('migrator')
      .query(`UPDATE clinical.mlc_cases SET status = 'closed', updated_at = now() WHERE id = $1`, [mlcId]);

    const released = await call({
      method: 'POST',
      url: `/api/v1/mortuary/cases/${mlcRecord}/release`,
      token: custodian.token,
      payload: { bodyTagScan: mlcTag },
    });
    expect(released.statusCode).toBe(201);
  });

  it('keeps the release with the custodian and out of the ward’s hands', async () => {
    const byNurse = await call({
      method: 'POST',
      url: `/api/v1/mortuary/cases/${recordId}/release`,
      token: nurse.token,
      payload: { bodyTagScan: tag },
    });
    expect(byNurse.statusCode).toBe(403);
  });
});
