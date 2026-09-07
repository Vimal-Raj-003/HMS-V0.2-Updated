import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import { NutritionService } from './nutrition.service.js';
import { SpeechService } from './speech.service.js';
import { TherapyController } from './therapy.controller.js';
import { TherapyService } from './therapy.service.js';
import { WoundService } from './wound.service.js';

/**
 * OP-015, OP-017, OP-011, OP-035 against a real PostgreSQL 17.
 *
 * The properties that cannot be read off the code:
 *
 *  1. **A session needs a live plan behind a signed assessment.** Treatment
 *     before assessment is the finding in every physiotherapy audit, and it is
 *     not carelessness — it is a busy department starting while the paperwork
 *     catches up.
 *  2. **The authorisation is counted, and extending it is somebody else's key.**
 *     The eleventh session of ten is refused, the therapist is told the number
 *     before they book, and the payer desk is told by an event.
 *  3. **A discharge closes every goal**, because a department's outcome data is
 *     those answers and an episode discharged with three open goals is three
 *     outcomes that silently never existed.
 *  4. **Wound area and its trajectory are the database's**, and a wound heals
 *     by closing rather than by somebody saying so. The override exists, writes
 *     the closing measurement it stands in for, and records why.
 *  5. **A diet plan's totals are summed from its meals**, and a plan that
 *     breaks its own restriction is refused by nutrient and by amount.
 *  6. **A swallow order names both IDDSI levels, and is not in force until the
 *     kitchen and the ward have both said they read it** — and the therapist
 *     who wrote it cannot say it for them.
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

/** Assesses, plans, treats, and writes swallow orders. Extends nothing. */
const therapist = actor('therapy-therapist');
/** The kitchen. Acknowledges, and cannot write an order. */
const kitchen = actor('therapy-kitchen');
/** The ward. The other half of the acknowledgement. */
const ward = actor('therapy-ward');
/** The payer desk: extends an authorisation, and treats nobody. */
const desk = actor('therapy-desk');
/** Holds the wound override the others do not. */
const overrider = actor('therapy-overrider');

const THERAPIST_KEYS = [
  'therapy.episode.read',
  'therapy.episode.create',
  'therapy.assessment.record',
  'therapy.assessment.sign',
  'therapy.goal.manage',
  'therapy.plan.write',
  'therapy.session.record',
  'therapy.episode.discharge',
  'wound.read',
  'wound.record',
  'wound.photo.capture',
  'wound.dressing.record',
  'wound.plan.write',
  'nutrition.assessment.read',
  'nutrition.assessment.record',
  'nutrition.plan.write',
  'slp.assessment.record',
  'slp.assessment.sign',
  'slp.swallow_order.write',
  'slp.swallow_order.read',
];
const ACK_KEYS = ['slp.swallow_order.read', 'slp.swallow_order.acknowledge'];
const DESK_KEYS = ['therapy.episode.read', 'therapy.authorisation.extend'];
const OVERRIDER_KEYS = [...THERAPIST_KEYS, 'wound.status.override'];

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
        p.requiresStepUp ?? false,
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
     VALUES ($1, $2, $3, $4, 'Integration test role', 'therapy-schedule', 'therapy', now())`,
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

async function seedFood(id: string, code: string, per100g: Record<string, number>): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO mdm.food_items (id, hospital_id, code, name, food_group, per_100g, veg_class, updated_at)
     VALUES ($1, $2, $3, $3, 'test', $4::jsonb, 'veg', now())`,
    [id, tenants.hospitalA, code, JSON.stringify(per100g)],
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

const appControllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as unknown[];
const alreadyWired = appControllers.includes(TherapyController);

@Module({
  imports: [AppModule],
  controllers: alreadyWired ? [] : [TherapyController],
  providers: alreadyWired ? [] : [TherapyService, WoundService, NutritionService, SpeechService],
})
class TherapyTestModule {}

const RICE = newId();
const BANANA = newId();

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'THER' });
  await syncPermissions();

  await seedActor(therapist, THERAPIST_KEYS);
  await seedActor(kitchen, ACK_KEYS);
  await seedActor(ward, ACK_KEYS);
  await seedActor(desk, DESK_KEYS);
  await seedActor(overrider, OVERRIDER_KEYS);

  // Real composition: 100 g of boiled rice and 100 g of banana.
  await seedFood(RICE, 'RICE-B', { kcal: 130, protein: 2.7, carb: 28, fat: 0.3, na: 1, k: 35, po4: 43 });
  await seedFood(BANANA, 'BANANA', { kcal: 89, protein: 1.1, carb: 23, fat: 0.3, na: 1, k: 358, po4: 22 });

  await pg.pool('migrator').query(
    `INSERT INTO patient.patients
       (id, hospital_id, branch_id, uhid, uhid_normalised, first_name, full_name, gender, dob,
        mobile, mobile_local, dedupe_fingerprint, status, updated_at)
     VALUES ($1, $2, $3, $4, $4, 'Kamala', 'Kamala Iyer', 'female', '1949-06-22'::date,
             '+919845000222', '9845000222', $5, 'active', now())`,
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

  app = await NestFactory.create<NestFastifyApplication>(TherapyTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  for (const who of [therapist, kitchen, ward, desk, overrider]) {
    who.token = await login(who.username);
  }
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

// ═════════════════════════════════════════════════════════════════════════════

describe('OP-015 · the therapy spine', () => {
  let episodeId = '';
  let assessmentId = '';
  let planId = '';
  let goalId = '';

  it('opens an episode with an authorisation, and reports what is left', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/therapy/episodes',
      token: therapist.token,
      payload: {
        patientId: PATIENT,
        discipline: 'physio',
        diagnosisIcd10: 'M17.1',
        sessionsAuthorised: 2,
        precautions: { weightBearing: 'partial, 20 kg' },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      id: string;
      sessionsAuthorised: number;
      sessionsRemaining: number;
      authorisationExhausted: boolean;
    }>();
    episodeId = body.id;
    expect(body.sessionsRemaining).toBe(2);
    expect(body.authorisationExhausted).toBe(false);
  });

  it('refuses a plan behind an unsigned assessment, and takes it once signed', async () => {
    const assessment = await call({
      method: 'POST',
      url: `/api/v1/therapy/episodes/${episodeId}/assessments`,
      token: therapist.token,
      payload: {
        patientId: PATIENT,
        kind: 'initial',
        findings: { rom: { kneeFlexion: 85 } },
        impression: 'Post-operative stiffness.',
      },
    });
    expect(assessment.statusCode).toBe(201);
    assessmentId = assessment.json<{ id: string }>().id;

    const early = await call({
      method: 'POST',
      url: `/api/v1/therapy/episodes/${episodeId}/plans`,
      token: therapist.token,
      payload: { assessmentId, items: [{ type: 'exercise', ref: 'quads-set' }], frequencyPerWeek: 2 },
    });
    expect(early.statusCode).toBe(409);
    expect(detail(early)).toContain('not signed');

    const signed = await call({
      method: 'POST',
      url: `/api/v1/therapy/assessments/${assessmentId}/sign`,
      token: therapist.token,
    });
    expect(signed.statusCode).toBe(201);

    const plan = await call({
      method: 'POST',
      url: `/api/v1/therapy/episodes/${episodeId}/plans`,
      token: therapist.token,
      payload: { assessmentId, items: [{ type: 'exercise', ref: 'quads-set' }], frequencyPerWeek: 2 },
    });
    expect(plan.statusCode).toBe(201);
    planId = plan.json<{ id: string; status: string }>().id;
    expect(plan.json<{ status: string }>().status).toBe('active');
  });

  it('refuses a goal with no metric, baseline or target', async () => {
    const vague = await call({
      method: 'POST',
      url: `/api/v1/therapy/episodes/${episodeId}/goals`,
      token: therapist.token,
      payload: { description: 'Improve mobility', metric: '', baseline: '', target: '' },
    });
    expect(vague.statusCode).toBe(400);

    const measurable = await call({
      method: 'POST',
      url: `/api/v1/therapy/episodes/${episodeId}/goals`,
      token: therapist.token,
      payload: {
        description: 'Walk 100 m unaided',
        metric: 'six-minute walk distance',
        baseline: '40 m',
        target: '100 m',
      },
    });
    expect(measurable.statusCode).toBe(201);
    goalId = measurable.json<{ id: string }>().id;
  });

  it('counts attendances against the authorisation and refuses the one past it', async () => {
    for (const seq of [1, 2]) {
      const booked = await call({
        method: 'POST',
        url: `/api/v1/therapy/episodes/${episodeId}/sessions`,
        token: therapist.token,
        payload: { planId, scheduledAt: new Date().toISOString() },
      });
      expect(booked.statusCode, `booking ${String(seq)}`).toBe(201);

      const attended = await call({
        method: 'POST',
        url: `/api/v1/therapy/sessions/${booked.json<{ id: string }>().id}/attend`,
        token: therapist.token,
        payload: { durationMin: 30, chargeIntentId: newId() },
      });
      expect(attended.statusCode, `attending ${String(seq)}`).toBe(201);
    }

    // The therapist can see it coming before the patient is in the room.
    const episode = await call({
      method: 'GET',
      url: `/api/v1/therapy/episodes/${episodeId}`,
      token: therapist.token,
    });
    const state = episode.json<{ episode: { sessionsRemaining: number; authorisationExhausted: boolean } }>();
    expect(state.episode.sessionsRemaining).toBe(0);
    expect(state.episode.authorisationExhausted).toBe(true);

    const third = await call({
      method: 'POST',
      url: `/api/v1/therapy/episodes/${episodeId}/sessions`,
      token: therapist.token,
      payload: { planId, scheduledAt: new Date().toISOString() },
    });
    // Booking ahead is allowed — a clinic books ahead, and a booked slot has
    // used nobody's package.
    expect(third.statusCode).toBe(201);
    const thirdId = third.json<{ id: string }>().id;

    const blocked = await call({
      method: 'POST',
      url: `/api/v1/therapy/sessions/${thirdId}/attend`,
      token: therapist.token,
      payload: { durationMin: 30 },
    });
    expect(blocked.statusCode).toBe(409);
    expect(detail(blocked)).toContain('authorised session');

    // The therapist cannot extend it. The desk that owns the authorisation can.
    const denied = await call({
      method: 'POST',
      url: `/api/v1/therapy/episodes/${episodeId}/authorisation`,
      token: therapist.token,
      reason: 'Slower recovery than expected.',
      payload: { sessionsAuthorised: 6, reason: 'Slower recovery than expected.' },
    });
    expect(denied.statusCode).toBe(403);

    const extended = await call({
      method: 'POST',
      url: `/api/v1/therapy/episodes/${episodeId}/authorisation`,
      token: desk.token,
      reason: 'Slower recovery than expected; six further sessions agreed with the payer.',
      payload: {
        sessionsAuthorised: 6,
        reason: 'Slower recovery than expected; six further sessions agreed with the payer.',
      },
    });
    expect(extended.statusCode).toBe(201);
    expect(extended.json<{ sessionsRemaining: number }>().sessionsRemaining).toBe(4);

    const now = await call({
      method: 'POST',
      url: `/api/v1/therapy/sessions/${thirdId}/attend`,
      token: therapist.token,
      payload: { durationMin: 30 },
    });
    expect(now.statusCode).toBe(201);
  });

  it('refuses the same charge intent twice', async () => {
    const shared = newId();
    const first = await call({
      method: 'POST',
      url: `/api/v1/therapy/episodes/${episodeId}/sessions`,
      token: therapist.token,
      payload: { planId, scheduledAt: new Date().toISOString(), chargeIntentId: shared },
    });
    expect(first.statusCode).toBe(201);

    const second = await call({
      method: 'POST',
      url: `/api/v1/therapy/episodes/${episodeId}/sessions`,
      token: therapist.token,
      payload: { planId, scheduledAt: new Date().toISOString(), chargeIntentId: shared },
    });
    expect(second.statusCode).toBe(409);
  });

  it('refuses a discharge while a goal is open, and says which', async () => {
    const list = await call({
      method: 'GET',
      url: `/api/v1/therapy/episodes?patientId=${PATIENT}&openOnly=true`,
      token: therapist.token,
    });
    const mine = list
      .json<{ id: string; dischargeBlockedBy: string | null }[]>()
      .find((e) => e.id === episodeId);
    // The screen carries the same sentence the refusal would.
    expect(mine?.dischargeBlockedBy).toContain('goal');

    const blocked = await call({
      method: 'POST',
      url: `/api/v1/therapy/episodes/${episodeId}/discharge`,
      token: therapist.token,
      payload: { outcome: 'goals_met' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(detail(blocked)).toContain('still open');

    const resolved = await call({
      method: 'POST',
      url: `/api/v1/therapy/goals/${goalId}/resolve`,
      token: therapist.token,
      payload: { status: 'met', outcomeNote: 'Achieved 110 m at session four.' },
    });
    expect(resolved.statusCode).toBe(201);

    const discharged = await call({
      method: 'POST',
      url: `/api/v1/therapy/episodes/${episodeId}/discharge`,
      token: therapist.token,
      payload: { outcome: 'goals_met' },
    });
    expect(discharged.statusCode).toBe(201);
    expect(discharged.json<{ closedAt: string | null }>().closedAt).not.toBeNull();
    expect(discharged.json<{ goalsOpen: number }>().goalsOpen).toBe(0);
  });

  it('refuses a session on a discharged episode', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/therapy/episodes/${episodeId}/sessions`,
      token: therapist.token,
      payload: { planId, scheduledAt: new Date().toISOString() },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('OP-017 · the wound clinic', () => {
  let woundId = '';

  it('derives area, reduction and trajectory from the ruler', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/wounds',
      token: therapist.token,
      payload: {
        patientId: PATIENT,
        locationText: 'Left heel',
        aetiology: 'pressure',
        onsetDate: '2026-07-09',
        hospitalAcquired: true,
      },
    });
    expect(created.statusCode).toBe(201);
    woundId = created.json<{ id: string; woundNo: number }>().id;
    expect(created.json<{ woundNo: number }>().woundNo).toBe(1);

    // Baseline, five weeks ago: 5 × 4 → π/4 × 20 = 15.71 cm².
    const baseline = await call({
      method: 'POST',
      url: `/api/v1/wounds/${woundId}/assessments`,
      token: therapist.token,
      payload: {
        assessedAt: new Date(Date.now() - 35 * 86_400_000).toISOString(),
        lengthCm: 5,
        widthCm: 4,
        tissuePct: { granulation: 40, slough: 60 },
      },
    });
    expect(baseline.statusCode).toBe(201);
    expect(baseline.json<{ wound: { latestAreaCm2: number } }>().wound.latestAreaCm2).toBe(15.71);

    // Today: 4 × 3.5 → 11.00 cm², a 30 % reduction in five weeks. Stalled.
    const today = await call({
      method: 'POST',
      url: `/api/v1/wounds/${woundId}/assessments`,
      token: therapist.token,
      payload: { lengthCm: 4, widthCm: 3.5, tissuePct: { granulation: 50, slough: 50 } },
    });
    expect(today.statusCode).toBe(201);
    const wound = today.json<{
      wound: {
        latestAreaCm2: number;
        latestReductionPct: number;
        latestTrajectory: string;
        needsReview: boolean;
      };
    }>().wound;
    expect(wound.latestAreaCm2).toBe(11);
    expect(wound.latestReductionPct).toBeCloseTo(29.98, 1);
    expect(wound.latestTrajectory).toBe('stalled');
    expect(wound.needsReview).toBe(true);
  });

  it('refuses a wound bed that describes two wounds', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/wounds/${woundId}/assessments`,
      token: therapist.token,
      payload: { lengthCm: 4, widthCm: 3, tissuePct: { granulation: 60, slough: 60 } },
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toContain('shares of one wound');
  });

  it('records whether a photograph can be the source of a measurement', async () => {
    const noScale = await call({
      method: 'POST',
      url: `/api/v1/wounds/${woundId}/photos`,
      token: therapist.token,
      payload: { s3Key: 'wounds/a.jpg', hasScaleMarker: false, stage: 'routine' },
    });
    expect(noScale.statusCode).toBe(201);
    expect(noScale.json<{ measurable: boolean }>().measurable).toBe(false);

    const withScale = await call({
      method: 'POST',
      url: `/api/v1/wounds/${woundId}/photos`,
      token: therapist.token,
      payload: { s3Key: 'wounds/b.jpg', hasScaleMarker: true, stage: 'routine' },
    });
    expect(withScale.json<{ measurable: boolean }>().measurable).toBe(true);
  });

  it('refuses to heal a wound the last measurement says is open, and overrides on the record', async () => {
    const blocked = await call({
      method: 'POST',
      url: `/api/v1/wounds/${woundId}/close`,
      token: therapist.token,
      payload: { status: 'healed' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(detail(blocked)).toContain('loses their district nurse');

    // The therapist does not hold the override.
    const denied = await call({
      method: 'POST',
      url: `/api/v1/wounds/${woundId}/close/override`,
      token: therapist.token,
      reason: 'Healed at home; community nurse confirmed closure by telephone.',
      payload: { reason: 'Healed at home; community nurse confirmed closure by telephone.' },
    });
    expect(denied.statusCode).toBe(403);

    const overridden = await call({
      method: 'POST',
      url: `/api/v1/wounds/${woundId}/close/override`,
      token: overrider.token,
      reason: 'Healed at home; community nurse confirmed closure by telephone.',
      payload: { reason: 'Healed at home; community nurse confirmed closure by telephone.' },
    });
    expect(overridden.statusCode).toBe(201);
    const healed = overridden.json<{ status: string; healingDays: number; latestAreaCm2: number }>();
    expect(healed.status).toBe('healed');
    // The override satisfied the rule rather than bypassing it: it wrote the
    // closing measurement it was standing in for.
    expect(healed.latestAreaCm2).toBe(0);
    expect(healed.healingDays).toBeGreaterThan(0);

    const { rows } = await pg.pool('migrator').query<{ reason_text: string }>(
      `SELECT reason_text FROM core.audit_log
          WHERE entity = 'wound' AND action = 'override' AND row_id = $1`,
      [woundId],
    );
    expect(rows[0]?.reason_text).toContain('community nurse');
  });

  it('closes a wound that genuinely measured zero, without an override', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/wounds',
      token: therapist.token,
      payload: { patientId: PATIENT, locationText: 'Right shin', aetiology: 'venous' },
    });
    const id = created.json<{ id: string }>().id;

    await call({
      method: 'POST',
      url: `/api/v1/wounds/${id}/assessments`,
      token: therapist.token,
      payload: { lengthCm: 3, widthCm: 2 },
    });
    await call({
      method: 'POST',
      url: `/api/v1/wounds/${id}/assessments`,
      token: therapist.token,
      payload: { assessedAt: new Date(Date.now() + 86_400_000).toISOString(), lengthCm: 0, widthCm: 0 },
    });

    const closed = await call({
      method: 'POST',
      url: `/api/v1/wounds/${id}/close`,
      token: therapist.token,
      payload: { status: 'healed' },
    });
    expect(closed.statusCode).toBe(201);
    expect(closed.json<{ status: string }>().status).toBe('healed');
  });
});

describe('OP-011 · the diet plan that keeps its own restriction', () => {
  let assessmentId = '';

  it('sums the plan from its meals, ignoring anything the client thinks', async () => {
    const assessment = await call({
      method: 'POST',
      url: '/api/v1/nutrition/assessments',
      token: therapist.token,
      payload: { patientId: PATIENT, bmi: 21.4, malnutritionClass: 'moderate', sga: 'B' },
    });
    expect(assessment.statusCode).toBe(201);
    assessmentId = assessment.json<{ id: string }>().id;

    const plan = await call({
      method: 'POST',
      url: '/api/v1/nutrition/plans',
      token: therapist.token,
      payload: {
        patientId: PATIENT,
        assessmentId,
        name: 'Renal plan',
        validFrom: '2026-09-12',
        kcalTarget: 1800,
        meals: [
          {
            meal: 'lunch',
            items: [
              { foodId: RICE, qty: 300 },
              { foodId: BANANA, qty: 200 },
            ],
          },
        ],
      },
    });
    expect(plan.statusCode).toBe(201);
    const totals = plan.json<{ totals: Record<string, string> }>().totals;
    // 300 g rice at 130 kcal/100 g + 200 g banana at 89 → 390 + 178 = 568.
    expect(Number(totals['kcal'])).toBe(568);
    // Potassium: 105 + 716 = 821 mg.
    expect(Number(totals['k'])).toBe(821);
    // And the distance from the stated target, which is how a dietician finds
    // out before the patient does.
    expect(plan.json<{ kcalVariancePct: number }>().kcalVariancePct).toBeCloseTo(-68.4, 0);
  });

  it('refuses a plan whose meals break its own restriction, by nutrient and by amount', async () => {
    const tooMuch = await call({
      method: 'POST',
      url: '/api/v1/nutrition/plans',
      token: therapist.token,
      payload: {
        patientId: PATIENT,
        assessmentId,
        name: 'Renal plan, restricted',
        validFrom: '2026-09-12',
        restrictions: { kMg: 500 },
        meals: [{ meal: 'lunch', items: [{ foodId: BANANA, qty: 200 }] }],
      },
    });
    expect(tooMuch.statusCode).toBe(409);
    expect(detail(tooMuch)).toContain('over');

    const withinLimit = await call({
      method: 'POST',
      url: '/api/v1/nutrition/plans',
      token: therapist.token,
      payload: {
        patientId: PATIENT,
        assessmentId,
        name: 'Renal plan, restricted',
        validFrom: '2026-09-12',
        restrictions: { kMg: 1000 },
        meals: [{ meal: 'lunch', items: [{ foodId: BANANA, qty: 200 }] }],
      },
    });
    expect(withinLimit.statusCode).toBe(201);

    const activated = await call({
      method: 'POST',
      url: `/api/v1/nutrition/plans/${withinLimit.json<{ id: string }>().id}/activate`,
      token: therapist.token,
    });
    expect(activated.statusCode).toBe(201);
    expect(activated.json<{ status: string }>().status).toBe('active');
  });

  it('supersedes the previous plan when a new one is activated', async () => {
    const drafted = await call({
      method: 'POST',
      url: '/api/v1/nutrition/plans',
      token: therapist.token,
      payload: {
        patientId: PATIENT,
        assessmentId,
        name: 'Revised plan',
        validFrom: '2026-09-20',
        meals: [{ meal: 'lunch', items: [{ foodId: RICE, qty: 150 }] }],
      },
    });
    const activated = await call({
      method: 'POST',
      url: `/api/v1/nutrition/plans/${drafted.json<{ id: string }>().id}/activate`,
      token: therapist.token,
    });
    expect(activated.statusCode).toBe(201);

    const list = await call({
      method: 'GET',
      url: `/api/v1/nutrition/plans?patientId=${PATIENT}`,
      token: therapist.token,
    });
    const active = list.json<{ status: string }[]>().filter((p) => p.status === 'active');
    // Exactly one, always: a kitchen reading two plans acts on whichever it saw.
    expect(active).toHaveLength(1);
  });
});

describe('OP-035 · the swallow order and the two people who have to read it', () => {
  let episodeId = '';
  let assessmentId = '';
  let orderId = '';

  it('refuses a half-specified IDDSI order', async () => {
    const episode = await call({
      method: 'POST',
      url: '/api/v1/therapy/episodes',
      token: therapist.token,
      payload: { patientId: PATIENT, discipline: 'speech', setting: 'ip' },
    });
    episodeId = episode.json<{ id: string }>().id;

    const assessment = await call({
      method: 'POST',
      url: '/api/v1/slp/assessments',
      token: therapist.token,
      payload: {
        patientId: PATIENT,
        episodeId,
        domains: ['swallow'],
        kind: 'swallow_clinical',
        swallow: { eat10: 22, fois: 3 },
        severity: 'moderate',
      },
    });
    expect(assessment.statusCode).toBe(201);
    assessmentId = assessment.json<{ id: string }>().id;

    const half = await call({
      method: 'POST',
      url: '/api/v1/slp/orders',
      token: therapist.token,
      payload: { patientId: PATIENT, episodeId, assessmentId, foodLevel: 4 },
    });
    expect(half.statusCode).toBe(400);

    const contradiction = await call({
      method: 'POST',
      url: '/api/v1/slp/orders',
      token: therapist.token,
      payload: { patientId: PATIENT, episodeId, assessmentId, npo: true, foodLevel: 4, fluidLevel: 2 },
    });
    expect(contradiction.statusCode).toBe(400);
  });

  it('starts an order pending, and spells both levels out in words', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/slp/orders',
      token: therapist.token,
      payload: {
        patientId: PATIENT,
        episodeId,
        assessmentId,
        foodLevel: 4,
        fluidLevel: 2,
        strategies: { posture: 'upright 90 degrees', supervision: 'full' },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      id: string;
      status: string;
      inForce: boolean;
      awaitingKitchen: boolean;
      awaitingWard: boolean;
      summary: string;
    }>();
    orderId = body.id;
    expect(body.status).toBe('pending');
    expect(body.inForce).toBe(false);
    expect(body.awaitingKitchen).toBe(true);
    expect(body.awaitingWard).toBe(true);
    // "Level 4" means two different things. The banner says which.
    expect(body.summary).toBe('pureed food, mildly thick fluids');
  });

  it('never lets the therapist who wrote the order acknowledge it', async () => {
    const denied = await call({
      method: 'POST',
      url: `/api/v1/slp/orders/${orderId}/acknowledge`,
      token: therapist.token,
      payload: { party: 'kitchen' },
    });
    // The therapist does not hold the key at all.
    expect(denied.statusCode).toBe(403);
  });

  it('comes into force only when both the kitchen and the ward have read it', async () => {
    const first = await call({
      method: 'POST',
      url: `/api/v1/slp/orders/${orderId}/acknowledge`,
      token: kitchen.token,
      payload: { party: 'kitchen' },
    });
    expect(first.statusCode).toBe(201);
    const afterKitchen = first.json<{ status: string; inForce: boolean; awaitingWard: boolean }>();
    expect(afterKitchen.status).toBe('pending');
    expect(afterKitchen.inForce).toBe(false);
    expect(afterKitchen.awaitingWard).toBe(true);

    // The same person cannot stand in for the other department.
    const sameHand = await call({
      method: 'POST',
      url: `/api/v1/slp/orders/${orderId}/acknowledge`,
      token: kitchen.token,
      payload: { party: 'ward' },
    });
    expect(sameHand.statusCode).toBe(400);
    expect(detail(sameHand)).toContain('both the kitchen and the ward');

    const second = await call({
      method: 'POST',
      url: `/api/v1/slp/orders/${orderId}/acknowledge`,
      token: ward.token,
      payload: { party: 'ward' },
    });
    expect(second.statusCode).toBe(201);
    const inForce = second.json<{ status: string; inForce: boolean }>();
    expect(inForce.status).toBe('active');
    expect(inForce.inForce).toBe(true);
  });

  it('keeps exactly one live order per patient, and supersedes with a reason', async () => {
    const second = await call({
      method: 'POST',
      url: '/api/v1/slp/orders',
      token: therapist.token,
      payload: { patientId: PATIENT, episodeId, assessmentId, foodLevel: 5, fluidLevel: 0 },
    });
    // Blocked by the one-live-order index: two answers to "what can this person
    // eat" is a ward acting on whichever it happened to read.
    expect(second.statusCode).toBe(409);

    const superseding = await call({
      method: 'POST',
      url: '/api/v1/slp/orders',
      token: therapist.token,
      payload: {
        patientId: PATIENT,
        episodeId,
        assessmentId,
        foodLevel: 5,
        fluidLevel: 0,
        supersedesId: orderId,
        changeReason: 'Repeat bedside assessment: safe to upgrade to soft food and thin fluids.',
      },
    });
    expect(superseding.statusCode).toBe(201);
    expect(superseding.json<{ summary: string }>().summary).toBe('minced and moist food, thin fluids');
    // And the new one starts pending too: the tray does not change until the
    // kitchen has read this one either.
    expect(superseding.json<{ inForce: boolean }>().inForce).toBe(false);

    const awaiting = await call({
      method: 'GET',
      url: `/api/v1/slp/orders?patientId=${PATIENT}&awaitingAckOnly=true`,
      token: ward.token,
    });
    expect(awaiting.json<{ id: string }[]>()).toHaveLength(1);
  });
});
