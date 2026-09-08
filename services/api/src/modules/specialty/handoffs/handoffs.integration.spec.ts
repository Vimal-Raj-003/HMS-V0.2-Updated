import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import { HandoffsController } from './handoffs.controller.js';
import { HandoffsService } from './handoffs.service.js';

/**
 * OP-018, OP-021 and IP-020 against a real PostgreSQL 17.
 *
 * Three modules with one failure between them — the hand-off happens and
 * nobody watches for what should come back — and four rules:
 *
 *  1. **Nothing scheduled under the NDPS Act is prescribable by telemedicine**,
 *     in any mode, on any consultation, by anybody.
 *  2. **List A on a first consultation needs video; List B needs a follow-up.**
 *  3. **A referral's reply is due on a clock derived from its urgency**, and it
 *     cannot be closed unanswered.
 *  4. **A pathway variance carries a reason and one of four categories**, and
 *     adherence is counted rather than typed.
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

/** Runs the tele-clinic, raises referrals, starts pathways. */
const doctor = actor('ho-doctor');
/** Records pathway steps at the bedside. Cannot start one, cannot prescribe. */
const nurse = actor('ho-nurse');
/** The external clinician who answers a referral and raises none. */
const external = actor('ho-external');

const DOCTOR_KEYS = [
  'tele.read',
  'tele.consult.conduct',
  'tele.prescribe',
  'referral.read',
  'referral.raise',
  'referral.reply',
  'pathway.read',
  'pathway.start',
  'pathway.step.record',
];
const NURSE_KEYS = ['pathway.read', 'pathway.step.record', 'referral.read'];
const EXTERNAL_KEYS = ['referral.read', 'referral.reply'];

const PATIENT = newId();
const PRACTITIONER = newId();
let ENCOUNTER = '';

/** What the suites hand each other. */
const state = { videoFirst: '', audioFirst: '', followUp: '', referral: '', urgent: '', pathway: '' };

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
        false,
        p.phiRead ?? false,
        p.clinicalSafetyExempt ?? false,
      ],
    );
  }
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
     VALUES ($1, $2, $3, $4, 'Integration test role', 'nurse-opd', 'nursing', now())`,
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

async function seedPatientAndEncounter(): Promise<string> {
  const pool = pg.pool('migrator');
  await pool.query(
    `INSERT INTO patient.patients
       (id, hospital_id, branch_id, uhid, uhid_normalised, first_name, full_name, gender, dob,
        mobile, mobile_local, dedupe_fingerprint, status, updated_at)
     VALUES ($1, $2, $3, $4, $4, 'Anita', 'Anita Sharma', 'female', '1988-06-11',
             '+919845001234', '9845001234', $4, 'active', now())`,
    [PATIENT, tenants.hospitalA, tenants.branchA, `UH-${PATIENT.replace(/-/g, '').slice(-10)}`],
  );

  const visitId = newId();
  const encounterId = newId();
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
  return encounterId;
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

/** The per-field messages, which is where a Zod refusal says what it refused. */
function fieldErrors(res: { json: <T>() => T }): string {
  const body = res.json<{ errors?: { path?: string; message?: string }[] }>();
  return (body.errors ?? []).map((e) => `${e.path ?? ''}: ${e.message ?? ''}`).join(' | ');
}

/** A consultation, with the mode and the first-contact flag that the lists read. */
function consultPayload(over: Record<string, unknown>): Record<string, unknown> {
  return {
    patientId: PATIENT,
    practitionerId: PRACTITIONER,
    practitionerRegNo: 'TN/2011/45781',
    mode: 'video',
    firstConsult: true,
    identityVerification: { method: 'abha', value: 'XX-XXXX-XXXX-1234' },
    startedAt: new Date().toISOString(),
    complaint: 'Fever and sore throat for three days.',
    ...over,
  };
}

const appControllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as unknown[];
const alreadyWired = appControllers.includes(HandoffsController);

@Module({
  imports: [AppModule],
  controllers: alreadyWired ? [] : [HandoffsController],
  providers: alreadyWired ? [] : [HandoffsService],
})
class HandoffsTestModule {}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'HO' });
  await syncPermissions();

  await seedActor(doctor, DOCTOR_KEYS);
  await seedActor(nurse, NURSE_KEYS);
  await seedActor(external, EXTERNAL_KEYS);

  ENCOUNTER = await seedPatientAndEncounter();

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(HandoffsTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();

  for (const who of [doctor, nurse, external]) {
    who.token = await login(who.username);
  }
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe('OP-018 · the four lists', () => {
  it('opens consultations, and says which lists each can reach before a drug is typed', async () => {
    const video = await call({
      method: 'POST',
      url: '/api/v1/tele/consults',
      token: doctor.token,
      payload: consultPayload({}),
    });
    expect(video.statusCode, video.body).toBe(201);
    state.videoFirst = video.json<{ id: string }>().id;
    // A first consultation by video reaches List O and List A, and not List B.
    expect(video.json<{ reachableLists: string[] }>().reachableLists).toEqual(['list_o', 'list_a']);

    const audio = await call({
      method: 'POST',
      url: '/api/v1/tele/consults',
      token: doctor.token,
      payload: consultPayload({ mode: 'audio' }),
    });
    expect(audio.statusCode, audio.body).toBe(201);
    state.audioFirst = audio.json<{ id: string }>().id;
    expect(audio.json<{ reachableLists: string[] }>().reachableLists).toEqual(['list_o']);
    expect(audio.json<{ blockedBy: string[] }>().blockedBy).toContain(
      'List A needs video on a first consultation',
    );

    const follow = await call({
      method: 'POST',
      url: '/api/v1/tele/consults',
      token: doctor.token,
      payload: consultPayload({ mode: 'audio', firstConsult: false, followsConsultId: state.videoFirst }),
    });
    expect(follow.statusCode, follow.body).toBe(201);
    state.followUp = follow.json<{ id: string }>().id;
    // A follow-up reaches all three, by audio, because the doctor has already
    // seen this patient.
    expect(follow.json<{ reachableLists: string[] }>().reachableLists).toEqual([
      'list_o',
      'list_a',
      'list_b',
    ]);
  });

  it('refuses a follow-up that does not say what it follows', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/tele/consults',
      token: doctor.token,
      payload: consultPayload({ firstConsult: false }),
    });
    expect(res.statusCode).toBe(400);
    expect(fieldErrors(res)).toContain('follows');
  });

  it('refuses a consultation the patient did not start with no consent recorded', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/tele/consults',
      token: doctor.token,
      payload: consultPayload({ initiatedBy: 'practitioner' }),
    });
    expect(res.statusCode).toBe(400);
    expect(fieldErrors(res)).toContain('consent');
  });

  it('never lets a prohibited drug through, in any mode or consultation type', async () => {
    // The one absolute in the Telemedicine Practice Guidelines. There is no
    // permission, no mode and no follow-up that reaches it.
    for (const consultId of [state.videoFirst, state.audioFirst, state.followUp]) {
      const res = await call({
        method: 'POST',
        url: `/api/v1/tele/consults/${consultId}/prescriptions`,
        token: doctor.token,
        payload: {
          drugKey: 'morphine',
          drugName: 'Morphine sulphate 10 mg',
          dose: '10 mg',
          frequency: 'Q4H',
          durationDays: 5,
        },
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(detail(res)).toContain('Narcotic Drugs and Psychotropic Substances Act');
    }
  });

  it('gates List A on video and List B on a follow-up', async () => {
    const audioA = await call({
      method: 'POST',
      url: `/api/v1/tele/consults/${state.audioFirst}/prescriptions`,
      token: doctor.token,
      payload: {
        drugKey: 'azithromycin',
        drugName: 'Azithromycin 500 mg',
        dose: '500 mg',
        frequency: 'OD',
        durationDays: 3,
      },
    });
    expect(audioA.statusCode).toBe(409);
    expect(detail(audioA)).toContain('a phone call is not seeing them');

    const videoA = await call({
      method: 'POST',
      url: `/api/v1/tele/consults/${state.videoFirst}/prescriptions`,
      token: doctor.token,
      payload: {
        drugKey: 'azithromycin',
        drugName: 'Azithromycin 500 mg',
        dose: '500 mg',
        frequency: 'OD',
        durationDays: 3,
      },
    });
    expect(videoA.statusCode, videoA.body).toBe(201);
    // Stamped at the moment of prescribing, so a later list change does not
    // rewrite what was lawful then.
    expect(videoA.json<{ listCode: string }>().listCode).toBe('list_a');

    const videoB = await call({
      method: 'POST',
      url: `/api/v1/tele/consults/${state.videoFirst}/prescriptions`,
      token: doctor.token,
      payload: {
        drugKey: 'metformin',
        drugName: 'Metformin 500 mg',
        dose: '500 mg',
        frequency: 'BD',
        durationDays: 30,
      },
    });
    expect(videoB.statusCode).toBe(409);
    expect(detail(videoB)).toContain('nothing to add on to');

    const followB = await call({
      method: 'POST',
      url: `/api/v1/tele/consults/${state.followUp}/prescriptions`,
      token: doctor.token,
      payload: {
        drugKey: 'metformin',
        drugName: 'Metformin 500 mg',
        dose: '500 mg',
        frequency: 'BD',
        durationDays: 30,
      },
    });
    expect(followB.statusCode, followB.body).toBe(201);
    expect(followB.json<{ listCode: string }>().listCode).toBe('list_b');
  });

  it('refuses a drug that is on no list at all', async () => {
    // The Guidelines work by listing what may be prescribed remotely, so
    // absence is a refusal rather than a gap.
    const res = await call({
      method: 'POST',
      url: `/api/v1/tele/consults/${state.followUp}/prescriptions`,
      token: doctor.token,
      payload: {
        drugKey: 'warfarin',
        drugName: 'Warfarin 5 mg',
        dose: '5 mg',
        frequency: 'OD',
        durationDays: 30,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toContain('not on any of the telemedicine drug lists');
  });

  it('refuses to prescribe to a patient nobody identified', async () => {
    const unverified = await call({
      method: 'POST',
      url: '/api/v1/tele/consults',
      token: doctor.token,
      payload: consultPayload({ identityVerification: {} }),
    });
    expect(unverified.statusCode, unverified.body).toBe(201);
    // And it says so before anything is prescribed.
    expect(unverified.json<{ reachableLists: string[] }>().reachableLists).toEqual([]);

    const res = await call({
      method: 'POST',
      url: `/api/v1/tele/consults/${unverified.json<{ id: string }>().id}/prescriptions`,
      token: doctor.token,
      payload: {
        drugKey: 'ors',
        drugName: 'ORS sachet',
        dose: '1 sachet',
        frequency: 'PRN',
        durationDays: 2,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toContain('prescription to somebody unknown');
  });

  it('bounds the course between one and ninety days', async () => {
    for (const durationDays of [0, 200]) {
      const res = await call({
        method: 'POST',
        url: `/api/v1/tele/consults/${state.followUp}/prescriptions`,
        token: doctor.token,
        payload: {
          drugKey: 'cetirizine',
          drugName: 'Cetirizine 10 mg',
          dose: '10 mg',
          frequency: 'HS',
          durationDays,
        },
      });
      expect(res.statusCode, String(durationDays)).toBe(400);
    }
  });

  it('shows the prohibited entries refused rather than hiding them', async () => {
    // A catalogue that quietly omits them teaches a doctor the drug is missing
    // from the formulary; one that shows them refused teaches the rule.
    const res = await call({
      method: 'GET',
      url: `/api/v1/tele/drug-rules?consultId=${state.audioFirst}`,
      token: doctor.token,
    });
    expect(res.statusCode, res.body).toBe(200);
    const rules =
      res.json<{ drugKey: string; listCode: string; reachable: boolean; reason: string | null }[]>();

    const morphine = rules.find((r) => r.drugKey === 'morphine');
    expect(morphine?.reachable).toBe(false);
    expect(morphine?.reason).toContain('NDPS Act');

    // On this consultation — audio, first contact — List A and List B are out
    // of reach and List O is not.
    expect(rules.find((r) => r.drugKey === 'azithromycin')?.reachable).toBe(false);
    expect(rules.find((r) => r.drugKey === 'metformin')?.reachable).toBe(false);
    expect(rules.find((r) => r.drugKey === 'paracetamol')?.reachable).toBe(true);
  });

  it('offers no route that reaches the prohibited list', async () => {
    for (const url of [
      `/api/v1/tele/consults/${state.followUp}/prescriptions/override`,
      '/api/v1/tele/drug-rules/override',
      `/api/v1/tele/consults/${state.followUp}/prescribe-anyway`,
    ]) {
      const res = await call({ method: 'POST', url, token: doctor.token, payload: {} });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('keeps prescribing out of a nurse’s hands', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/tele/consults/${state.followUp}/prescriptions`,
      token: nurse.token,
      payload: {
        drugKey: 'paracetamol',
        drugName: 'Paracetamol 500 mg',
        dose: '500 mg',
        frequency: 'TDS',
        durationDays: 3,
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('OP-021 · the referral clock', () => {
  it('derives the reply date from the urgency, and nothing else sets it', async () => {
    const raised: Record<string, { id: string; replyDueAt: string; createdAt: string }> = {};
    for (const urgency of ['routine', 'urgent', 'emergency']) {
      const res = await call({
        method: 'POST',
        url: '/api/v1/referrals',
        token: doctor.token,
        payload: {
          patientId: PATIENT,
          encounterId: ENCOUNTER,
          toDepartmentKey: newId(),
          urgency,
          reason: 'Painless haematuria, for a urology opinion.',
          // Offered and ignored: the clock is the database's.
          replyDueAt: '2099-01-01T00:00:00.000Z',
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      raised[urgency] = res.json();
    }
    state.referral = raised.routine?.id ?? '';
    state.urgent = raised.urgent?.id ?? '';

    const hours = (r: { replyDueAt: string; createdAt: string } | undefined): number =>
      r === undefined
        ? -1
        : Math.round((new Date(r.replyDueAt).getTime() - new Date(r.createdAt).getTime()) / 3_600_000);

    expect(hours(raised.emergency)).toBe(4);
    expect(hours(raised.urgent)).toBe(48);
    expect(hours(raised.routine)).toBe(14 * 24);
  });

  it('refuses a reply that says nothing', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/referrals/${state.referral}/reply`,
      token: external.token,
      payload: { replyText: 'ok' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('takes a reply, and closes on it', async () => {
    const ack = await call({
      method: 'POST',
      url: `/api/v1/referrals/${state.referral}/acknowledge`,
      token: external.token,
    });
    expect(ack.statusCode, ack.body).toBe(201);
    expect(ack.json<{ status: string }>().status).toBe('accepted');
    // Acknowledgement is not a reply, and the clock does not stop for it. This
    // is the failure the whole module exists for.
    expect(ack.json<{ repliedAt: string | null }>().repliedAt).toBeNull();

    const res = await call({
      method: 'POST',
      url: `/api/v1/referrals/${state.referral}/reply`,
      token: external.token,
      payload: {
        replyText:
          'Seen. Cystoscopy normal; CT urogram shows a 3 mm left renal calculus. Discharged with advice.',
        close: true,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<{ status: string }>().status).toBe('closed');
    expect(res.json<{ overdue: boolean }>().overdue).toBe(false);
  });

  it('offers no route that closes a referral nobody answered', async () => {
    for (const url of [
      `/api/v1/referrals/${state.urgent}/close`,
      `/api/v1/referrals/${state.urgent}/status`,
    ]) {
      const res = await call({ method: 'POST', url, token: doctor.token, payload: { status: 'closed' } });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('cancels, which is not the same as closing', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/referrals/${state.urgent}/cancel`,
      token: doctor.token,
      payload: { reason: 'The patient was admitted under this team the same evening.' },
      reason: 'The patient was admitted under this team the same evening.',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<{ status: string }>().status).toBe('cancelled');
    // Cancelled is not overdue: nobody is waiting for a reply any more.
    expect(res.json<{ overdue: boolean }>().overdue).toBe(false);
  });

  it('produces the overdue list, which is the reason the module exists', async () => {
    // An emergency referral is due in four hours, so one raised in the past is
    // overdue now.
    const pool = pg.pool('migrator');
    const overdueId = newId();
    await pool.query(
      `INSERT INTO clinical.referrals
         (id, hospital_id, branch_id, encounter_id, patient_id, from_user_id, to_department_key,
          urgency, reason, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'emergency',
               'Sudden painless loss of vision, right eye.', now() - interval '9 hours', now())`,
      [overdueId, tenants.hospitalA, tenants.branchA, ENCOUNTER, PATIENT, doctor.userId, newId()],
    );

    const res = await call({
      method: 'GET',
      url: '/api/v1/referrals?overdueOnly=true',
      token: doctor.token,
    });
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json<{ id: string; overdue: boolean; hoursRemaining: number }[]>();
    const found = rows.find((r) => r.id === overdueId);
    expect(found?.overdue).toBe(true);
    // Signed, deliberately: "five hours overdue" is the fact worth showing.
    expect(found?.hoursRemaining).toBeLessThan(0);
    // The answered and the cancelled are not on it.
    expect(rows.map((r) => r.id)).not.toContain(state.referral);
    expect(rows.map((r) => r.id)).not.toContain(state.urgent);
  });

  it('lets the external clinician answer but not raise', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/referrals',
      token: external.token,
      payload: {
        patientId: PATIENT,
        encounterId: ENCOUNTER,
        toDepartmentKey: newId(),
        urgency: 'routine',
        reason: 'A referral raised by somebody who does not work here.',
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('IP-020 · the variance is the data', () => {
  it('starts a pathway and counts adherence from the step records', async () => {
    const start = await call({
      method: 'POST',
      url: '/api/v1/pathways',
      token: doctor.token,
      payload: {
        patientId: PATIENT,
        pathwayKey: 'tkr_v3',
        pathwayName: 'Total knee replacement — enhanced recovery',
        steps: [
          { key: 'surgery', day: 0, label: 'Operation' },
          { key: 'mobilise', day: 1, label: 'First mobilisation' },
          { key: 'physio', day: 2, label: 'Physiotherapy' },
          { key: 'discharge', day: 3, label: 'Discharge' },
        ],
        startedAt: new Date().toISOString(),
        // Offered and ignored: adherence is counted, not typed.
        adherencePct: '100.00',
      },
    });
    expect(start.statusCode, start.body).toBe(201);
    state.pathway = start.json<{ id: string }>().id;
    expect(start.json<{ adherencePct: string | null }>().adherencePct).toBeNull();
    expect(start.json<{ stepsDefined: number }>().stepsDefined).toBe(4);
    expect(start.json<{ outstanding: string[] }>().outstanding).toEqual([
      'surgery',
      'mobilise',
      'physio',
      'discharge',
    ]);

    for (const step of [
      { stepKey: 'surgery', dayNo: 0 },
      { stepKey: 'mobilise', dayNo: 1 },
    ]) {
      const res = await call({
        method: 'POST',
        url: `/api/v1/pathways/${state.pathway}/steps`,
        token: nurse.token,
        payload: { ...step, outcome: 'done', doneAt: new Date().toISOString() },
      });
      expect(res.statusCode, res.body).toBe(201);
    }

    const after = await call({
      method: 'GET',
      url: `/api/v1/pathways?patientId=${PATIENT}`,
      token: nurse.token,
    });
    const instance = after
      .json<{ id: string; adherencePct: string; outstanding: string[] }[]>()
      .find((p) => p.id === state.pathway);
    expect(instance?.adherencePct).toBe('100.00');
    expect(instance?.outstanding).toEqual(['physio', 'discharge']);
  });

  it('refuses a variance with no category, and one with no reason', async () => {
    const noCategory = await call({
      method: 'POST',
      url: `/api/v1/pathways/${state.pathway}/steps`,
      token: nurse.token,
      payload: { stepKey: 'physio', dayNo: 2, outcome: 'varied', varianceReason: 'Nobody came.' },
    });
    expect(noCategory.statusCode).toBe(400);

    const noReason = await call({
      method: 'POST',
      url: `/api/v1/pathways/${state.pathway}/steps`,
      token: nurse.token,
      payload: { stepKey: 'physio', dayNo: 2, outcome: 'varied', varianceCategory: 'resource' },
    });
    expect(noReason.statusCode).toBe(400);

    const badCategory = await call({
      method: 'POST',
      url: `/api/v1/pathways/${state.pathway}/steps`,
      token: nurse.token,
      payload: {
        stepKey: 'physio',
        dayNo: 2,
        outcome: 'varied',
        varianceReason: 'Nobody came to the ward.',
        varianceCategory: 'other',
      },
    });
    expect(badCategory.statusCode).toBe(400);
  });

  it('refuses a step marked done with no time', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/pathways/${state.pathway}/steps`,
      token: nurse.token,
      payload: { stepKey: 'physio', dayNo: 2, outcome: 'done' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('takes a variance with both, and the roll-up follows', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/pathways/${state.pathway}/steps`,
      token: nurse.token,
      payload: {
        stepKey: 'physio',
        dayNo: 2,
        outcome: 'varied',
        varianceReason: 'No physiotherapist on the ward at the weekend.',
        varianceCategory: 'resource',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<{ adherencePct: string }>().adherencePct).toBe('66.67');
    expect(res.json<{ varianceCount: number }>().varianceCount).toBe(1);
  });

  it('leaves a not-applicable step out of the denominator', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/pathways/${state.pathway}/steps`,
      token: nurse.token,
      payload: { stepKey: 'discharge', dayNo: 3, outcome: 'not_applicable' },
    });
    expect(res.statusCode, res.body).toBe(201);
    // Two done of three that counted: the fourth is out of the sum, not
    // counted against it.
    expect(res.json<{ adherencePct: string }>().adherencePct).toBe('66.67');
    expect(res.json<{ outstanding: string[] }>().outstanding).toEqual([]);
  });

  it('separates the one category that is not the hospital’s problem', async () => {
    const res = await call({
      method: 'GET',
      url: '/api/v1/pathways/variance-report?pathwayKey=tkr_v3',
      token: doctor.token,
    });
    expect(res.statusCode, res.body).toBe(200);
    const tallies = res.json<{ varianceCategory: string; count: number; hospitalOwned: boolean }[]>();
    const resource = tallies.find((t) => t.varianceCategory === 'resource');
    expect(resource?.count).toBe(1);
    expect(resource?.hospitalOwned).toBe(true);
  });

  it('keeps starting a pathway out of a nurse’s hands, and recording in them', async () => {
    const start = await call({
      method: 'POST',
      url: '/api/v1/pathways',
      token: nurse.token,
      payload: {
        patientId: PATIENT,
        pathwayKey: 'tkr_v3',
        pathwayName: 'Total knee replacement',
        steps: [{ key: 'surgery', day: 0 }],
        startedAt: new Date().toISOString(),
      },
    });
    expect(start.statusCode).toBe(403);

    const steps = await call({
      method: 'GET',
      url: `/api/v1/pathways/${state.pathway}/steps`,
      token: nurse.token,
    });
    expect(steps.statusCode, steps.body).toBe(200);
    expect(steps.json<unknown[]>()).toHaveLength(4);
  });

  it('offers no route that waives a variance or sets adherence', async () => {
    for (const url of [
      `/api/v1/pathways/${state.pathway}/adherence`,
      `/api/v1/pathways/${state.pathway}/variance/waive`,
    ]) {
      const res = await call({ method: 'POST', url, token: doctor.token, payload: {} });
      expect(res.statusCode, url).toBe(404);
    }
  });
});
