import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import { PainController } from './pain.controller.js';
import { PainService } from './pain.service.js';

/**
 * OP-016 against a real PostgreSQL 17.
 *
 * The one console in Phase 8 whose rules are governance rather than clinical
 * arithmetic, and the properties are correspondingly about people:
 *
 *  1. **The morphine equivalent is the database's.** No request can express it,
 *     the factor used is dated, and a unit mismatch is refused rather than
 *     multiplied.
 *  2. **The thresholds bite rather than warn.** At 60 MME naloxone is supplied
 *     or the refusal names why not; at 120 a second prescriber signs and says
 *     why; and the reviewer is never the prescriber — in the database, in the
 *     service, and in the grants.
 *  3. **Chronic opioids need a live agreement**, acute ones do not, and
 *     revoking one stops every further prescription on the episode.
 *  4. **Steroid accumulates across a year**, the ceiling holds, and the
 *     application cannot touch the running total.
 *  5. **The thresholds are readable**, so a screen and a trigger cannot hold
 *     two different numbers.
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

/** Writes the prescriptions. Cannot countersign, by grant. */
const prescriber = actor('pain-prescriber');
/** Countersigns. Cannot prescribe, by grant. */
const reviewer = actor('pain-reviewer');
/** Reads and assesses. Neither of the above. */
const resident = actor('pain-resident');

const CLINIC_KEYS = [
  'pain.episode.read',
  'pain.episode.create',
  'pain.assessment.record',
  'pain.plan.write',
  'pain.opioid.read',
  'pain.agreement.sign',
  'pain.agreement.revoke',
  'pain.intervention.perform',
  'pain.report.read',
];
const PRESCRIBER_KEYS = [...CLINIC_KEYS, 'pain.opioid.prescribe'];
const REVIEWER_KEYS = [...CLINIC_KEYS, 'pain.opioid.second_review'];
const RESIDENT_KEYS = ['pain.episode.read', 'pain.opioid.read', 'pain.assessment.record'];

const PATIENT = newId();

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
        // Step-up is switched off in the fixture: `pain.opioid.prescribe`
        // demands fresh strong auth in production, which is right and would
        // make this suite a test of the auth stack rather than of the rules.
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

const today = (): string => new Date().toISOString().slice(0, 10);

const appControllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as unknown[];
const alreadyWired = appControllers.includes(PainController);

@Module({
  imports: [AppModule],
  controllers: alreadyWired ? [] : [PainController],
  providers: alreadyWired ? [] : [PainService],
})
class PainTestModule {}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'PAIN' });
  await syncPermissions();

  await seedActor(prescriber, PRESCRIBER_KEYS);
  await seedActor(reviewer, REVIEWER_KEYS);
  await seedActor(resident, RESIDENT_KEYS);

  await pg.pool('migrator').query(
    `INSERT INTO patient.patients
       (id, hospital_id, branch_id, uhid, uhid_normalised, first_name, full_name, gender, dob,
        mobile, mobile_local, dedupe_fingerprint, status, updated_at)
     VALUES ($1, $2, $3, $4, $4, 'Rafiq', 'Rafiq Ahmed', 'male', '1971-02-08'::date,
             '+919845000333', '9845000333', $5, 'active', now())`,
    [
      PATIENT,
      tenants.hospitalA,
      tenants.branchA,
      `UH-${PATIENT.replace(/-/g, '').slice(-10)}`,
      PATIENT.replace(/-/g, ''),
    ],
  );

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(PainTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  for (const who of [prescriber, reviewer, resident]) {
    who.token = await login(who.username);
  }
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

// ═════════════════════════════════════════════════════════════════════════════

describe('OP-016 · the morphine equivalent and its thresholds', () => {
  let episodeId = '';

  it('reports the thresholds the database will actually enforce', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/pain/thresholds', token: prescriber.token });
    expect(res.statusCode).toBe(200);
    const t = res.json<{ naloxoneMme: number; secondReviewMme: number; annualSteroidCeilingMg: number }>();
    // Not constants in the client: these come from the functions the triggers
    // call, so a chip and a refusal cannot hold two different numbers.
    expect(t.naloxoneMme).toBe(50);
    expect(t.secondReviewMme).toBe(90);
    expect(t.annualSteroidCeilingMg).toBe(400);
  });

  it('refuses a chronic opioid until an agreement is in force', async () => {
    const episode = await call({
      method: 'POST',
      url: '/api/v1/pain/episodes',
      token: prescriber.token,
      payload: {
        patientId: PATIENT,
        type: 'chronic',
        mechanism: 'nociceptive',
        leadPhysicianId: prescriber.userId,
        opioidTherapy: true,
      },
    });
    expect(episode.statusCode).toBe(201);
    episodeId = episode.json<{ id: string; agreementMissing: boolean }>().id;
    expect(episode.json<{ agreementMissing: boolean }>().agreementMissing).toBe(true);

    const blocked = await call({
      method: 'POST',
      url: `/api/v1/pain/episodes/${episodeId}/opioids`,
      token: prescriber.token,
      payload: {
        patientId: PATIENT,
        drugKey: 'morphine',
        drugName: 'Morphine sulphate MR',
        route: 'oral',
        strength: '10 mg',
        dailyDose: 20,
        doseUnit: 'mg',
        daysSupply: 30,
        quantity: 60,
        startDate: today(),
      },
    });
    expect(blocked.statusCode).toBe(409);
    expect(detail(blocked)).toContain('treatment agreement');

    const agreement = await call({
      method: 'POST',
      url: `/api/v1/pain/episodes/${episodeId}/agreement`,
      token: prescriber.token,
      payload: {
        patientId: PATIENT,
        termsVersion: 'v3',
        validTo: new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10),
      },
    });
    expect(agreement.statusCode).toBe(201);
    expect(agreement.json<{ expiringSoon: boolean }>().expiringSoon).toBe(false);
  });

  it('derives the morphine equivalent, and records which factor it used', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/pain/episodes/${episodeId}/opioids`,
      token: prescriber.token,
      payload: {
        patientId: PATIENT,
        drugKey: 'morphine',
        drugName: 'Morphine sulphate MR',
        route: 'oral',
        strength: '10 mg',
        dailyDose: 20,
        doseUnit: 'mg',
        daysSupply: 30,
        quantity: 60,
        startDate: today(),
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      mme: number;
      conversionFactorId: string | null;
      endDate: string;
      agreementId: string | null;
      aboveNaloxoneThreshold: boolean;
      aboveReviewThreshold: boolean;
    }>();
    // 20 mg oral morphine at factor 1.0.
    expect(body.mme).toBe(20);
    expect(body.conversionFactorId).not.toBeNull();
    expect(body.endDate).not.toBe('');
    // And it recorded which agreement it was written under.
    expect(body.agreementId).not.toBeNull();
    expect(body.aboveNaloxoneThreshold).toBe(false);
    expect(body.aboveReviewThreshold).toBe(false);
  });

  it('refuses a patch dosed in milligrams rather than multiplying it', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/pain/episodes/${episodeId}/opioids`,
      token: prescriber.token,
      payload: {
        patientId: PATIENT,
        drugKey: 'fentanyl_patch',
        drugName: 'Fentanyl patch',
        route: 'transdermal',
        strength: '25 mcg/h',
        dailyDose: 25,
        doseUnit: 'mg',
        daysSupply: 30,
        quantity: 10,
        startDate: today(),
      },
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toContain('orders of magnitude');
  });

  it('demands naloxone or a reason above the co-prescription threshold', async () => {
    const bare = await call({
      method: 'POST',
      url: `/api/v1/pain/episodes/${episodeId}/opioids`,
      token: prescriber.token,
      payload: {
        patientId: PATIENT,
        drugKey: 'tramadol',
        drugName: 'Tramadol',
        route: 'oral',
        strength: '50 mg',
        dailyDose: 300,
        doseUnit: 'mg',
        daysSupply: 30,
        quantity: 180,
        startDate: today(),
      },
    });
    // 300 mg tramadol at 0.2 → 60 MME.
    expect(bare.statusCode).toBe(409);
    expect(detail(bare)).toContain('naloxone');

    const supplied = await call({
      method: 'POST',
      url: `/api/v1/pain/episodes/${episodeId}/opioids`,
      token: prescriber.token,
      payload: {
        patientId: PATIENT,
        drugKey: 'tramadol',
        drugName: 'Tramadol',
        route: 'oral',
        strength: '50 mg',
        dailyDose: 300,
        doseUnit: 'mg',
        daysSupply: 30,
        quantity: 180,
        startDate: today(),
        naloxonePrescribed: true,
      },
    });
    expect(supplied.statusCode).toBe(201);
    expect(supplied.json<{ mme: number }>().mme).toBe(60);
    expect(supplied.json<{ aboveNaloxoneThreshold: boolean }>().aboveNaloxoneThreshold).toBe(true);
  });

  it('demands a second prescriber above the review threshold, and never the same one', async () => {
    const unreviewed = await call({
      method: 'POST',
      url: `/api/v1/pain/episodes/${episodeId}/opioids`,
      token: prescriber.token,
      payload: {
        patientId: PATIENT,
        drugKey: 'oxycodone',
        drugName: 'Oxycodone MR',
        route: 'oral',
        strength: '40 mg',
        dailyDose: 80,
        doseUnit: 'mg',
        daysSupply: 30,
        quantity: 60,
        startDate: today(),
        naloxonePrescribed: true,
      },
    });
    // 80 mg oxycodone at 1.5 → 120 MME, over the line.
    expect(unreviewed.statusCode).toBe(409);
    expect(detail(unreviewed)).toContain('second prescriber');

    // A prescription under the line goes through, and is then countersigned by
    // somebody else — which is how the workflow actually runs: write, refuse,
    // ask a colleague.
    const under = await call({
      method: 'POST',
      url: `/api/v1/pain/episodes/${episodeId}/opioids`,
      token: prescriber.token,
      payload: {
        patientId: PATIENT,
        drugKey: 'morphine',
        drugName: 'Morphine sulphate MR',
        route: 'oral',
        strength: '30 mg',
        dailyDose: 60,
        doseUnit: 'mg',
        daysSupply: 28,
        quantity: 56,
        startDate: today(),
        naloxonePrescribed: true,
      },
    });
    expect(under.statusCode).toBe(201);
    const logId = under.json<{ id: string }>().id;

    // The prescriber does not hold the review key at all.
    const selfReview = await call({
      method: 'POST',
      url: `/api/v1/pain/opioids/${logId}/review`,
      token: prescriber.token,
      reason: 'Titrated over six weeks with documented function gain.',
      payload: { justification: 'Titrated over six weeks with documented function gain.' },
    });
    expect(selfReview.statusCode).toBe(403);

    const reviewed = await call({
      method: 'POST',
      url: `/api/v1/pain/opioids/${logId}/review`,
      token: reviewer.token,
      reason: 'Titrated over six weeks with documented function gain.',
      payload: { justification: 'Titrated over six weeks with documented function gain.' },
    });
    expect(reviewed.statusCode).toBe(201);
    expect(reviewed.json<{ secondReviewerId: string }>().secondReviewerId).toBe(reviewer.userId);

    const { rows } = await pg.pool('migrator').query<{ reason_text: string }>(
      `SELECT reason_text FROM core.audit_log
          WHERE entity = 'opioid_prescription' AND action = 'approve' AND row_id = $1`,
      [logId],
    );
    expect(rows[0]?.reason_text).toContain('function gain');
  });

  it('sums the current daily equivalent across every live prescription', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/pain/episodes/${episodeId}`,
      token: resident.token,
    });
    const episode = res.json<{ episode: { currentDailyMme: number; aboveReviewThreshold: boolean } }>()
      .episode;
    // 20 (morphine) + 60 (tramadol) + 60 (morphine) = 140 across three live
    // prescriptions. No single one of them crosses the review line; together
    // they are well past it, which is the number no consultation can see.
    expect(episode.currentDailyMme).toBe(140);
    expect(episode.aboveReviewThreshold).toBe(true);
  });

  it('lets an acute episode prescribe without a chronic agreement', async () => {
    const acute = await call({
      method: 'POST',
      url: '/api/v1/pain/episodes',
      token: prescriber.token,
      payload: {
        patientId: PATIENT,
        type: 'acute',
        leadPhysicianId: prescriber.userId,
        opioidTherapy: true,
      },
    });
    expect(acute.json<{ agreementMissing: boolean }>().agreementMissing).toBe(false);

    const res = await call({
      method: 'POST',
      url: `/api/v1/pain/episodes/${acute.json<{ id: string }>().id}/opioids`,
      token: prescriber.token,
      payload: {
        patientId: PATIENT,
        drugKey: 'morphine',
        drugName: 'Morphine',
        route: 'oral',
        strength: '10 mg',
        dailyDose: 20,
        doseUnit: 'mg',
        daysSupply: 3,
        quantity: 6,
        startDate: today(),
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it('stops every further opioid once the agreement is revoked', async () => {
    const detailRes = await call({
      method: 'GET',
      url: `/api/v1/pain/episodes/${episodeId}`,
      token: prescriber.token,
    });
    const live = detailRes
      .json<{ agreements: { id: string; status: string }[] }>()
      .agreements.find((a) => a.status === 'active');
    expect(live).toBeDefined();

    const noReason = await call({
      method: 'POST',
      url: `/api/v1/pain/agreements/${live?.id ?? ''}/revoke`,
      token: prescriber.token,
      payload: { reason: 'Terms broken: concurrent prescriptions from two other practices.' },
    });
    // The key demands a reason header as well as the body text.
    expect(noReason.statusCode).toBe(403);

    const revoked = await call({
      method: 'POST',
      url: `/api/v1/pain/agreements/${live?.id ?? ''}/revoke`,
      token: prescriber.token,
      reason: 'Terms broken: concurrent prescriptions from two other practices.',
      payload: { reason: 'Terms broken: concurrent prescriptions from two other practices.' },
    });
    expect(revoked.statusCode).toBe(201);
    expect(revoked.json<{ status: string }>().status).toBe('revoked');

    const afterwards = await call({
      method: 'POST',
      url: `/api/v1/pain/episodes/${episodeId}/opioids`,
      token: prescriber.token,
      payload: {
        patientId: PATIENT,
        drugKey: 'morphine',
        drugName: 'Morphine',
        route: 'oral',
        strength: '10 mg',
        dailyDose: 20,
        doseUnit: 'mg',
        daysSupply: 30,
        quantity: 60,
        startDate: today(),
      },
    });
    expect(afterwards.statusCode).toBe(409);
    expect(detail(afterwards)).toContain('treatment agreement');
  });
});

describe('OP-016 · steroid across a year', () => {
  let episodeId = '';

  it('sums every injection and refuses the one that would cross the ceiling', async () => {
    const episode = await call({
      method: 'POST',
      url: '/api/v1/pain/episodes',
      token: prescriber.token,
      payload: { patientId: PATIENT, type: 'chronic', leadPhysicianId: prescriber.userId },
    });
    episodeId = episode.json<{ id: string }>().id;

    const first = await call({
      method: 'POST',
      url: `/api/v1/pain/episodes/${episodeId}/interventions`,
      token: prescriber.token,
      payload: {
        patientId: PATIENT,
        interventionCode: 'ESI-L45',
        name: 'Lumbar epidural steroid injection L4-L5',
        guidance: 'fluoroscopy',
        levels: ['L4-L5'],
        steroidMgEquiv: 120,
        nrsPre: 8,
        nrsPost30min: 3,
        outcome: 'good',
      },
    });
    expect(first.statusCode).toBe(201);
    // Points off the scale — the number a pain clinic is judged on.
    expect(first.json<{ reliefPoints: number }>().reliefPoints).toBe(5);

    const second = await call({
      method: 'POST',
      url: `/api/v1/pain/episodes/${episodeId}/interventions`,
      token: prescriber.token,
      payload: {
        patientId: PATIENT,
        interventionCode: 'MBB-L45',
        name: 'Medial branch block',
        guidance: 'ultrasound',
        steroidMgEquiv: 200,
      },
    });
    expect(second.statusCode).toBe(201);

    // The clinic can see it coming, because it books weeks ahead.
    const state = await call({
      method: 'GET',
      url: `/api/v1/pain/episodes/${episodeId}`,
      token: prescriber.token,
    });
    const ep = state.json<{ episode: { steroidMgThisYear: number; steroidMgRemaining: number } }>().episode;
    expect(ep.steroidMgThisYear).toBe(320);
    expect(ep.steroidMgRemaining).toBe(80);

    const overCeiling = await call({
      method: 'POST',
      url: `/api/v1/pain/episodes/${episodeId}/interventions`,
      token: prescriber.token,
      payload: {
        patientId: PATIENT,
        interventionCode: 'ESI-L5S1',
        name: 'Lumbar epidural steroid injection L5-S1',
        guidance: 'fluoroscopy',
        steroidMgEquiv: 120,
      },
    });
    expect(overCeiling.statusCode).toBe(409);
    expect(detail(overCeiling)).toContain('annual ceiling');

    const fits = await call({
      method: 'POST',
      url: `/api/v1/pain/episodes/${episodeId}/interventions`,
      token: prescriber.token,
      payload: {
        patientId: PATIENT,
        interventionCode: 'ESI-L5S1',
        name: 'Lumbar epidural steroid injection L5-S1',
        guidance: 'fluoroscopy',
        steroidMgEquiv: 60,
      },
    });
    expect(fits.statusCode).toBe(201);
  });

  it('offers no route at all for exceeding the ceiling', async () => {
    // Every other console in the phase has a documented way past its rule. This
    // one does not, and the 404 is the design rather than an omission.
    const res = await call({
      method: 'POST',
      url: `/api/v1/pain/episodes/${episodeId}/interventions/override`,
      token: prescriber.token,
      reason: 'Clinically necessary.',
      payload: { reason: 'Clinically necessary.' },
    });
    expect(res.statusCode).toBe(404);

    // And the running total is not something the application can adjust.
    const { rows } = await pg.pool('migrator').query<{ ins: boolean; upd: boolean; del: boolean }>(
      `SELECT has_table_privilege('hms_app','specialty.pain_steroid_exposure','INSERT') AS ins,
                has_table_privilege('hms_app','specialty.pain_steroid_exposure','UPDATE') AS upd,
                has_table_privilege('hms_app','specialty.pain_steroid_exposure','DELETE') AS del`,
    );
    expect(rows[0]).toEqual({ ins: false, upd: false, del: false });
  });

  it('refuses an outcome that rests on no measurement', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/pain/episodes/${episodeId}/interventions`,
      token: prescriber.token,
      payload: {
        patientId: PATIENT,
        interventionCode: 'GON',
        name: 'Greater occipital nerve block',
        guidance: 'landmark',
        nrsPre: 7,
        outcome: 'good',
      },
    });
    // A CHECK on what was submitted is a 400, not a conflict with other state.
    expect(res.statusCode).toBe(400);
    expect(detail(res)).toContain('thirty minutes after');
  });

  it('refuses a pain score pair recorded the wrong way round', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/pain/episodes/${episodeId}/assessments`,
      token: resident.token,
      payload: { kind: 'followup', nrsWorst: 3, nrsLeast: 8 },
    });
    expect(res.statusCode).toBe(400);
  });
});
