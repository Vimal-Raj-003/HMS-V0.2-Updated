import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import { OphthalmologyController } from './ophthalmology.controller.js';
import { OphthalmologyService } from './ophthalmology.service.js';

/**
 * OP-025 — the ophthalmology console, against a real PostgreSQL 17.
 *
 * The properties here are the ones that cannot be read off the code:
 *
 *  1. **Every measurement names one eye.** `bilateral` is a diagnosis, never a
 *     reading — two eyes that measure the same are two measurements that agree
 *     today, and the day they stop a shared row has nowhere to put it.
 *  2. **logMAR is the database's, not the caller's.** 6/18 is 0.48 whoever
 *     typed it, the ladder below the chart has fixed values, and a child who
 *     fixes and follows gets no invented number at all.
 *  3. **Powers come in quarter dioptres and an axis runs 1–180.** A sphere of
 *     −2.13 is a typo the optician finds after the patient has gone home.
 *  4. **A signed prescription cannot be changed**, and the signature records
 *     whether an optometrist made it under delegation.
 *  5. **A lens is chosen from biometry**, one live plan per eye, and staleness
 *     is reported rather than refused.
 *
 * Investigations are deliberately absent: an OCT is ordered through the
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

/** The ophthalmologist: records, signs the visit, signs a prescription, plans. */
const doctor = actor('eye-doctor');
/** The optometrist: records everything, signs nothing. */
const optometrist = actor('eye-optometrist');
/** An optometrist at a hospital that has delegated the spectacle signature. */
const delegated = actor('eye-delegated');

const DOCTOR_KEYS = [
  'ophtha.visit.read',
  'ophtha.visit.create',
  'ophtha.optometry.record',
  'ophtha.exam.record',
  'ophtha.exam.sign',
  'ophtha.spectacle_rx.sign',
  'ophtha.surgery.plan',
  'ophtha.surgery.book',
];
const OPTOMETRIST_KEYS = ['ophtha.visit.read', 'ophtha.visit.create', 'ophtha.optometry.record'];
const DELEGATED_KEYS = [...OPTOMETRIST_KEYS, 'ophtha.spectacle_rx.sign_delegated'];

const PATIENT = newId();
const ENCOUNTER_A = newId();

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
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly url: string;
  readonly token: string;
  readonly payload?: Record<string, unknown>;
}

async function call(options: CallOptions) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.token}`,
    'x-reason': 'integration test',
  };
  if (options.method === 'POST') headers['idempotency-key'] = newId();
  return app.inject({
    method: options.method,
    url: options.url,
    headers,
    ...(options.method === 'GET' ? {} : { payload: options.payload ?? {} }),
  });
}

const appControllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as unknown[];
const alreadyWired = appControllers.includes(OphthalmologyController);

@Module({
  imports: [AppModule],
  controllers: alreadyWired ? [] : [OphthalmologyController],
  providers: alreadyWired ? [] : [OphthalmologyService],
})
class OphthalmologyTestModule {}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'EYE' });
  await syncPermissions();
  await defineSeries('SPEC_RX', 'SPEC{BR}{SEQ:5}');

  await seedActor(doctor, DOCTOR_KEYS);
  await seedActor(optometrist, OPTOMETRIST_KEYS);
  await seedActor(delegated, DELEGATED_KEYS);

  await pg.pool('migrator').query(
    `INSERT INTO patient.patients
       (id, hospital_id, branch_id, uhid, uhid_normalised, first_name, full_name, gender, dob,
        mobile, mobile_local, dedupe_fingerprint, status, updated_at)
     VALUES ($1, $2, $3, $4, $4, 'Vidya', 'Vidya Naidu', 'female', '1958-11-04'::date,
             '+919845000000', '9845000000', $5, 'active', now())`,
    [
      PATIENT,
      tenants.hospitalA,
      tenants.branchA,
      `UH-${PATIENT.replace(/-/g, '').slice(-10)}`,
      PATIENT.replace(/-/g, ''),
    ],
  );
  await seedPatientAndEncounter(ENCOUNTER_A);

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(OphthalmologyTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  for (const who of [doctor, optometrist, delegated]) {
    who.token = await login(who.username);
  }
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('the refraction lane', () => {
  let visitId = '';

  it('opens one eye visit per consultation, and refuses a second', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/ophtha/visits',
      token: optometrist.token,
      payload: { patientId: PATIENT, encounterId: ENCOUNTER_A, chiefComplaintCodes: ['H25.1'] },
    });
    expect(created.statusCode).toBe(201);
    visitId = created.json<{ id: string }>().id;
    expect(visitId).not.toBe('');

    const second = await call({
      method: 'POST',
      url: '/api/v1/ophtha/visits',
      token: optometrist.token,
      payload: { patientId: PATIENT, encounterId: ENCOUNTER_A },
    });
    expect(second.statusCode).toBe(409);
  });

  it('refuses an acuity of both eyes at once', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/ophtha/visits/${visitId}/acuity`,
      token: optometrist.token,
      payload: {
        readings: [{ eye: 'bilateral', context: 'bcva', notation: 'snellen_6', value: '6/6' }],
      },
    });
    // The Zod schema has no `bilateral` member on a measurement, so it never
    // reaches the CHECK that would also refuse it.
    expect(res.statusCode).toBe(400);
  });

  it('derives logMAR from the notation, and invents nothing where there is no number', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/ophtha/visits/${visitId}/acuity`,
      token: optometrist.token,
      payload: {
        readings: [
          { eye: 'right', context: 'ucva', notation: 'snellen_6', value: '6/60' },
          { eye: 'right', context: 'bcva', notation: 'snellen_6', value: '6/18' },
          { eye: 'left', context: 'bcva', notation: 'snellen_6', value: '6/9' },
          { eye: 'left', context: 'ucva', notation: 'cf', value: 'CF 2m' },
          { eye: 'left', context: 'post_op', notation: 'nlp', value: 'NLP' },
          { eye: 'right', context: 'near', notation: 'csm', value: 'Fixes and follows' },
        ],
      },
    });
    expect(res.statusCode).toBe(201);

    const rows = res.json<{ notation: string; value: string; logmar: number | null }[]>();
    const at = (value: string): number | null => rows.find((r) => r.value === value)?.logmar ?? null;

    expect(at('6/60')).toBe(1);
    expect(at('6/18')).toBe(0.48);
    expect(at('6/9')).toBe(0.18);
    expect(at('CF 2m')).toBe(1.9);
    expect(at('NLP')).toBe(3);
    // A child who fixes and follows has an acuity nobody measured. A number
    // here would be invented, and an invented point on a trend is worse than a
    // gap in it.
    expect(rows.find((r) => r.notation === 'csm')?.logmar).toBeNull();
  });

  it('refuses a Snellen value that is not a fraction, in words an optometrist can act on', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/ophtha/visits/${visitId}/acuity`,
      token: optometrist.token,
      payload: { readings: [{ eye: 'right', context: 'bcva', notation: 'snellen_6', value: 'good' }] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: string }>().detail).toContain('6/18');
  });

  it('refuses powers off the quarter-dioptre grid, an axis of zero, and a cylinder without one', async () => {
    for (const [refraction, expected] of [
      [{ eye: 'right', kind: 'subjective', sph: -2.13 }, 400],
      [{ eye: 'right', kind: 'subjective', sph: -2.0, cyl: -1.0, axis: 0 }, 400],
      [{ eye: 'right', kind: 'subjective', sph: -2.0, cyl: -1.0 }, 400],
    ] as const) {
      const res = await call({
        method: 'POST',
        url: `/api/v1/ophtha/visits/${visitId}/refractions`,
        token: optometrist.token,
        payload: { refractions: [refraction] },
      });
      expect(res.statusCode, JSON.stringify(refraction)).toBe(expected);
    }
  });

  it('accepts a refraction a lens can actually be ground to', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/ophtha/visits/${visitId}/refractions`,
      token: optometrist.token,
      payload: {
        refractions: [
          {
            eye: 'right',
            kind: 'subjective',
            sph: -2.0,
            cyl: -1.0,
            axis: 90,
            add: 2.0,
            pdBino: 62,
            source: 'device',
          },
          { eye: 'left', kind: 'subjective', sph: -1.75, add: 2.0, pdBino: 62, source: 'device' },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const rows = res.json<{ eye: string; sph: number; source: string }[]>();
    expect(rows).toHaveLength(2);
    // Which readings a device pushed and which a person typed is worth being
    // able to find later; an override of the first by the second is a decision.
    expect(rows.every((r) => r.source === 'device')).toBe(true);
  });

  it('bands a pressure, corrects it for corneal thickness, and raises the urgent one', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/ophtha/visits/${visitId}/iop`,
      token: optometrist.token,
      payload: {
        readings: [
          { eye: 'right', method: 'nct', valueMmhg: 16 },
          { eye: 'left', method: 'nct', valueMmhg: 34, cctUm: 505 },
        ],
      },
    });
    expect(res.statusCode).toBe(201);

    const rows = res.json<{ eye: string; band: string; correctedMmhg: number | null }[]>();
    expect(rows.find((r) => r.eye === 'right')?.band).toBe('normal');
    expect(rows.find((r) => r.eye === 'left')?.band).toBe('urgent');
    // A thin cornea reads low, which is how glaucoma is missed in exactly the
    // eyes most at risk of it.
    expect(rows.find((r) => r.eye === 'left')?.correctedMmhg).toBeGreaterThan(34);

    const events = await pg
      .pool('migrator')
      .query(`SELECT payload FROM core.outbox_events WHERE event_type = 'ophtha.iop.high'`);
    expect(
      events.rowCount,
      'a pressure of 34 read at a machine in the corridor has to reach the doctor before the patient leaves',
    ).toBeGreaterThanOrEqual(1);
  });

  it('refuses dilation that does not name its drops', async () => {
    const nameless = await call({
      method: 'PATCH',
      url: `/api/v1/ophtha/visits/${visitId}/dilate`,
      token: optometrist.token,
      payload: { cycloplegic: false },
    });
    expect(nameless.statusCode).toBe(400);

    const named = await call({
      method: 'PATCH',
      url: `/api/v1/ophtha/visits/${visitId}/dilate`,
      token: optometrist.token,
      payload: { drug: 'Tropicamide 1% + Phenylephrine 5%', cycloplegic: false },
    });
    expect(named.statusCode).toBe(200);
    expect(named.json<{ dilatedAt: string | null }>().dilatedAt).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('the examination and the signature', () => {
  let visitId = '';

  beforeAll(async () => {
    const encounter = newId();
    await seedPatientAndEncounter(encounter);
    const created = await call({
      method: 'POST',
      url: '/api/v1/ophtha/visits',
      token: doctor.token,
      payload: { patientId: PATIENT, encounterId: encounter },
    });
    visitId = created.json<{ id: string }>().id;
  });

  it('keeps the examination with the doctor', async () => {
    const byOptometrist = await call({
      method: 'POST',
      url: `/api/v1/ophtha/visits/${visitId}/exam`,
      token: optometrist.token,
      payload: { segment: 'posterior', eye: 'left', cdrVertical: 0.8 },
    });
    expect(byOptometrist.statusCode).toBe(403);
  });

  it('refuses a cup-disc ratio outside 0 to 1 and records a real one', async () => {
    const impossible = await call({
      method: 'POST',
      url: `/api/v1/ophtha/visits/${visitId}/exam`,
      token: doctor.token,
      payload: { segment: 'posterior', eye: 'left', cdrVertical: 1.4 },
    });
    expect(impossible.statusCode).toBe(400);

    const recorded = await call({
      method: 'POST',
      url: `/api/v1/ophtha/visits/${visitId}/exam`,
      token: doctor.token,
      payload: {
        segment: 'posterior',
        eye: 'left',
        cdrVertical: 0.8,
        drGrade: 'moderate_npdr',
        dme: false,
        findings: { disc: 'notched inferiorly' },
      },
    });
    expect(recorded.statusCode).toBe(201);
    expect(recorded.json<{ drGrade: string }>().drGrade).toBe('moderate_npdr');
  });

  it('lets a diagnosis be of both eyes, which a measurement may not', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/ophtha/visits/${visitId}/diagnoses`,
      token: doctor.token,
      payload: {
        diagnoses: [
          { eye: 'right', icd10: 'H25.1', isPrimary: true },
          { eye: 'bilateral', icd10: 'H40.11' },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ eye: string }[]>().some((d) => d.eye === 'bilateral')).toBe(true);
  });

  it('signs once, and refuses to sign twice', async () => {
    const signed = await call({
      method: 'POST',
      url: `/api/v1/ophtha/visits/${visitId}/sign`,
      token: doctor.token,
    });
    expect(signed.statusCode).toBe(201);
    expect(signed.json<{ signedAt: string | null; stage: string }>().signedAt).not.toBeNull();
    expect(signed.json<{ stage: string }>().stage).toBe('done');

    const again = await call({
      method: 'POST',
      url: `/api/v1/ophtha/visits/${visitId}/sign`,
      token: doctor.token,
    });
    expect(again.statusCode).toBe(409);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('the prescription that leaves the building', () => {
  let visitId = '';

  beforeAll(async () => {
    const encounter = newId();
    await seedPatientAndEncounter(encounter);
    const created = await call({
      method: 'POST',
      url: '/api/v1/ophtha/visits',
      token: doctor.token,
      payload: { patientId: PATIENT, encounterId: encounter },
    });
    visitId = created.json<{ id: string }>().id;
  });

  it('refuses a blank sheet with a signature on it', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/ophtha/visits/${visitId}/spectacle-rx`,
      token: doctor.token,
      payload: { pdBino: 62 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps the plain signature with the doctor and the delegated one apart', async () => {
    const byOptometrist = await call({
      method: 'POST',
      url: `/api/v1/ophtha/visits/${visitId}/spectacle-rx`,
      token: optometrist.token,
      payload: { right: { distance: { sph: -2.0 } } },
    });
    expect(byOptometrist.statusCode).toBe(403);

    // The delegated route is a different key. An optometrist without it cannot
    // reach it either, which is the point of the hospital granting it.
    const undelegated = await call({
      method: 'POST',
      url: `/api/v1/ophtha/visits/${visitId}/spectacle-rx/delegated`,
      token: optometrist.token,
      payload: { right: { distance: { sph: -2.0 } } },
    });
    expect(undelegated.statusCode).toBe(403);
  });

  it('signs, numbers, dates and then refuses every change', async () => {
    const signed = await call({
      method: 'POST',
      url: `/api/v1/ophtha/visits/${visitId}/spectacle-rx`,
      token: doctor.token,
      payload: {
        right: { distance: { sph: -2.0, cyl: -1.0, axis: 90 }, near: { add: 2.0 } },
        left: { distance: { sph: -1.75 } },
        pdBino: 62,
        validMonths: 12,
      },
    });
    expect(signed.statusCode).toBe(201);
    const rx = signed.json<{
      id: string;
      rxNo: string;
      validUntil: string;
      signedUnderDelegation: boolean;
    }>();
    expect(rx.rxNo).toMatch(/^SPEC/u);
    expect(rx.signedUnderDelegation).toBe(false);
    expect(new Date(rx.validUntil).getTime()).toBeGreaterThan(Date.now());

    // There is no route that edits one. The database refuses it too, which is
    // what makes the absence of a route a rule rather than an oversight.
    await expect(
      pg
        .pool('migrator')
        .query(`UPDATE specialty.ophtha_spectacle_rx SET lines = '{}'::jsonb WHERE id = $1`, [rx.id]),
    ).rejects.toThrow(/signed and cannot be changed/u);

    // Recording that it was printed is the one change it takes.
    const printed = await pg
      .pool('migrator')
      .query(
        `UPDATE specialty.ophtha_spectacle_rx SET printed_at = now() WHERE id = $1 RETURNING printed_at`,
        [rx.id],
      );
    expect(printed.rowCount).toBe(1);
  });

  it('records a delegated signature as delegated', async () => {
    const encounter = newId();
    await seedPatientAndEncounter(encounter);
    const created = await call({
      method: 'POST',
      url: '/api/v1/ophtha/visits',
      token: delegated.token,
      payload: { patientId: PATIENT, encounterId: encounter },
    });
    const otherVisit = created.json<{ id: string }>().id;

    const signed = await call({
      method: 'POST',
      url: `/api/v1/ophtha/visits/${otherVisit}/spectacle-rx/delegated`,
      token: delegated.token,
      payload: { right: { distance: { sph: -1.5 } }, pdBino: 60 },
    });
    expect(signed.statusCode).toBe(201);
    expect(
      signed.json<{ signedUnderDelegation: boolean }>().signedUnderDelegation,
      'a prescription signed under delegation is a different thing to a regulator',
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('the lens, and what it is chosen from', () => {
  let visitId = '';

  beforeAll(async () => {
    const encounter = newId();
    await seedPatientAndEncounter(encounter);
    const created = await call({
      method: 'POST',
      url: '/api/v1/ophtha/visits',
      token: doctor.token,
      payload: { patientId: PATIENT, encounterId: encounter },
    });
    visitId = created.json<{ id: string }>().id;
  });

  it('refuses a lens power with no biometry behind it', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/ophtha/visits/${visitId}/surgery-plans`,
      token: doctor.token,
      payload: {
        procedureCode: 'PHACO_IOL',
        eye: 'right',
        anaesthesia: 'topical',
        iolPower: 21.5,
        iolFormula: 'barrett',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: string }>().detail).toContain('not adjustable afterwards');
  });

  it('refuses a power with no formula, because the formulae disagree', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/ophtha/visits/${visitId}/surgery-plans`,
      token: doctor.token,
      payload: {
        procedureCode: 'PHACO_IOL',
        eye: 'right',
        anaesthesia: 'topical',
        iolPower: 21.5,
        biometry: { al: 23.42, k1: 43.75, k2: 44.5 },
        biometryAt: new Date().toISOString(),
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: string }>().detail).toContain('formula');
  });

  it('plans from biometry, reports staleness rather than refusing it, and holds the eye', async () => {
    const eightMonthsAgo = new Date(Date.now() - 243 * 86_400_000).toISOString();
    const planned = await call({
      method: 'POST',
      url: `/api/v1/ophtha/visits/${visitId}/surgery-plans`,
      token: doctor.token,
      payload: {
        procedureCode: 'PHACO_IOL',
        eye: 'right',
        anaesthesia: 'topical',
        iolModel: 'Alcon SN60WF',
        iolPower: 21.5,
        iolFormula: 'barrett',
        targetRefraction: -0.25,
        biometry: { al: 23.42, k1: 43.75, k2: 44.5, acd: 3.12 },
        biometryAt: eightMonthsAgo,
        npcbviFlag: true,
      },
    });
    expect(planned.statusCode).toBe(201);
    const plan = planned.json<{ id: string; biometryStale: boolean; biometryAgeDays: number }>();
    // Six months is a convention, and a stable eye is a stable eye — but the
    // surgeon should be the one deciding that, knowing the number.
    expect(plan.biometryStale).toBe(true);
    expect(plan.biometryAgeDays).toBeGreaterThan(180);

    const second = await call({
      method: 'POST',
      url: `/api/v1/ophtha/visits/${visitId}/surgery-plans`,
      token: doctor.token,
      payload: { procedureCode: 'SICS', eye: 'right', anaesthesia: 'peribulbar' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ detail: string }>().detail).toContain('live plan for that eye');

    // The other eye is a different plan, and always was.
    const otherEye = await call({
      method: 'POST',
      url: `/api/v1/ophtha/visits/${visitId}/surgery-plans`,
      token: doctor.token,
      payload: { procedureCode: 'PHACO_IOL', eye: 'left', anaesthesia: 'topical' },
    });
    expect(otherEye.statusCode).toBe(201);

    const noReason = await call({
      method: 'PATCH',
      url: `/api/v1/ophtha/surgery-plans/${plan.id}`,
      token: doctor.token,
      payload: { status: 'cancelled' },
    });
    expect(noReason.statusCode).toBe(400);

    const cancelled = await call({
      method: 'PATCH',
      url: `/api/v1/ophtha/surgery-plans/${plan.id}`,
      token: doctor.token,
      payload: { status: 'cancelled', reason: 'Patient deferred until after the monsoon' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<{ status: string }>().status).toBe('cancelled');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('the trend a glaucoma clinic is run on', () => {
  it('returns pressures oldest first, corrected where a thickness was measured', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/ophtha/patients/${PATIENT}/trends?metric=iop`,
      token: doctor.token,
    });
    expect(res.statusCode).toBe(200);
    const points = res.json<{ at: string; eye: string; value: number }[]>();
    expect(points.length).toBeGreaterThanOrEqual(2);

    const times = points.map((p) => new Date(p.at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('plots best-corrected acuity in logMAR, and only where there is a number', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/ophtha/patients/${PATIENT}/trends?metric=logmar`,
      token: doctor.token,
    });
    expect(res.statusCode).toBe(200);
    const points = res.json<{ value: number }[]>();
    expect(points.length).toBeGreaterThanOrEqual(1);
    expect(points.every((p) => Number.isFinite(p.value))).toBe(true);
  });

  it('answers a malformed identifier as absence, not as a fault of ours', async () => {
    const res = await call({
      method: 'GET',
      url: '/api/v1/ophtha/visits/not-a-uuid',
      token: doctor.token,
    });
    expect(res.statusCode).toBe(404);
  });
});
