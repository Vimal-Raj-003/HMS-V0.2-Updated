import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import { LabourController } from './labour.controller.js';
import { LabourService } from './labour.service.js';

/**
 * IP-011 against a real PostgreSQL 17.
 *
 * The rules a labour room turns on:
 *
 *  1. **Crossing the action line stops the chart** until a decision is
 *     recorded — and the fetal heart and the blood pressure keep going onto it,
 *     because it is the chart that stops, not the room.
 *  2. **A uterotonic within one minute of birth**, measured rather than
 *     assumed, and **blood loss over the threshold activates the haemorrhage
 *     protocol by itself**.
 *  3. **A live birth is scored at one and five minutes**, and at ten when the
 *     five-minute score is under seven.
 *  4. **A delivery creates the baby's own patient record**, with a hospital
 *     number from the same series as everybody else's.
 *  5. **Two bands, one code**: the database decides whether they match, and a
 *     baby does not move on a pair that does not.
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

/** Runs the labour and the chart. Cannot decide at the line. */
const midwife = actor('lr-midwife');
/** Decides at the line: augment, assist, section, refer, or continue with a reason. */
const obstetrician = actor('lr-obs');
/** Files Form 1, because a statutory return to a Registrar is not a clinical note. */
const mrd = actor('lr-mrd');

const FLOOR_KEYS = [
  'obs.labour.read',
  'obs.labour.admit',
  'obs.partograph.write',
  'obs.delivery.write',
  'obs.pph.manage',
  'obs.newborn.write',
  'obs.identity.verify',
];
const OBS_KEYS = [...FLOOR_KEYS, 'obs.partograph.decide', 'obs.report.read'];
const MRD_KEYS = ['obs.labour.read', 'obs.birth.report'];

const MOTHER_A = newId();
const MOTHER_B = newId();

/** What the suites hand each other. */
const state = { episodeA: '', episodeB: '', actionAlert: '', delivery: '', newborn: '', pairCode: '' };

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

/**
 * The hospital number series. A newborn's number comes from the same one
 * everybody else's does, which is the point — a baby with a different kind of
 * number is a baby whose record has to be special-cased for the rest of their
 * life.
 */
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

async function seedPatient(id: string, name: string): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO patient.patients
       (id, hospital_id, branch_id, uhid, uhid_normalised, first_name, full_name, gender, dob,
        mobile, mobile_local, dedupe_fingerprint, status, updated_at)
     VALUES ($1, $2, $3, $4, $4, $5, $5, 'female', '1996-03-08',
             '+91984500' || lpad($6, 4, '0'), '984500' || lpad($6, 4, '0'), $4, 'active', now())`,
    [
      id,
      tenants.hospitalA,
      tenants.branchA,
      `UH-${id.replace(/-/g, '').slice(-10)}`,
      name,
      String(Math.abs(name.length * 53) % 10_000),
    ],
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

/** A moment that many minutes ago, as an ISO timestamp. */
const minutesAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();

const appControllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as unknown[];
const alreadyWired = appControllers.includes(LabourController);

@Module({
  imports: [AppModule],
  controllers: alreadyWired ? [] : [LabourController],
  providers: alreadyWired ? [] : [LabourService],
})
class LabourTestModule {}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'LR' });
  await syncPermissions();

  await defineSeries('UHID', '{BR}{SEQ:8}');

  await seedActor(midwife, FLOOR_KEYS);
  await seedActor(obstetrician, OBS_KEYS);
  await seedActor(mrd, MRD_KEYS);

  await seedPatient(MOTHER_A, 'Lakshmi Devi');
  await seedPatient(MOTHER_B, 'Anjali Rao');

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(LabourTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();

  for (const who of [midwife, obstetrician, mrd]) {
    who.token = await login(who.username);
  }
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe('IP-011 · the two lines', () => {
  it('opens a labour and plots the chart', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/obs/labour-episodes',
      token: midwife.token,
      payload: {
        admissionId: newId(),
        patientId: MOTHER_A,
        parity: 0,
        epidural: false,
        gpal: { g: 1, p: 0, a: 0, l: 0 },
        membraneStatus: 'srom',
        membraneRuptureAt: minutesAgo(600),
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    state.episodeA = res.json<{ id: string }>().id;

    // The active phase is the anchor both lines are drawn from.
    const anchored = await call({
      method: 'POST',
      url: `/api/v1/obs/labour-episodes/${state.episodeA}`,
      token: midwife.token,
      payload: { activePhaseFrom: minutesAgo(480) },
    });
    expect(anchored.statusCode, anchored.body).toBe(201);
    // Eight hours in, the alert line expects twelve centimetres — capped at ten.
    expect(anchored.json<{ expectedCm: number }>().expectedCm).toBe(10);
  });

  it('warns at the alert line and keeps plotting', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/obs/labour-episodes/${state.episodeA}/partograph`,
      token: midwife.token,
      payload: {
        entries: [
          { recordedAt: minutesAgo(480), param: 'dilatation', value: { cm: 4 } },
          { recordedAt: minutesAgo(360), param: 'dilatation', value: { cm: 6 } },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const detailBody = res.json<{
      alerts: { kind: string; blocking: boolean }[];
      episode: { chartBlocked: boolean };
    }>();
    // Six centimetres two hours in is on the line; six at four hours is two
    // behind, which warns and does not block.
    expect(detailBody.alerts.some((a) => a.kind === 'alert_line')).toBe(true);
    expect(detailBody.episode.chartBlocked).toBe(false);
  });

  it('stops the chart at the action line, and lets the observations through', async () => {
    // Six centimetres eight hours into the active phase is four behind.
    const crossed = await call({
      method: 'POST',
      url: `/api/v1/obs/labour-episodes/${state.episodeA}/partograph`,
      token: midwife.token,
      payload: { entries: [{ recordedAt: minutesAgo(5), param: 'dilatation', value: { cm: 6 } }] },
    });
    expect(crossed.statusCode, crossed.body).toBe(201);
    const body = crossed.json<{
      alerts: { id: string; kind: string; blocking: boolean }[];
      episode: { chartBlocked: boolean; hoursBehind: number };
    }>();
    const action = body.alerts.find((a) => a.kind === 'action_line');
    expect(action?.blocking).toBe(true);
    expect(body.episode.chartBlocked).toBe(true);
    state.actionAlert = action?.id ?? '';

    // The chart will not advance.
    const refused = await call({
      method: 'POST',
      url: `/api/v1/obs/labour-episodes/${state.episodeA}/partograph`,
      token: midwife.token,
      payload: { entries: [{ param: 'dilatation', value: { cm: 7 } }] },
    });
    expect(refused.statusCode).toBe(409);
    expect(detail(refused)).toContain('crossed the action line');

    // But the fetal heart and the blood pressure still go onto it, because it
    // is the chart that stops, not the room.
    const observations = await call({
      method: 'POST',
      url: `/api/v1/obs/labour-episodes/${state.episodeA}/partograph`,
      token: midwife.token,
      payload: {
        entries: [
          { param: 'fhr', value: { bpm: 104 } },
          { param: 'bp', value: { sys: 118, dia: 76 } },
        ],
      },
    });
    expect(observations.statusCode, observations.body).toBe(201);
    expect(
      observations.json<{ alerts: { kind: string }[] }>().alerts.some((a) => a.kind === 'fhr_abnormal'),
    ).toBe(true);
  });

  it('will not take a decision from the midwife, or one without a reason', async () => {
    const wrongPerson = await call({
      method: 'POST',
      url: `/api/v1/obs/partograph-alerts/${state.actionAlert}/decide`,
      token: midwife.token,
      reason: 'Continuing.',
      payload: { decision: 'continue_expectantly', decisionNote: 'Making good progress clinically.' },
    });
    expect(wrongPerson.statusCode).toBe(403);

    const noReason = await call({
      method: 'POST',
      url: `/api/v1/obs/partograph-alerts/${state.actionAlert}/decide`,
      token: obstetrician.token,
      reason: 'Continuing.',
      payload: { decision: 'continue_expectantly' },
    });
    expect(noReason.statusCode).toBe(400);
  });

  it('releases the chart when a decision is recorded', async () => {
    const decided = await call({
      method: 'POST',
      url: `/api/v1/obs/partograph-alerts/${state.actionAlert}/decide`,
      token: obstetrician.token,
      reason: 'Oxytocin augmentation started; reassess in two hours.',
      payload: { decision: 'augment', decisionNote: 'Oxytocin at 2 mU/min; reassess in two hours.' },
    });
    expect(decided.statusCode, decided.body).toBe(201);

    const resumed = await call({
      method: 'POST',
      url: `/api/v1/obs/labour-episodes/${state.episodeA}/partograph`,
      token: midwife.token,
      payload: { entries: [{ param: 'dilatation', value: { cm: 8 } }] },
    });
    expect(resumed.statusCode, resumed.body).toBe(201);
    expect(resumed.json<{ episode: { chartBlocked: boolean } }>().episode.chartBlocked).toBe(false);
  });

  it('runs the second-stage clock from full dilatation', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/obs/labour-episodes/${state.episodeA}`,
      token: midwife.token,
      payload: { secondStageFrom: minutesAgo(150) },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{ secondStageLimitMin: number; secondStageMinutesLeft: number }>();
    // A first baby without an epidural: two hours, and she is past it.
    expect(body.secondStageLimitMin).toBe(120);
    expect(body.secondStageMinutesLeft).toBeLessThan(0);

    const plotted = await call({
      method: 'POST',
      url: `/api/v1/obs/labour-episodes/${state.episodeA}/partograph`,
      token: midwife.token,
      payload: { entries: [{ param: 'fhr', value: { bpm: 138 } }] },
    });
    expect(
      plotted.json<{ alerts: { kind: string }[] }>().alerts.some((a) => a.kind === 'second_stage_prolonged'),
    ).toBe(true);
  });

  it('refuses a cervix wider than ten centimetres', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/obs/labour-episodes/${state.episodeA}/partograph`,
      token: midwife.token,
      payload: { entries: [{ param: 'dilatation', value: { cm: 14 } }] },
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toContain('0 to 10');
  });
});

describe('IP-011 · the birth', () => {
  it('creates the baby as a patient with their own hospital number', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/obs/labour-episodes/${state.episodeA}/deliveries`,
      token: midwife.token,
      payload: {
        mode: 'spontaneous_vaginal',
        deliveredAt: minutesAgo(30),
        uterotonicDrug: 'Oxytocin 10 IU IM',
        uterotonicAt: minutesAgo(29),
        eblMl: 250,
        eblMethod: 'calibrated_drape',
        newborn: {
          sex: 'female',
          status: 'live',
          birthWeightG: 2980,
          gaWeeks: 39,
          apgar1: 8,
          apgar5: 9,
          cordClampDelayed: true,
        },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{
      deliveries: { id: string; uterotonicDelaySec: number; uterotonicWithin1Min: boolean }[];
      newborns: { id: string; patientId: string; wristbandPairCode: string; sex: string }[];
    }>();
    const delivery = body.deliveries[0];
    const newborn = body.newborns[0];
    expect(delivery?.uterotonicDelaySec).toBe(60);
    expect(delivery?.uterotonicWithin1Min).toBe(true);
    expect(newborn?.sex).toBe('female');
    state.delivery = delivery?.id ?? '';
    state.newborn = newborn?.id ?? '';
    state.pairCode = newborn?.wristbandPairCode ?? '';

    // The baby is a patient, with a number from the same series as everybody
    // else's and a name that will change while the number does not.
    const { rows } = await pg
      .pool('migrator')
      .query<{ uhid: string; full_name: string }>(
        `SELECT uhid, full_name FROM patient.patients WHERE id = $1`,
        [newborn?.patientId],
      );
    expect(rows[0]?.uhid).toBeTruthy();
    expect(rows[0]?.full_name).toContain('Baby of');
  });

  it('refuses a uterotonic recorded before the birth, and a loss with no method', async () => {
    const backwards = await call({
      method: 'POST',
      url: `/api/v1/obs/labour-episodes/${state.episodeA}/deliveries`,
      token: midwife.token,
      payload: {
        mode: 'spontaneous_vaginal',
        deliveredAt: minutesAgo(20),
        uterotonicDrug: 'Oxytocin 10 IU IM',
        uterotonicAt: minutesAgo(25),
        newborn: { sex: 'male', status: 'live', apgar1: 9, apgar5: 9 },
      },
    });
    expect(backwards.statusCode).toBe(409);
    expect(detail(backwards)).toContain('before the birth');

    const noMethod = await call({
      method: 'POST',
      url: `/api/v1/obs/labour-episodes/${state.episodeA}/deliveries`,
      token: midwife.token,
      payload: {
        mode: 'spontaneous_vaginal',
        deliveredAt: minutesAgo(20),
        eblMl: 400,
        newborn: { sex: 'male', status: 'live', apgar1: 9, apgar5: 9 },
      },
    });
    expect(noMethod.statusCode).toBe(400);
    expect(detail(noMethod)).toContain('how the blood loss was measured');
  });

  it('needs the ten-minute score when the five-minute one is under seven', async () => {
    const missing = await call({
      method: 'POST',
      url: `/api/v1/obs/labour-episodes/${state.episodeA}/deliveries`,
      token: midwife.token,
      payload: {
        mode: 'spontaneous_vaginal',
        deliveredAt: minutesAgo(15),
        newborn: { sex: 'male', status: 'live', apgar1: 3, apgar5: 5 },
      },
    });
    expect(missing.statusCode).toBe(409);
    expect(detail(missing)).toContain('ten-minute score');

    const noTimeline = await call({
      method: 'POST',
      url: `/api/v1/obs/labour-episodes/${state.episodeA}/deliveries`,
      token: midwife.token,
      payload: {
        mode: 'spontaneous_vaginal',
        deliveredAt: minutesAgo(15),
        newborn: {
          sex: 'male',
          status: 'live',
          apgar1: 3,
          apgar5: 5,
          apgar10: 8,
          resuscitation: { ppv: { cycles: 30 } },
        },
      },
    });
    expect(noTimeline.statusCode).toBe(409);
    expect(detail(noTimeline)).toContain('timeline');
  });

  it('does not score a stillbirth', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/obs/labour-episodes/${state.episodeA}/deliveries`,
      token: midwife.token,
      payload: {
        mode: 'spontaneous_vaginal',
        deliveredAt: minutesAgo(10),
        newborn: { sex: 'male', status: 'stillbirth_macerated' },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const stillbirth = res
      .json<{ newborns: { status: string; apgar1: number | null }[] }>()
      .newborns.find((n) => n.status === 'stillbirth_macerated');
    expect(stillbirth?.apgar1).toBeNull();
  });
});

describe('IP-011 · the haemorrhage', () => {
  it('activates the protocol from the recorded blood loss', async () => {
    const episode = await call({
      method: 'POST',
      url: '/api/v1/obs/labour-episodes',
      token: midwife.token,
      payload: { admissionId: newId(), patientId: MOTHER_B, parity: 2 },
    });
    state.episodeB = episode.json<{ id: string }>().id;

    // Nine hundred millilitres after a vaginal birth is well past five hundred.
    const res = await call({
      method: 'POST',
      url: `/api/v1/obs/labour-episodes/${state.episodeB}/deliveries`,
      token: midwife.token,
      payload: {
        mode: 'spontaneous_vaginal',
        deliveredAt: minutesAgo(45),
        uterotonicDrug: 'Oxytocin 10 IU IM',
        uterotonicAt: minutesAgo(44),
        eblMl: 900,
        eblMethod: 'gravimetric',
        newborn: { sex: 'male', status: 'live', apgar1: 9, apgar5: 9, birthWeightG: 3400 },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<{ deliveries: { pphThresholdMl: number }[] }>().deliveries[0]?.pphThresholdMl).toBe(500);

    const activations = await call({
      method: 'GET',
      url: '/api/v1/obs/pph-activations',
      token: midwife.token,
    });
    const live = activations.json<{ id: string; trigger: string; eblAtTrigger: number }[]>();
    expect(live[0]?.trigger).toBe('ebl_threshold');
    expect(live[0]?.eblAtTrigger).toBe(900);
  });

  it('measures the tranexamic acid window from the birth, and refuses a close with no outcome', async () => {
    const activations = await call({
      method: 'GET',
      url: '/api/v1/obs/pph-activations',
      token: midwife.token,
    });
    const id = activations.json<{ id: string; txaMinutesLeft: number | null }[]>()[0]?.id ?? '';
    // Three hours from the birth, of which forty-five minutes have gone.
    expect(activations.json<{ txaMinutesLeft: number | null }[]>()[0]?.txaMinutesLeft).toBeLessThanOrEqual(
      136,
    );

    const stepped = await call({
      method: 'POST',
      url: `/api/v1/obs/pph-activations/${id}/steps`,
      token: midwife.token,
      payload: { step: 'txa', at: minutesAgo(20) },
    });
    expect(stepped.statusCode, stepped.body).toBe(201);
    expect(stepped.json<{ txaWithin3h: boolean }>().txaWithin3h).toBe(true);

    const noOutcome = await call({
      method: 'POST',
      url: `/api/v1/obs/pph-activations/${id}/close`,
      token: midwife.token,
      payload: { outcome: '' },
    });
    expect(noOutcome.statusCode).toBe(400);

    const closed = await call({
      method: 'POST',
      url: `/api/v1/obs/pph-activations/${id}/close`,
      token: midwife.token,
      payload: { outcome: 'Settled with uterotonics and bimanual compression; 1 unit transfused.' },
    });
    expect(closed.statusCode, closed.body).toBe(201);
  });
});

describe('IP-011 · two bands, one code', () => {
  it('decides the match itself, whatever the scanner believed', async () => {
    const matched = await call({
      method: 'POST',
      url: `/api/v1/obs/newborns/${state.newborn}/identity-check`,
      token: midwife.token,
      payload: {
        motherBandScan: state.pairCode,
        babyBandScan: state.pairCode,
        context: 'first_feed',
      },
    });
    expect(matched.statusCode, matched.body).toBe(201);
    expect(matched.json<{ matched: boolean }>().matched).toBe(true);

    const mismatched = await call({
      method: 'POST',
      url: `/api/v1/obs/newborns/${state.newborn}/identity-check`,
      token: midwife.token,
      payload: { motherBandScan: 'WB-WRONG', babyBandScan: state.pairCode, context: 'handover' },
    });
    expect(mismatched.statusCode, mismatched.body).toBe(201);
    expect(mismatched.json<{ matched: boolean }>().matched).toBe(false);
  });

  it('will not move a baby on an unmatched pair, and there is no way to force it', async () => {
    const refused = await call({
      method: 'POST',
      url: `/api/v1/obs/newborns/${state.newborn}`,
      token: midwife.token,
      payload: { nicuAdmitted: true },
    });
    expect(refused.statusCode).toBe(409);
    expect(detail(refused)).toContain('did not match');

    // The only way past is a scan that matches.
    const rescanned = await call({
      method: 'POST',
      url: `/api/v1/obs/newborns/${state.newborn}/identity-check`,
      token: midwife.token,
      payload: {
        motherBandScan: state.pairCode,
        babyBandScan: state.pairCode,
        context: 'handover',
      },
    });
    expect(rescanned.json<{ matched: boolean }>().matched).toBe(true);

    const moved = await call({
      method: 'POST',
      url: `/api/v1/obs/newborns/${state.newborn}`,
      token: midwife.token,
      payload: { nicuAdmitted: true },
    });
    expect(moved.statusCode, moved.body).toBe(201);
    expect(moved.json<{ blockedBy: string[] }>().blockedBy).toEqual([]);
  });

  it('leaves the mismatch, the action line and the birth on the outbox', async () => {
    const { rows } = await pg
      .pool('migrator')
      .query<{ event_type: string }>(
        `SELECT DISTINCT event_type FROM core.outbox_events WHERE event_type LIKE 'lr.%'`,
      );
    const types = rows.map((r) => r.event_type);
    for (const type of [
      'lr.partograph.action_line',
      'lr.fhr.abnormal',
      'lr.newborn.registered',
      'lr.pph.activated',
      'lr.identity.mismatch',
      'lr.birth.reportable',
    ]) {
      expect(types, type).toContain(type);
    }
  });
});

describe('IP-011 · Form 1', () => {
  it('runs a twenty-one-day clock and will not submit before medical records verifies', async () => {
    const drafted = await call({
      method: 'POST',
      url: `/api/v1/obs/newborns/${state.newborn}/birth-report`,
      token: mrd.token,
      payload: {
        form1: { placeOfBirth: 'VIMS Bengaluru', attendant: 'midwife', birthOrder: 1 },
      },
    });
    expect(drafted.statusCode, drafted.body).toBe(201);
    expect(drafted.json<{ daysLeft: number }>().daysLeft).toBeGreaterThan(19);

    const early = await call({
      method: 'POST',
      url: `/api/v1/obs/newborns/${state.newborn}/birth-report/submit`,
      token: mrd.token,
      payload: { crsRegNo: 'BLR/2026/998811' },
    });
    expect(early.statusCode).toBe(409);
    expect(detail(early)).toContain('verified by medical records');

    await call({
      method: 'POST',
      url: `/api/v1/obs/newborns/${state.newborn}/birth-report/verify`,
      token: mrd.token,
    });
    const submitted = await call({
      method: 'POST',
      url: `/api/v1/obs/newborns/${state.newborn}/birth-report/submit`,
      token: mrd.token,
      payload: { crsRegNo: 'BLR/2026/998811' },
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    expect(submitted.json<{ crsRegNo: string }>().crsRegNo).toBe('BLR/2026/998811');
  });

  it('keeps Form 1 out of the midwife’s hands and the chart out of medical records’', async () => {
    const wrongPerson = await call({
      method: 'POST',
      url: `/api/v1/obs/newborns/${state.newborn}/birth-report/verify`,
      token: midwife.token,
    });
    expect(wrongPerson.statusCode).toBe(403);

    const wrongPersonBack = await call({
      method: 'POST',
      url: `/api/v1/obs/labour-episodes/${state.episodeA}/partograph`,
      token: mrd.token,
      payload: { entries: [{ param: 'fhr', value: { bpm: 140 } }] },
    });
    expect(wrongPersonBack.statusCode).toBe(403);
  });

  it('answers every filtered list', async () => {
    for (const url of [
      '/api/v1/obs/labour-episodes?openOnly=true',
      '/api/v1/obs/labour-episodes?blockedOnly=true',
      '/api/v1/obs/newborns?reportDueOnly=true',
      '/api/v1/obs/pph-activations',
    ]) {
      const res = await call({ method: 'GET', url, token: midwife.token });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    }
  });
});
