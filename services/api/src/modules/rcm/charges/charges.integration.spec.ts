import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { runSeed } from '@vims/db/seed';
import { startTestPostgres, type TestPostgres } from '@vims/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';

/**
 * RC-006 — a clinical act becoming money, end to end.
 *
 * This is the path that did not exist. `billing.charge_intents` was built with
 * everything a hand-off needs and stood empty: thirty specialty consoles
 * shipped, none of them raised a charge, nothing drained one onto a bill, and
 * the hospital did the work for free. No test noticed because the whole of RCM
 * — billing, tariff, payments, packages, insurance, schemes, estimates,
 * leakage, payouts — had no integration spec at all.
 *
 * The seed is `demo` rather than a hand-built fixture because the point is to
 * price a real service against a real published tariff. A test that invented
 * its own rate would prove the plumbing and not the price.
 */

let pg: TestPostgres;
let app: NestFastifyApplication;

const PASSWORD = 'VimsDev#2026';

let hospitalId = '';
let branchId = '';
let patientId = '';
let serviceId = '';
let token = '';

const state = { episodeId: '', planId: '', sessionId: '', billId: '', intentId: '' };

@Module({ imports: [AppModule] })
class ChargesTestModule {}

async function login(identifier: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { hospitalId, identifier, password: PASSWORD },
  });
  const body = res.json<{ accessToken?: string }>();
  if (typeof body.accessToken !== 'string') {
    throw new Error(`login failed: ${String(res.statusCode)} ${res.body}`);
  }
  return body.accessToken;
}

async function call(options: {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly payload?: Record<string, unknown>;
  readonly reason?: string;
}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.reason !== undefined) headers['x-reason'] = options.reason;
  if (options.method === 'POST') headers['idempotency-key'] = newId();
  return app.inject({
    method: options.method,
    url: options.url,
    headers,
    ...(options.method === 'GET' ? {} : { payload: options.payload ?? {} }),
  });
}

beforeAll(async () => {
  pg = await startTestPostgres();
  process.env['DATABASE_MIGRATE_URL'] = pg.connectionString('migrator');
  await runSeed(pg.pool('migrator'), 'demo');

  const pool = pg.pool('migrator');
  hospitalId = (await pool.query<{ id: string }>(`SELECT id FROM core.hospitals WHERE code = 'VIMS-BLR'`))
    .rows[0]!.id;

  // A service that actually has a published rate. Pricing against one without
  // is a test of the missing-rate path, which is a different test.
  const priced = await pool.query<{ service_id: string }>(
    `SELECT ti.service_id
       FROM mdm.tariff_items ti
       JOIN mdm.tariff_versions tv ON tv.id = ti.version_id
      WHERE tv.status = 'published' AND ti.service_id IS NOT NULL
        AND tv.hospital_id = $1
      LIMIT 1`,
    [hospitalId],
  );
  serviceId = priced.rows[0]?.service_id ?? '';
  branchId = (
    await pool.query<{ id: string }>(`SELECT id FROM core.branches WHERE hospital_id = $1 LIMIT 1`, [
      hospitalId,
    ])
  ).rows[0]!.id;

  patientId = (
    await pool.query<{ id: string }>(`SELECT id FROM patient.patients WHERE hospital_id = $1 LIMIT 1`, [
      hospitalId,
    ])
  ).rows[0]!.id;

  // One role holding everything this path touches, because the path crosses
  // the therapy floor and the billing desk and the point is the crossing.
  const roleId = newId();
  await pool.query(
    `INSERT INTO core.roles (id, hospital_id, key, name, description, home_workspace, category, updated_at)
     VALUES ($1,$2,'rc006_e2e','RC-006 e2e','end to end','dashboard','governance', now())`,
    [roleId, hospitalId],
  );
  for (const p of PERMISSION_CATALOGUE) {
    await pool.query(
      `INSERT INTO core.role_permissions (role_id, permission_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [roleId, p.key],
    );
  }
  const donor = await pool.query<{ password_hash: string }>(
    `SELECT password_hash FROM core.users WHERE hospital_id = $1 AND password_hash IS NOT NULL LIMIT 1`,
    [hospitalId],
  );
  const userId = newId();
  await pool.query(
    `INSERT INTO core.users (id, hospital_id, group_id, username, email, name, display_name,
                             password_hash, status, type, updated_at)
     VALUES ($1,$2,(SELECT group_id FROM core.hospitals WHERE id=$2),'rc006@vims-blr',
             'rc006@example.invalid','{"given":"RC","family":"Six"}'::jsonb,'RC Six',$3,'active','staff', now())`,
    [userId, hospitalId, donor.rows[0]!.password_hash],
  );
  await pool.query(
    `INSERT INTO core.user_roles (id, hospital_id, user_id, role_id, branch_id, updated_at)
     VALUES ($1,$2,$3,$4,$5, now())`,
    [newId(), hospitalId, userId, roleId, branchId],
  );

  // The hospital's own decision about what a physiotherapy session is worth.
  await pool.query(
    `INSERT INTO mdm.console_charge_map
       (id, hospital_id, console_code, act_kind, service_id, qty_unit, updated_at)
     VALUES ($1,$2,'THERAPY','session:physio',$3,'session', now())`,
    [newId(), hospitalId, serviceId],
  );

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379/13';
  process.env['JWT_ACCESS_SECRET'] = 'rc006-access-secret-that-is-long-enough-00';
  process.env['JWT_REFRESH_SECRET'] = 'rc006-refresh-secret-that-is-long-enough-0';
  process.env['RATE_LIMIT_AUTH_MAX'] = '10000';
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(ChargesTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();

  token = await login('rc006@vims-blr');
}, 300_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe('RC-006 · a therapy session becomes a bill line', () => {
  it('raises a charge when the session is attended, and not before', async () => {
    const episode = await call({
      method: 'POST',
      url: '/api/v1/therapy/episodes',
      payload: {
        patientId,
        discipline: 'physio',
        diagnosisIcd10: 'M17.1',
        precautions: { weightBearing: 'partial, 20 kg' },
      },
    });
    expect(episode.statusCode, episode.body).toBe(201);
    state.episodeId = episode.json<{ id: string }>().id;

    // A plan hangs off a signed assessment: OP-015's own rule, and the reason
    // this sequence is four calls rather than one.
    const assessment = await call({
      method: 'POST',
      url: `/api/v1/therapy/episodes/${state.episodeId}/assessments`,
      payload: {
        patientId,
        kind: 'initial',
        findings: { rom: { kneeFlexion: 85 } },
        impression: 'Post-operative stiffness.',
      },
    });
    expect(assessment.statusCode, assessment.body).toBe(201);
    const assessmentId = assessment.json<{ id: string }>().id;

    const signed = await call({
      method: 'POST',
      url: `/api/v1/therapy/assessments/${assessmentId}/sign`,
    });
    expect(signed.statusCode, signed.body).toBe(201);

    const plan = await call({
      method: 'POST',
      url: `/api/v1/therapy/episodes/${state.episodeId}/plans`,
      payload: { assessmentId, items: [{ type: 'exercise', ref: 'quads-set' }], frequencyPerWeek: 2 },
    });
    expect(plan.statusCode, plan.body).toBe(201);
    state.planId = plan.json<{ id: string }>().id;

    const booked = await call({
      method: 'POST',
      url: `/api/v1/therapy/episodes/${state.episodeId}/sessions`,
      payload: { planId: state.planId, scheduledAt: new Date().toISOString() },
    });
    expect(booked.statusCode, booked.body).toBe(201);
    state.sessionId = booked.json<{ id: string }>().id;

    // Booked is not delivered. Nothing is chargeable yet.
    const beforeAttend = await call({
      method: 'GET',
      url: `/api/v1/billing/charges/pending?patientId=${patientId}`,
    });
    expect(beforeAttend.statusCode, beforeAttend.body).toBe(200);
    expect(beforeAttend.json<unknown[]>()).toHaveLength(0);

    const attended = await call({
      method: 'POST',
      url: `/api/v1/therapy/sessions/${state.sessionId}/attend`,
      payload: { durationMin: 30 },
    });
    expect(attended.statusCode, attended.body).toBe(201);

    const pending = await call({
      method: 'GET',
      url: `/api/v1/billing/charges/pending?patientId=${patientId}`,
    });
    const rows =
      pending.json<
        {
          id: string;
          sourceModule: string;
          sourceId: string;
          serviceKey: string | null;
          unpriceable: boolean;
        }[]
      >();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceModule).toBe('THERAPY');
    expect(rows[0]?.sourceId).toBe(state.sessionId);
    // The map answered, so RC-003 will be able to price it.
    expect(rows[0]?.serviceKey).toBe(serviceId);
    expect(rows[0]?.unpriceable).toBe(false);
    state.intentId = rows[0]!.id;
  });

  it('charges the session once, however many times it is saved', async () => {
    // `(hospital_id, source_table, source_id)` is unique, so this is the
    // database refusing rather than the service remembering.
    const again = await call({
      method: 'POST',
      url: `/api/v1/therapy/sessions/${state.sessionId}/attend`,
      payload: { durationMin: 30 },
    });
    // Attending twice is refused by the therapy module itself; either way the
    // charge count is what matters.
    // 404 as well as 409: the therapy module takes the session out of the
    // bookable state, so the second attend does not find one to attend.
    expect([201, 404, 409]).toContain(again.statusCode);

    const pending = await call({
      method: 'GET',
      url: `/api/v1/billing/charges/pending?patientId=${patientId}`,
    });
    expect(pending.json<unknown[]>()).toHaveLength(1);
  });

  it('posts the charge onto a bill at the tariff price', async () => {
    const bill = await call({
      method: 'POST',
      url: '/api/v1/billing/bills',
      payload: { patientId, billType: 'op', payerType: 'self' },
    });
    expect(bill.statusCode, bill.body).toBe(201);
    state.billId = bill.json<{ id: string }>().id;

    const posted = await call({
      method: 'POST',
      url: `/api/v1/billing/bills/${state.billId}/post-charges`,
      payload: { itemType: 'procedure' },
    });
    expect(posted.statusCode, posted.body).toBe(201);
    expect(posted.json<{ posted: number }>().posted).toBe(1);
    expect(posted.json<{ unpriceable: number }>().unpriceable).toBe(0);

    // The line is on the bill, priced by RC-003 rather than by the console.
    const detail = await call({ method: 'GET', url: `/api/v1/billing/bills/${state.billId}` });
    expect(detail.statusCode, detail.body).toBe(200);
    const items = detail.json<{ items?: { sourceRefId: string; net: string }[] }>().items ?? [];
    const line = items.find((i) => i.sourceRefId === state.sessionId);
    expect(line, 'the attended session should be a line on the bill').toBeDefined();
    expect(Number(line?.net ?? '0')).toBeGreaterThan(0);

    // And the intent now points at what it became.
    const after = await call({
      method: 'GET',
      url: `/api/v1/billing/charges/pending?patientId=${patientId}&unbilledOnly=false`,
    });
    const posted1 = after
      .json<{ id: string; status: string; billLineId: string | null; billId: string | null }[]>()
      .find((r) => r.id === state.intentId);
    expect(posted1?.status).toBe('posted');
    expect(posted1?.billLineId).not.toBeNull();
    expect(posted1?.billId).toBe(state.billId);
  });

  it('is safe to post twice — the second run bills nothing again', async () => {
    const again = await call({
      method: 'POST',
      url: `/api/v1/billing/bills/${state.billId}/post-charges`,
      payload: { itemType: 'procedure' },
    });
    expect(again.statusCode, again.body).toBe(201);
    // Nothing pending is left, so nothing is posted a second time.
    expect(again.json<{ posted: number }>().posted).toBe(0);

    const detail = await call({ method: 'GET', url: `/api/v1/billing/bills/${state.billId}` });
    const items = detail.json<{ items?: { sourceRefId: string }[] }>().items ?? [];
    expect(items.filter((i) => i.sourceRefId === state.sessionId)).toHaveLength(1);
  });

  it('reverses a billed charge with a reason, and refuses one without', async () => {
    const bare = await call({
      method: 'POST',
      url: `/api/v1/billing/charges/${state.intentId}/reverse`,
      payload: { reason: 'no' },
      reason: 'no',
    });
    expect(bare.statusCode).toBe(400);

    const ok = await call({
      method: 'POST',
      url: `/api/v1/billing/charges/${state.intentId}/reverse`,
      payload: { reason: 'Session was recorded against the wrong patient and has been re-entered.' },
      reason: 'Session was recorded against the wrong patient and has been re-entered.',
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json<{ status: string }>().status).toBe('reversed');
  });

  it('records unmapped work rather than losing it, and does not bill it', async () => {
    // A second episode in a discipline the hospital has not priced. The
    // session still raises its charge — held, never zeroed — because "nobody
    // has priced this" and "this is free" are different answers.
    const episode = await call({
      method: 'POST',
      url: '/api/v1/therapy/episodes',
      payload: {
        patientId,
        discipline: 'speech',
        setting: 'ip',
      },
    });
    expect(episode.statusCode, episode.body).toBe(201);
    const eid = episode.json<{ id: string }>().id;

    const a2 = await call({
      method: 'POST',
      url: `/api/v1/therapy/episodes/${eid}/assessments`,
      payload: {
        patientId,
        kind: 'initial',
        findings: { swallow: 'delayed' },
        impression: 'Oropharyngeal dysphagia.',
      },
    });
    expect(a2.statusCode, a2.body).toBe(201);
    await call({ method: 'POST', url: `/api/v1/therapy/assessments/${a2.json<{ id: string }>().id}/sign` });

    const plan = await call({
      method: 'POST',
      url: `/api/v1/therapy/episodes/${eid}/plans`,
      payload: {
        assessmentId: a2.json<{ id: string }>().id,
        items: [{ type: 'exercise', ref: 'effortful-swallow' }],
        frequencyPerWeek: 2,
      },
    });
    expect(plan.statusCode, plan.body).toBe(201);
    const booked = await call({
      method: 'POST',
      url: `/api/v1/therapy/episodes/${eid}/sessions`,
      payload: { planId: plan.json<{ id: string }>().id, scheduledAt: new Date().toISOString() },
    });
    await call({
      method: 'POST',
      url: `/api/v1/therapy/sessions/${booked.json<{ id: string }>().id}/attend`,
      payload: { durationMin: 30 },
    });

    const pending = await call({
      method: 'GET',
      url: `/api/v1/billing/charges/pending?patientId=${patientId}`,
    });
    const unmapped = pending.json<{ serviceKey: string | null; unpriceable: boolean }[]>();
    expect(unmapped.length).toBeGreaterThan(0);
    expect(unmapped.every((r) => r.serviceKey === null)).toBe(true);
    expect(unmapped.every((r) => r.unpriceable)).toBe(true);

    // Posting leaves it exactly where it is, and says so.
    const posted = await call({
      method: 'POST',
      url: `/api/v1/billing/bills/${state.billId}/post-charges`,
      payload: { itemType: 'procedure' },
    });
    expect(posted.json<{ posted: number }>().posted).toBe(0);
    expect(posted.json<{ unpriceable: number }>().unpriceable).toBeGreaterThan(0);
  });
});
