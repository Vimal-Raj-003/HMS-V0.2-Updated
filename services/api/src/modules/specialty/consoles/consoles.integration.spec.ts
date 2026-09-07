import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import { CardiologyService } from './cardiology.service.js';
import { ConsolesController } from './consoles.controller.js';
import { DentalService } from './dental.service.js';
import { DermatologyService } from './dermatology.service.js';
import { EntService } from './ent.service.js';
import { PulmonologyService } from './pulmonology.service.js';

/**
 * OP-029, OP-030, OP-028, OP-026, OP-027 against a real PostgreSQL 17.
 *
 * One theme, five specialties: **the number that decides something is derived,
 * and there is no way to send it.** These tests do not check that the
 * arithmetic is right — the migration's own proofs did that. They check the
 * properties that cannot be read off the code:
 *
 *  1. **A value sent for a derived column is discarded, not honoured.** Each
 *     console gets a request carrying a wrong answer, and the response carries
 *     the right one.
 *  2. **A correction moves everything downstream with it.** An audiogram
 *     threshold corrected after the summary was written moves the summary; a
 *     tooth event appended to the log moves the chart.
 *  3. **The refusals are the database's, and they arrive as sentences.** Every
 *     gate here is a trigger, and every one of them reaches HTTP as a 409 with
 *     text a clinician can act on rather than a constraint name.
 *  4. **The three documented overrides are routes with holders**, and the two
 *     that re-price or move a safety limit demand a reason.
 *  5. **Superseding does not edit the signed document.** The plan the patient
 *     agreed to survives at the price they agreed to, cancelled.
 *
 * Ordering an investigation is deliberately absent: an ECG, a spirometry
 * trace, an audiogram, an OPG and a dermoscopy image all go through the
 * framework's `specialty/device-orders`, tested once in
 * `specialty.integration.spec.ts` and never again per console.
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

/** Holds every console's ordinary keys, and neither of the two overrides. */
const doctor = actor('console-doctor');
/** Runs the machines and interprets nothing. The split the framework insists on. */
const technician = actor('console-technician');
/** The one technician who signs, because the audiogram is their profession. */
const audiologist = actor('console-audiologist');
/** A doctor the hospital has granted the two documented overrides to. */
const overrider = actor('console-overrider');

const DOCTOR_KEYS = [
  'cardio.consult.read',
  'cardio.consult.record',
  'cardio.consult.sign',
  'cardio.ecg.record',
  'cardio.ecg.read',
  'cardio.ecg.interpret',
  'cardio.ecg.acknowledge_critical',
  'cardio.echo.report',
  'cardio.echo.sign',
  'cardio.anticoag.manage',
  'pulmo.pft.perform',
  'pulmo.pft.interpret',
  'pulmo.sleep.score',
  'pulmo.sleep.sign',
  'pulmo.pap.prescribe',
  'pulmo.pap.review_compliance',
  'ent.exam.read',
  'ent.exam.record',
  'ent.exam.sign',
  'ent.audiology.read',
  'dental.chart.read',
  'dental.chart.record',
  'dental.plan.create',
  'dental.plan.present',
  'dental.sitting.record',
  'derm.lesion.read',
  'derm.lesion.record',
  'derm.score.record',
  'derm.biopsy.manage',
  'derm.phototherapy.prescribe',
  'derm.phototherapy.deliver',
];
const TECHNICIAN_KEYS = ['cardio.ecg.record', 'cardio.ecg.read', 'pulmo.pft.perform', 'pulmo.sleep.score'];
const AUDIOLOGIST_KEYS = ['ent.audiology.perform', 'ent.audiology.read', 'ent.audiology.sign'];
const OVERRIDER_KEYS = [...DOCTOR_KEYS, 'dental.plan.supersede', 'derm.phototherapy.raise_ceiling'];

const PATIENT = newId();
const ENCOUNTER_A = newId();
const ENCOUNTER_B = newId();

// ── fixtures ─────────────────────────────────────────────────────────────────

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

async function defineSeries(key: string, pattern: string): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO core.numbering_series
       (id, hospital_id, branch_id, key, pattern, scope, fy, current_value, gapless,
        reset_policy, version, effective_from, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'branch', NULL, 0, false,
             'never', 1, now() - interval '1 day', true, now(), now())`,
    [newId(), tenants.hospitalA, tenants.branchA, key, pattern],
  );
}

async function seedActor(who: Actor, permissionKeys: readonly string[]): Promise<void> {
  const pool = pg.pool('migrator');
  const hash = await argon2.hash(PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  await pool.query(
    `INSERT INTO core.roles (id, hospital_id, key, name, description, home_workspace, category, updated_at)
     VALUES ($1, $2, $3, $4, 'Integration test role', 'doctor-opd', 'medical', now())`,
    [who.roleId, tenants.hospitalA, `role_${who.username.replace(/-/g, '_')}`, `Role ${who.username}`],
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
      tenants.hospitalA,
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
    [newId(), tenants.hospitalA, who.userId, who.roleId, tenants.branchA],
  );
}

async function seedPatientAndEncounter(encounterId: string): Promise<void> {
  const pool = pg.pool('migrator');
  const visitId = newId();
  await pool.query(
    `INSERT INTO clinical.op_visits
       (id, hospital_id, branch_id, visit_no, patient_id, status, checked_in_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'in_consult', now(), now())`,
    [visitId, tenants.hospitalA, tenants.branchA, `V-${visitId.replace(/-/g, '').slice(-10)}`, PATIENT],
  );
  await pool.query(
    `INSERT INTO clinical.encounters
       (id, hospital_id, branch_id, patient_id, visit_id, type, status, started_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'opd', 'in_progress', now(), now())`,
    [encounterId, tenants.hospitalA, tenants.branchA, PATIENT, visitId],
  );
}

async function login(identifier: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { hospitalId: tenants.hospitalA, identifier, password: PASSWORD },
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
  readonly payload?: Record<string, unknown>;
  readonly reason?: string;
}

async function call(options: CallOptions) {
  const headers: Record<string, string> = { authorization: `Bearer ${options.token}` };
  // The platform reads the reason from a header, before a body is parsed. Only
  // the two override routes need it, and they are the only calls that pass it.
  if (options.reason !== undefined) headers['x-reason'] = options.reason;
  if (options.method === 'POST') headers['idempotency-key'] = newId();
  return app.inject({
    method: options.method,
    url: options.url,
    headers,
    ...(options.method === 'GET' ? {} : { payload: options.payload ?? {} }),
  });
}

function detail(res: { json: <T>() => T }): string {
  return (res.json<{ detail?: string }>().detail ?? '').toString();
}

const appControllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as unknown[];
const alreadyWired = appControllers.includes(ConsolesController);

@Module({
  imports: [AppModule],
  controllers: alreadyWired ? [] : [ConsolesController],
  providers: alreadyWired
    ? []
    : [CardiologyService, PulmonologyService, EntService, DentalService, DermatologyService],
})
class ConsolesTestModule {}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'CONS' });
  await syncPermissions();
  await defineSeries('DENT_PLAN', 'DP{BR}{SEQ:5}');

  await seedActor(doctor, DOCTOR_KEYS);
  await seedActor(technician, TECHNICIAN_KEYS);
  await seedActor(audiologist, AUDIOLOGIST_KEYS);
  await seedActor(overrider, OVERRIDER_KEYS);

  await pg.pool('migrator').query(
    `INSERT INTO patient.patients
       (id, hospital_id, branch_id, uhid, uhid_normalised, first_name, full_name, gender, dob,
        mobile, mobile_local, dedupe_fingerprint, status, updated_at)
     VALUES ($1, $2, $3, $4, $4, 'Anwar', 'Anwar Sheikh', 'male', '1962-03-19'::date,
             '+919845000111', '9845000111', $5, 'active', now())`,
    [
      PATIENT,
      tenants.hospitalA,
      tenants.branchA,
      `UH-${PATIENT.replace(/-/g, '').slice(-10)}`,
      PATIENT.replace(/-/g, ''),
    ],
  );
  await seedPatientAndEncounter(ENCOUNTER_A);
  await seedPatientAndEncounter(ENCOUNTER_B);

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(ConsolesTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  for (const who of [doctor, technician, audiologist, overrider]) {
    who.token = await login(who.username);
  }
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

// ═════════════════════════════════════════════════════════════════════════════

describe('OP-029 · the tracing and the handover', () => {
  let ecgId = '';

  it('derives the corrected interval, and discards nothing because there is nothing to discard', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/cardio/ecgs',
      token: technician.token,
      payload: {
        patientId: PATIENT,
        source: 'device',
        acquiredAt: new Date().toISOString(),
        hr: 60,
        qtMs: 400,
        machineInterp: ['Sinus rhythm'],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; qtcMs: number; qtcProlonged: boolean }>();
    ecgId = body.id;
    // Bazett at a rate of 60: RR is one second, so QTc is the QT.
    expect(body.qtcMs).toBe(400);
    expect(body.qtcProlonged).toBe(false);
  });

  it('recomputes the corrected interval when the rate changes, and flags a prolonged one', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/cardio/ecgs',
      token: technician.token,
      payload: {
        patientId: PATIENT,
        source: 'device',
        acquiredAt: new Date().toISOString(),
        hr: 120,
        qtMs: 400,
      },
    });
    // 400 / √0.5 = 566: the same QT at twice the rate is a very different QTc,
    // and it is the number a QT-prolonging drug is screened against.
    expect(res.json<{ qtcMs: number }>().qtcMs).toBe(566);
    expect(res.json<{ qtcProlonged: boolean }>().qtcProlonged).toBe(true);
  });

  it('refuses to sign off a critical tracing until somebody has been told', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/cardio/ecgs/${ecgId}/read`,
      token: doctor.token,
      payload: { interpretation: ['Anterior STEMI'], critical: true, status: 'final' },
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toContain('cannot be signed off until the acknowledgement');
  });

  it('never lets the technician who recorded the tracing acknowledge it', async () => {
    // The whole point of the flag: the loop is closed by somebody who can act,
    // and a technician closing it on their own tracing means it reads as closed
    // while nobody was told.
    const res = await call({
      method: 'POST',
      url: `/api/v1/cardio/ecgs/${ecgId}/acknowledge`,
      token: technician.token,
      payload: { toldTo: 'Dr Rao' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('signs once the handover names a person, and shows it on the worklist until then', async () => {
    const preliminary = await call({
      method: 'POST',
      url: `/api/v1/cardio/ecgs/${ecgId}/read`,
      token: doctor.token,
      payload: { interpretation: ['Anterior STEMI'], critical: true, status: 'preliminary' },
    });
    expect(preliminary.statusCode).toBe(201);
    expect(preliminary.json<{ awaitingAcknowledgement: boolean }>().awaitingAcknowledgement).toBe(true);

    const waiting = await call({
      method: 'GET',
      url: '/api/v1/cardio/ecgs?unacknowledgedOnly=true',
      token: doctor.token,
    });
    expect(waiting.json<{ id: string }[]>().map((e) => e.id)).toContain(ecgId);

    const ack = await call({
      method: 'POST',
      url: `/api/v1/cardio/ecgs/${ecgId}/acknowledge`,
      token: doctor.token,
      payload: { toldTo: 'Dr Rao, cath lab, by telephone' },
    });
    expect(ack.statusCode).toBe(201);
    expect(ack.json<{ criticalAckTo: string }>().criticalAckTo).toContain('cath lab');
    // The acknowledger is the session, never the body.
    expect(ack.json<{ criticalAckBy: string }>().criticalAckBy).toBe(doctor.userId);

    const signed = await call({
      method: 'POST',
      url: `/api/v1/cardio/ecgs/${ecgId}/read`,
      token: doctor.token,
      payload: { interpretation: ['Anterior STEMI'], critical: true, status: 'final' },
    });
    expect(signed.statusCode).toBe(201);
    expect(signed.json<{ status: string }>().status).toBe('final');

    const stillWaiting = await call({
      method: 'GET',
      url: '/api/v1/cardio/ecgs?unacknowledgedOnly=true',
      token: doctor.token,
    });
    expect(stillWaiting.json<{ id: string }[]>().map((e) => e.id)).not.toContain(ecgId);
  });

  it('refuses a warfarin grid that does not add up to its weekly dose', async () => {
    const enrol = await call({
      method: 'POST',
      url: '/api/v1/cardio/anticoagulation',
      token: doctor.token,
      payload: {
        patientId: PATIENT,
        drug: 'warfarin',
        indication: 'Mechanical mitral valve',
        targetInrLow: 2.5,
        targetInrHigh: 3.5,
        startDate: '2026-09-01',
      },
    });
    expect(enrol.statusCode).toBe(201);
    const enrolmentId = enrol.json<{ id: string }>().id;

    const wrong = await call({
      method: 'POST',
      url: `/api/v1/cardio/anticoagulation/${enrolmentId}/visits`,
      token: doctor.token,
      payload: {
        measuredAt: new Date().toISOString(),
        inr: 2.8,
        source: 'lab',
        weeklyDoseMg: 21,
        doseGrid: [3, 3, 3, 3, 3, 3, 5],
      },
    });
    expect(wrong.statusCode).toBe(400);

    const right = await call({
      method: 'POST',
      url: `/api/v1/cardio/anticoagulation/${enrolmentId}/visits`,
      token: doctor.token,
      payload: {
        measuredAt: new Date().toISOString(),
        inr: 2.8,
        source: 'lab',
        weeklyDoseMg: 22.5,
        doseGrid: [2.5, 2.5, 5, 2.5, 2.5, 5, 2.5],
      },
    });
    expect(right.statusCode).toBe(201);
    // In range against this enrolment's own window, reported rather than typed.
    expect(right.json<{ inRange: boolean }>().inRange).toBe(true);
  });

  it('refuses a target INR range on a drug that is not monitored by INR', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/cardio/anticoagulation',
      token: doctor.token,
      payload: {
        patientId: PATIENT,
        drug: 'doac',
        indication: 'Atrial fibrillation',
        targetInrLow: 2,
        targetInrHigh: 3,
        startDate: '2026-09-01',
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('OP-030 · the ratio, the reversibility and the effort', () => {
  let studyId = '';

  it('derives the ratio and the reversibility from the litres the device produced', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/pulmo/pft',
      token: technician.token,
      payload: {
        patientId: PATIENT,
        performedAt: new Date().toISOString(),
        tests: ['spiro', 'bd'],
        qualityGrade: 'A',
        preFvc: 3.0,
        preFev1: 2.0,
        postFvc: 3.2,
        postFev1: 2.3,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      id: string;
      preRatio: number;
      revFev1Pct: number;
      revFev1Ml: number;
      reversible: boolean;
    }>();
    studyId = body.id;
    expect(body.preRatio).toBe(0.667);
    expect(body.revFev1Pct).toBe(15);
    expect(body.revFev1Ml).toBe(300);
    expect(body.reversible).toBe(true);
  });

  it('needs both ATS/ERS thresholds, not either', async () => {
    // 200 mL is met; 10 per cent is not. A report calling this "reversible"
    // is a diagnosis of asthma in a patient with COPD, and it is invisible
    // afterwards because the wrong answer and the right one look identical.
    const res = await call({
      method: 'POST',
      url: '/api/v1/pulmo/pft',
      token: technician.token,
      payload: {
        patientId: PATIENT,
        performedAt: new Date().toISOString(),
        qualityGrade: 'B',
        preFvc: 3.0,
        preFev1: 2.0,
        postFvc: 3.0,
        postFev1: 2.2,
      },
    });
    const body = res.json<{ revFev1Ml: number; revFev1Pct: number; reversible: boolean }>();
    expect(body.revFev1Ml).toBe(200);
    expect(body.revFev1Pct).toBe(10);
    expect(body.reversible).toBe(false);
  });

  it('refuses to sign an unacceptable effort, and says to repeat the manoeuvre', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/pulmo/pft/${studyId}/interpret`,
      token: doctor.token,
      payload: { interpretation: 'Reversible airflow obstruction.', qualityGrade: 'F' },
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toContain('repeat the manoeuvre');

    const ok = await call({
      method: 'POST',
      url: `/api/v1/pulmo/pft/${studyId}/interpret`,
      token: doctor.token,
      payload: { interpretation: 'Reversible airflow obstruction; asthma.', qualityGrade: 'B' },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json<{ unsignable: boolean }>().unsignable).toBe(false);
  });

  it('never lets the technician who ran the study interpret it', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/pulmo/pft/${studyId}/interpret`,
      token: technician.token,
      payload: { interpretation: 'Normal.', qualityGrade: 'A' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('derives apnoea severity from the index, in both directions', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/pulmo/sleep-studies',
      token: technician.token,
      payload: { patientId: PATIENT, type: 'psg', scheduledAt: new Date().toISOString() },
    });
    const id = created.json<{ id: string }>().id;

    // 14.6 is mild. Rounding it up funds a machine that is not indicated.
    const mild = await call({
      method: 'POST',
      url: `/api/v1/pulmo/sleep-studies/${id}/score`,
      token: technician.token,
      payload: { ahi: 14.6, scored: { odi: 11 } },
    });
    expect(mild.json<{ severity: string }>().severity).toBe('mild');

    // 31 is severe. Rounding it down avoids a conversation about driving.
    const severe = await call({
      method: 'POST',
      url: `/api/v1/pulmo/sleep-studies/${id}/score`,
      token: technician.token,
      payload: { ahi: 31, scored: { odi: 28 } },
    });
    expect(severe.json<{ severity: string }>().severity).toBe('severe');
  });

  it('refuses a bilevel prescription whose IPAP is below its EPAP', async () => {
    const inverted = await call({
      method: 'POST',
      url: '/api/v1/pulmo/pap',
      token: doctor.token,
      payload: { patientId: PATIENT, mode: 'bipap', epap: 12, ipap: 8, startDate: '2026-09-08' },
    });
    expect(inverted.statusCode).toBe(400);
    expect(detail(inverted)).toContain('cannot deliver a breath');

    const ranged = await call({
      method: 'POST',
      url: '/api/v1/pulmo/pap',
      token: doctor.token,
      payload: { patientId: PATIENT, mode: 'cpap', pressureMin: 6, pressureMax: 12, startDate: '2026-09-08' },
    });
    expect(ranged.statusCode).toBe(400);

    const ok = await call({
      method: 'POST',
      url: '/api/v1/pulmo/pap',
      token: doctor.token,
      payload: { patientId: PATIENT, mode: 'bipap', epap: 8, ipap: 14, startDate: '2026-09-08' },
    });
    expect(ok.statusCode).toBe(201);
  });
});

describe('OP-028 · the booth', () => {
  let testId = '';

  const quad = (ear: string, conduction: string, dbs: readonly number[]) =>
    [500, 1000, 2000, 4000].map((freqHz, i) => ({
      ear,
      conduction,
      freqHz,
      thresholdDb: dbs[i] ?? 0,
    }));

  it('lets the audiologist run and sign, which no other technician may do', async () => {
    const denied = await call({
      method: 'POST',
      url: '/api/v1/ent/audiology',
      token: doctor.token,
      payload: {
        patientId: PATIENT,
        testType: 'pta',
        performedAt: new Date().toISOString(),
        calibrationOk: true,
      },
    });
    expect(denied.statusCode).toBe(403);

    const res = await call({
      method: 'POST',
      url: '/api/v1/ent/audiology',
      token: audiologist.token,
      payload: {
        patientId: PATIENT,
        testType: 'pta',
        performedAt: new Date().toISOString(),
        calibrationOk: true,
      },
    });
    expect(res.statusCode).toBe(201);
    testId = res.json<{ id: string }>().id;
  });

  it('derives the four-frequency average, the degree and the type from the thresholds', async () => {
    const filed = await call({
      method: 'POST',
      url: `/api/v1/ent/audiology/${testId}/thresholds`,
      token: audiologist.token,
      payload: {
        thresholds: [...quad('right', 'ac', [40, 45, 50, 55]), ...quad('right', 'bc', [40, 45, 50, 55])],
      },
    });
    expect(filed.statusCode).toBe(201);

    // The request carries no average, no degree and no type: there are no such
    // fields. A disability certificate is issued on all three.
    const res = await call({
      method: 'POST',
      url: `/api/v1/ent/audiology/${testId}/results`,
      token: audiologist.token,
      payload: { ear: 'right', srt: 50, sdsPct: 88 },
    });
    const right = res
      .json<{ results: { ear: string; ptaAvg: number; degree: string; type: string }[] }>()
      .results.find((r) => r.ear === 'right');
    expect(right?.ptaAvg).toBe(47.5);
    expect(right?.degree).toBe('moderate');
    // Air and bone agree, so there is no gap: sensorineural.
    expect(right?.type).toBe('snhl');
  });

  it('moves the derived summary when a threshold is corrected', async () => {
    await call({
      method: 'POST',
      url: `/api/v1/ent/audiology/${testId}/thresholds`,
      token: audiologist.token,
      payload: { thresholds: [{ ear: 'right', conduction: 'ac', freqHz: 4000, thresholdDb: 80 }] },
    });
    const res = await call({
      method: 'GET',
      url: `/api/v1/ent/audiology/${testId}`,
      token: audiologist.token,
    });
    const right = res
      .json<{ results: { ear: string; ptaAvg: number }[] }>()
      .results.find((r) => r.ear === 'right');
    // 40, 45, 50, 80 → 53.8. A graph and a summary that disagree describe
    // different ears.
    expect(right?.ptaAvg).toBe(53.8);
  });

  it('refuses a bone threshold better than air by more than measurement noise', async () => {
    await call({
      method: 'POST',
      url: `/api/v1/ent/audiology/${testId}/thresholds`,
      token: audiologist.token,
      payload: { thresholds: [{ ear: 'left', conduction: 'bc', freqHz: 1000, thresholdDb: 55 }] },
    });

    const impossible = await call({
      method: 'POST',
      url: `/api/v1/ent/audiology/${testId}/thresholds`,
      token: audiologist.token,
      payload: { thresholds: [{ ear: 'left', conduction: 'ac', freqHz: 1000, thresholdDb: 30 }] },
    });
    expect(impossible.statusCode).toBe(409);
    expect(detail(impossible)).toContain('check the masking');

    const noise = await call({
      method: 'POST',
      url: `/api/v1/ent/audiology/${testId}/thresholds`,
      token: audiologist.token,
      payload: { thresholds: [{ ear: 'left', conduction: 'ac', freqHz: 1000, thresholdDb: 45 }] },
    });
    expect(noise.statusCode).toBe(201);
  });

  it('refuses a bone threshold at a frequency no bone vibrator is calibrated at', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/ent/audiology/${testId}/thresholds`,
      token: audiologist.token,
      payload: { thresholds: [{ ear: 'left', conduction: 'bc', freqHz: 8000, thresholdDb: 40 }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a threshold that names both ears, because an audiogram has two curves', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/ent/audiology/${testId}/thresholds`,
      token: audiologist.token,
      payload: { thresholds: [{ ear: 'bilateral', conduction: 'ac', freqHz: 2000, thresholdDb: 40 }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses to sign a test run on an unverified audiometer', async () => {
    const uncalibrated = await call({
      method: 'POST',
      url: '/api/v1/ent/audiology',
      token: audiologist.token,
      payload: {
        patientId: PATIENT,
        testType: 'pta',
        performedAt: new Date().toISOString(),
        calibrationOk: false,
      },
    });
    // It can be opened — the test happened, and pretending it did not is worse.
    expect(uncalibrated.statusCode).toBe(201);

    const res = await call({
      method: 'POST',
      url: `/api/v1/ent/audiology/${uncalibrated.json<{ id: string }>().id}/sign`,
      token: audiologist.token,
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toContain('not a measurement of hearing');

    const signed = await call({
      method: 'POST',
      url: `/api/v1/ent/audiology/${testId}/sign`,
      token: audiologist.token,
    });
    expect(signed.statusCode).toBe(201);
  });
});

describe('OP-026 · the chart nobody writes', () => {
  it('refuses a surface the tooth does not have, in both directions', async () => {
    const incisorOcclusal = await call({
      method: 'POST',
      url: '/api/v1/dental/tooth-events',
      token: doctor.token,
      payload: {
        patientId: PATIENT,
        toothFdi: 11,
        surfaces: ['O'],
        conditionCode: 'filling_composite',
        status: 'done',
      },
    });
    expect(incisorOcclusal.statusCode).toBe(409);
    expect(detail(incisorOcclusal)).toContain('incisal edge');

    const molarIncisal = await call({
      method: 'POST',
      url: '/api/v1/dental/tooth-events',
      token: doctor.token,
      payload: {
        patientId: PATIENT,
        toothFdi: 36,
        surfaces: ['I'],
        conditionCode: 'filling_composite',
        status: 'done',
      },
    });
    expect(molarIncisal.statusCode).toBe(409);

    const ok = await call({
      method: 'POST',
      url: '/api/v1/dental/tooth-events',
      token: doctor.token,
      payload: {
        patientId: PATIENT,
        toothFdi: 36,
        surfaces: ['O'],
        conditionCode: 'filling_composite',
        status: 'done',
      },
    });
    expect(ok.statusCode).toBe(201);
  });

  it('refuses a tooth number that is not a tooth', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/dental/tooth-events',
      token: doctor.token,
      payload: { patientId: PATIENT, toothFdi: 19, conditionCode: 'caries', status: 'existing' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses new work on an extracted tooth, and allows what goes into the socket', async () => {
    const extract = await call({
      method: 'POST',
      url: '/api/v1/dental/tooth-events',
      token: doctor.token,
      payload: { patientId: PATIENT, toothFdi: 46, conditionCode: 'extraction', status: 'done' },
    });
    expect(extract.statusCode).toBe(201);

    const crown = await call({
      method: 'POST',
      url: '/api/v1/dental/tooth-events',
      token: doctor.token,
      payload: { patientId: PATIENT, toothFdi: 46, conditionCode: 'crown_pfm', status: 'planned' },
    });
    expect(crown.statusCode).toBe(409);
    expect(detail(crown)).toContain('recorded absent');

    const implant = await call({
      method: 'POST',
      url: '/api/v1/dental/tooth-events',
      token: doctor.token,
      payload: { patientId: PATIENT, toothFdi: 46, conditionCode: 'implant', status: 'planned' },
    });
    expect(implant.statusCode).toBe(201);
  });

  it('materialises the chart and the DMFT from the log, with no route that writes either', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/dental/charts/${PATIENT}`,
      token: doctor.token,
    });
    const body = res.json<{
      chart: { state: Record<string, unknown>; dmft: number };
      events: unknown[];
    }>();
    // 36 filled and 46 extracted.
    expect(Object.keys(body.chart.state).sort()).toEqual(['36', '46']);
    expect(body.chart.dmft).toBe(2);
    expect(body.events.length).toBeGreaterThan(0);

    // The application role holds no privilege on the chart at all — the trigger
    // writes it as the owner. This is what makes "derived" a fact rather than a
    // convention somebody can forget.
    const { rows } = await pg.pool('migrator').query<{ ins: boolean; upd: boolean; del: boolean }>(
      `SELECT has_table_privilege('hms_app','specialty.dental_charts','INSERT') AS ins,
                has_table_privilege('hms_app','specialty.dental_charts','UPDATE') AS upd,
                has_table_privilege('hms_app','specialty.dental_charts','DELETE') AS del`,
    );
    expect(rows[0]).toEqual({ ins: false, upd: false, del: false });
  });

  it('locks an accepted plan’s prices, and supersedes rather than editing', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/dental/plans',
      token: doctor.token,
      payload: {
        patientId: PATIENT,
        items: [{ procedureCode: 'D2740', description: 'Crown, porcelain', teeth: [36], unitPrice: 12000 }],
      },
    });
    expect(created.statusCode).toBe(201);
    const planId = created.json<{ id: string; planNo: string }>().id;

    // A plan is presented before it is accepted. Acceptance without a
    // presentation is a signature on a document nobody showed anybody.
    const early = await call({
      method: 'POST',
      url: `/api/v1/dental/plans/${planId}/accept`,
      token: doctor.token,
      payload: { acceptedVia: 'esign' },
    });
    expect(early.statusCode).toBe(409);

    await call({ method: 'POST', url: `/api/v1/dental/plans/${planId}/present`, token: doctor.token });
    const accepted = await call({
      method: 'POST',
      url: `/api/v1/dental/plans/${planId}/accept`,
      token: doctor.token,
      payload: { acceptedVia: 'esign' },
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json<{ priceLocked: boolean }>().priceLocked).toBe(true);

    // The doctor cannot re-price it: superseding ships unassigned.
    const denied = await call({
      method: 'POST',
      url: `/api/v1/dental/plans/${planId}/supersede`,
      token: doctor.token,
      reason: 'Laboratory metal price revised.',
      payload: {
        patientId: PATIENT,
        items: [{ procedureCode: 'D2740', description: 'Crown, porcelain', teeth: [36], unitPrice: 18000 }],
        reason: 'Laboratory metal price revised.',
      },
    });
    expect(denied.statusCode).toBe(403);

    // With the key granted, and only with a reason.
    const noReason = await call({
      method: 'POST',
      url: `/api/v1/dental/plans/${planId}/supersede`,
      token: overrider.token,
      payload: {
        patientId: PATIENT,
        items: [{ procedureCode: 'D2740', description: 'Crown, porcelain', teeth: [36], unitPrice: 18000 }],
        reason: 'Laboratory metal price revised.',
      },
    });
    expect(noReason.statusCode).toBe(403);

    const superseded = await call({
      method: 'POST',
      url: `/api/v1/dental/plans/${planId}/supersede`,
      token: overrider.token,
      reason: 'Laboratory metal price revised; patient to be re-quoted.',
      payload: {
        patientId: PATIENT,
        items: [{ procedureCode: 'D2740', description: 'Crown, porcelain', teeth: [36], unitPrice: 18000 }],
        reason: 'Laboratory metal price revised; patient to be re-quoted.',
      },
    });
    expect(superseded.statusCode).toBe(201);
    const replacement = superseded.json<{
      id: string;
      status: string;
      priceLocked: boolean;
      items: { unitPrice: number }[];
    }>();
    // A draft, not a version bump: it has to be presented and consented to
    // again, which is the whole point.
    expect(replacement.status).toBe('draft');
    expect(replacement.priceLocked).toBe(false);
    expect(replacement.items[0]?.unitPrice).toBe(18000);
    expect(replacement.id).not.toBe(planId);

    // And the document the patient signed survives, at the price they agreed.
    const list = await call({
      method: 'GET',
      url: `/api/v1/dental/plans?patientId=${PATIENT}&openOnly=false`,
      token: doctor.token,
    });
    const old = list
      .json<{ id: string; status: string; items: { unitPrice: number }[] }[]>()
      .find((p) => p.id === planId);
    expect(old?.status).toBe('cancelled');
    expect(old?.items[0]?.unitPrice).toBe(12000);

    // The override is on the audit trail, with its reason.
    const { rows } = await pg.pool('migrator').query<{ reason_text: string }>(
      `SELECT reason_text FROM core.audit_log
          WHERE entity = 'dental_treatment_plan' AND action = 'override' AND row_id = $1`,
      [planId],
    );
    expect(rows[0]?.reason_text).toContain('re-quoted');
  });
});

describe('OP-027 · the score and the ceiling', () => {
  let courseId = '';

  it('computes PASI from its components and discards the value that was sent', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/derm/scores',
      token: doctor.token,
      payload: {
        patientId: PATIENT,
        scoreType: 'pasi',
        // A number that would keep a biologic funded, sent deliberately.
        value: 4,
        components: {
          head: { area: 2, erythema: 2, induration: 2, desquamation: 2 },
          upperLimbs: { area: 3, erythema: 2, induration: 2, desquamation: 2 },
          trunk: { area: 4, erythema: 2, induration: 2, desquamation: 2 },
          lowerLimbs: { area: 5, erythema: 2, induration: 2, desquamation: 2 },
        },
      },
    });
    expect(res.statusCode).toBe(201);
    // 0.1·2·6 + 0.2·3·6 + 0.3·4·6 + 0.4·5·6 = 24.
    expect(res.json<{ value: number }>().value).toBe(24);
    expect(res.json<{ derived: boolean }>().derived).toBe(true);
  });

  it('refuses a PASI with no components, and leaves a questionnaire total alone', async () => {
    const bare = await call({
      method: 'POST',
      url: '/api/v1/derm/scores',
      token: doctor.token,
      payload: { patientId: PATIENT, scoreType: 'pasi', value: 12 },
    });
    expect(bare.statusCode).toBe(409);

    const dlqi = await call({
      method: 'POST',
      url: '/api/v1/derm/scores',
      token: doctor.token,
      payload: { patientId: PATIENT, scoreType: 'dlqi', value: 17, components: { q1: 3 } },
    });
    expect(dlqi.json<{ value: number }>().value).toBe(17);
    expect(dlqi.json<{ derived: boolean }>().derived).toBe(false);
  });

  it('refuses a phototherapy course with no eye shielding recorded', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/derm/phototherapy',
      token: doctor.token,
      payload: {
        patientId: PATIENT,
        modality: 'nbuvb',
        skinType: 2,
        startDoseMj: 200,
        incrementPct: 20,
        maxDoseMj: 1500,
        freqPerWeek: 3,
        shielding: { genitals: 'shield' },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('suggests the next dose, refuses above the ceiling, and stops climbing after erythema', async () => {
    const course = await call({
      method: 'POST',
      url: '/api/v1/derm/phototherapy',
      token: doctor.token,
      payload: {
        patientId: PATIENT,
        modality: 'nbuvb',
        skinType: 3,
        startDoseMj: 300,
        incrementPct: 20,
        maxDoseMj: 2000,
        freqPerWeek: 3,
        shielding: { eyes: 'goggles', genitals: 'shield' },
      },
    });
    expect(course.statusCode).toBe(201);
    courseId = course.json<{ id: string }>().id;
    expect(course.json<{ suggestedNextDoseMj: number }>().suggestedNextDoseMj).toBe(300);

    const first = await call({
      method: 'POST',
      url: `/api/v1/derm/phototherapy/${courseId}/sessions`,
      token: doctor.token,
      payload: { doseMj: 300, erythemaGrade: 0 },
    });
    expect(first.statusCode).toBe(201);

    const second = await call({
      method: 'POST',
      url: `/api/v1/derm/phototherapy/${courseId}/sessions`,
      token: doctor.token,
      payload: { doseMj: 360, erythemaGrade: 2 },
    });
    expect(second.statusCode).toBe(201);

    const escalation = await call({
      method: 'POST',
      url: `/api/v1/derm/phototherapy/${courseId}/sessions`,
      token: doctor.token,
      payload: { doseMj: 430, erythemaGrade: 0 },
    });
    expect(escalation.statusCode).toBe(409);
    expect(detail(escalation)).toContain('grade 2 erythema');

    const overCeiling = await call({
      method: 'POST',
      url: `/api/v1/derm/phototherapy/${courseId}/sessions`,
      token: doctor.token,
      payload: { doseMj: 2500, erythemaGrade: 0 },
    });
    expect(overCeiling.statusCode).toBe(409);
    expect(detail(overCeiling)).toContain('ceiling');

    const held = await call({
      method: 'POST',
      url: `/api/v1/derm/phototherapy/${courseId}/sessions`,
      token: doctor.token,
      payload: { doseMj: 360, erythemaGrade: 1 },
    });
    expect(held.statusCode).toBe(201);

    // The cumulative dose is a sum, so it is summed: 300 + 360 + 360.
    const courses = await call({
      method: 'GET',
      url: `/api/v1/derm/phototherapy?patientId=${PATIENT}&openOnly=true`,
      token: doctor.token,
    });
    const mine = courses
      .json<{ id: string; cumulativeDoseMj: number; sessionsCount: number }[]>()
      .find((c) => c.id === courseId);
    expect(mine?.cumulativeDoseMj).toBe(1020);
    expect(mine?.sessionsCount).toBe(3);
  });

  it('keeps the dose ceiling out of the hands of the room that delivers the dose', async () => {
    const denied = await call({
      method: 'POST',
      url: `/api/v1/derm/phototherapy/${courseId}/ceiling`,
      token: doctor.token,
      reason: 'Plateau at 2000 mJ with persistent plaques.',
      payload: { maxDoseMj: 3000, reason: 'Plateau at 2000 mJ with persistent plaques.' },
    });
    expect(denied.statusCode).toBe(403);

    const raised = await call({
      method: 'POST',
      url: `/api/v1/derm/phototherapy/${courseId}/ceiling`,
      token: overrider.token,
      reason: 'Plateau at 2000 mJ with persistent plaques; prescriber reviewed.',
      payload: {
        maxDoseMj: 3000,
        reason: 'Plateau at 2000 mJ with persistent plaques; prescriber reviewed.',
      },
    });
    expect(raised.statusCode).toBe(201);
    expect(raised.json<{ maxDoseMj: number }>().maxDoseMj).toBe(3000);

    const { rows } = await pg.pool('migrator').query<{ reason_text: string }>(
      `SELECT reason_text FROM core.audit_log
          WHERE entity = 'derm_phototherapy_course' AND action = 'override' AND row_id = $1`,
      [courseId],
    );
    expect(rows[0]?.reason_text).toContain('prescriber reviewed');
  });

  it('refuses to close a malignant biopsy without a follow-up', async () => {
    const lesion = await call({
      method: 'POST',
      url: '/api/v1/derm/lesions',
      token: doctor.token,
      payload: { patientId: PATIENT, regionKey: 'back_upper', morphology: 'macule', sizeMm: 6 },
    });
    expect(lesion.statusCode).toBe(201);
    const lesionId = lesion.json<{ id: string }>().id;

    const biopsy = await call({
      method: 'POST',
      url: '/api/v1/derm/biopsies',
      token: doctor.token,
      payload: { patientId: PATIENT, lesionId, type: 'punch', clinicalDx: 'Suspected BCC' },
    });
    const biopsyId = biopsy.json<{ id: string }>().id;

    const open = await call({
      method: 'POST',
      url: `/api/v1/derm/biopsies/${biopsyId}/result`,
      token: doctor.token,
      payload: {
        resultSummary: 'Basal cell carcinoma, margins involved',
        malignancyFlag: true,
        margins: 'involved',
        status: 'reviewed',
      },
    });
    expect(open.statusCode).toBe(409);
    expect(detail(open)).toContain('follow-up task');

    const closed = await call({
      method: 'POST',
      url: `/api/v1/derm/biopsies/${biopsyId}/result`,
      token: doctor.token,
      payload: {
        resultSummary: 'Basal cell carcinoma, margins involved',
        malignancyFlag: true,
        margins: 'involved',
        followupTaskId: newId(),
        status: 'reviewed',
      },
    });
    expect(closed.statusCode).toBe(201);
    expect(closed.json<{ awaitingFollowup: boolean }>().awaitingFollowup).toBe(false);
  });
});
