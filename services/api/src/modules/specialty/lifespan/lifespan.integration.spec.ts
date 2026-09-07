import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import { LifespanController } from './lifespan.controller.js';
import { LifespanService } from './lifespan.service.js';

/**
 * OP-033, IP-015 and OP-034 against a real PostgreSQL 17.
 *
 * One problem seen at both ends of life:
 *
 *  1. **A weight-based dose never passes the adult dose**, and the error it
 *     prevents is invisible because every step of the arithmetic is correct.
 *  2. **Every weight is in grams**, so a newborn recorded as "3" is refused
 *     rather than dosed as three kilograms.
 *  3. **Centiles, bands, days of life and fluid volumes are all derived.**
 *  4. **Anticholinergic burden is summed by lookup**, because nobody adds up
 *     eleven drugs from a table.
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

/** Weighs children and assesses older people. */
const nurse = actor('life-nurse');
/** Prescribes: the paediatric dose, the neonatal fluids, the medication review. */
const doctor = actor('life-doctor');

const NURSE_KEYS = ['lifespan.read', 'paed.growth.record', 'geri.assessment.record'];
const DOCTOR_KEYS = [
  ...NURSE_KEYS,
  'paed.dose.calculate',
  'nicu.admission.manage',
  'nicu.fluids.prescribe',
  'geri.medication.review',
  'lifespan.report.read',
];

const CHILD = newId();
const BABY = newId();
const ELDER = newId();

/** What the suites hand each other. */
const state = { nicu: '' };

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

const appControllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as unknown[];
const alreadyWired = appControllers.includes(LifespanController);

@Module({
  imports: [AppModule],
  controllers: alreadyWired ? [] : [LifespanController],
  providers: alreadyWired ? [] : [LifespanService],
})
class LifespanTestModule {}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'LIFE' });
  await syncPermissions();

  await seedActor(nurse, NURSE_KEYS);
  await seedActor(doctor, DOCTOR_KEYS);

  await seedPatient(CHILD, 'Ananya Sharma');
  await seedPatient(BABY, 'Baby of Sharma');
  await seedPatient(ELDER, 'Kamala Nair');

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(LifespanTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();

  for (const who of [nurse, doctor]) {
    who.token = await login(who.username);
  }
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe('OP-033 · the adult ceiling', () => {
  it('doses a toddler by weight and an adolescent by the adult maximum', async () => {
    const toddler = await call({
      method: 'POST',
      url: '/api/v1/lifespan/paed-doses',
      token: doctor.token,
      payload: {
        patientId: CHILD,
        drugKey: 'paracetamol',
        drugName: 'Paracetamol',
        weightG: 12000,
        ageDays: 900,
        doseMgPerKg: 15,
        frequency: 'qds',
        route: 'po',
        dosesPerDay: 4,
        adultMaxSingleMg: 1000,
        adultMaxDailyMg: 4000,
      },
    });
    expect(toddler.statusCode, toddler.body).toBe(201);
    expect(toddler.json<{ finalSingleMg: number; capApplied: boolean }>()).toMatchObject({
      finalSingleMg: 180,
      capApplied: false,
    });

    // The same prescription on a ninety-kilogram fifteen-year-old computes to
    // 1350 mg. Every step is correct and the answer is an overdose.
    const teenager = await call({
      method: 'POST',
      url: '/api/v1/lifespan/paed-doses',
      token: doctor.token,
      payload: {
        patientId: CHILD,
        drugKey: 'paracetamol',
        drugName: 'Paracetamol',
        weightG: 90000,
        ageDays: 5500,
        doseMgPerKg: 15,
        frequency: 'qds',
        route: 'po',
        dosesPerDay: 4,
        adultMaxSingleMg: 1000,
        adultMaxDailyMg: 4000,
      },
    });
    expect(teenager.statusCode, teenager.body).toBe(201);
    const body = teenager.json<{
      calcSingleMg: number;
      finalSingleMg: number;
      capApplied: boolean;
      workingOut: string;
    }>();
    expect(body.calcSingleMg).toBe(1350);
    expect(body.finalSingleMg).toBe(1000);
    expect(body.capApplied).toBe(true);
    // And the arithmetic is spelled out, so it can be checked rather than
    // trusted.
    expect(body.workingOut).toContain('held at the adult dose');
  });

  it('refuses a daily total past the adult maximum, and a weight of three grams', async () => {
    const daily = await call({
      method: 'POST',
      url: '/api/v1/lifespan/paed-doses',
      token: doctor.token,
      payload: {
        patientId: CHILD,
        drugKey: 'paracetamol',
        drugName: 'Paracetamol',
        weightG: 60000,
        ageDays: 5000,
        doseMgPerKg: 20,
        frequency: 'qds',
        route: 'po',
        dosesPerDay: 4,
        adultMaxDailyMg: 4000,
      },
    });
    expect(daily.statusCode).toBe(409);
    expect(detail(daily)).toContain('dosed as an adult');

    // Three grams. The schema stops it before the database does, and both are
    // deliberate: there is nowhere in this module to put a weight in kilograms.
    const grams = await call({
      method: 'POST',
      url: '/api/v1/lifespan/paed-doses',
      token: doctor.token,
      payload: {
        patientId: BABY,
        drugKey: 'amoxicillin',
        drugName: 'Amoxicillin',
        weightG: 0,
        ageDays: 30,
        doseMgPerKg: 25,
        frequency: 'tds',
        route: 'po',
        dosesPerDay: 3,
      },
    });
    expect(grams.statusCode).toBe(400);
  });

  it('does not let the nurse prescribe, but does let them weigh', async () => {
    const prescribing = await call({
      method: 'POST',
      url: '/api/v1/lifespan/paed-doses',
      token: nurse.token,
      payload: {
        patientId: CHILD,
        drugKey: 'paracetamol',
        drugName: 'Paracetamol',
        weightG: 12000,
        ageDays: 900,
        doseMgPerKg: 15,
        frequency: 'qds',
        route: 'po',
      },
    });
    expect(prescribing.statusCode).toBe(403);

    const weighing = await call({
      method: 'POST',
      url: '/api/v1/lifespan/growth',
      token: nurse.token,
      payload: { patientId: CHILD, ageDays: 365, sex: 'female', weightG: 8800 },
    });
    expect(weighing.statusCode, weighing.body).toBe(201);
  });
});

describe('OP-033 · growth', () => {
  it('places a child on the WHO standard and bands them', async () => {
    const average = await call({
      method: 'POST',
      url: '/api/v1/lifespan/growth',
      token: nurse.token,
      payload: { patientId: CHILD, ageDays: 365, sex: 'male', weightG: 9600 },
    });
    expect(average.statusCode, average.body).toBe(201);
    const body = average.json<{ weightForAgeZ: number; weightCentile: number; nutritionBand: string }>();
    expect(body.weightForAgeZ).toBeCloseTo(0, 1);
    expect(body.weightCentile).toBeGreaterThan(40);
    expect(body.nutritionBand).toBe('normal');

    const small = await call({
      method: 'POST',
      url: '/api/v1/lifespan/growth',
      token: nurse.token,
      payload: {
        patientId: CHILD,
        measuredAt: new Date(Date.now() + 60_000).toISOString(),
        ageDays: 366,
        sex: 'male',
        weightG: 5800,
      },
    });
    expect(small.json<{ nutritionBand: string }>().nutritionBand).toBe('severe_underweight');
    // Grams a day since the last measurement — the figure a paediatrician uses
    // and nobody works out from two rows on a chart.
    expect(small.json<{ gainGPerDay: number | null }>().gainGPerDay).not.toBeNull();
  });

  it('leaves faltering growth on the outbox', async () => {
    const { rows } = await pg
      .pool('migrator')
      .query<{ event_type: string }>(
        `SELECT DISTINCT event_type FROM core.outbox_events WHERE event_type LIKE 'paed.%'`,
      );
    const types = rows.map((r) => r.event_type);
    expect(types).toContain('paed.growth.faltering');
    expect(types).toContain('paed.dose.capped');
  });
});

describe('IP-015 · the neonatal unit', () => {
  it('bands a baby on gestation and birth weight, and derives the day of life', async () => {
    const admitted = await call({
      method: 'POST',
      url: '/api/v1/lifespan/nicu-admissions',
      token: doctor.token,
      payload: {
        patientId: BABY,
        birthAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        gaWeeksAtBirth: 27,
        birthWeightG: 850,
      },
    });
    expect(admitted.statusCode, admitted.body).toBe(201);
    state.nicu = admitted.json<{ id: string }>().id;
    expect(
      admitted.json<{ gestationBand: string; birthWeightBand: string; dayOfLife: number }>(),
    ).toMatchObject({
      gestationBand: 'extremely_preterm',
      birthWeightBand: 'elbw',
      dayOfLife: 4,
    });
  });

  it('works out the volume that hangs, and shows the standard schedule beside it', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/lifespan/nicu-admissions/${state.nicu}/fluids`,
      token: doctor.token,
      payload: {
        forDate: new Date().toISOString().slice(0, 10),
        weightG: 900,
        mlPerKgPerDay: 120,
        fluid: '10% dextrose with electrolytes',
        enteralMl: 24,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{
      dayOfLife: number;
      totalMlPerDay: number;
      ivMlPerDay: number;
      mlPerHour: number;
      expectedMlPerKg: number;
    }>();
    expect(body.dayOfLife).toBe(4);
    expect(body.totalMlPerDay).toBeCloseTo(108, 1);
    expect(body.ivMlPerDay).toBeCloseTo(84, 1);
    expect(body.mlPerHour).toBeCloseTo(3.5, 1);
    // Shown rather than enforced: a growth-restricted baby, one under lights
    // and one with a patent ductus all belong off this curve.
    expect(body.expectedMlPerKg).toBe(120);
  });

  it('refuses a fluid order dated before the birth', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/lifespan/nicu-admissions/${state.nicu}/fluids`,
      token: doctor.token,
      payload: {
        forDate: new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10),
        weightG: 900,
        mlPerKgPerDay: 60,
        fluid: '10% dextrose',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toContain('before the baby was born');
  });
});

describe('OP-034 · the other end', () => {
  it('sums the anticholinergic burden and matches the Beers criteria by age', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/lifespan/medication-reviews',
      token: doctor.token,
      payload: {
        patientId: ELDER,
        ageYears: 78,
        medications: [
          { drugKey: 'amitriptyline', drugName: 'Amitriptyline' },
          { drugKey: 'oxybutynin', drugName: 'Oxybutynin' },
          { drugKey: 'furosemide', drugName: 'Furosemide' },
          { drugKey: 'metoprolol', drugName: 'Metoprolol' },
          { drugKey: 'atorvastatin', drugName: 'Atorvastatin' },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{
      drugCount: number;
      acbScore: number;
      beersCount: number;
      burdenHigh: boolean;
      polypharmacy: boolean;
      acbDrugs: unknown[];
    }>();
    // 3 + 3 + 1 + 1 = 8, from a table nobody looks up by hand.
    expect(body.acbScore).toBe(8);
    expect(body.burdenHigh).toBe(true);
    expect(body.polypharmacy).toBe(true);
    expect(body.beersCount).toBe(2);
    // And the contributing drugs, so the number can be argued with.
    expect(body.acbDrugs).toHaveLength(4);

    const younger = await call({
      method: 'POST',
      url: '/api/v1/lifespan/medication-reviews',
      token: doctor.token,
      payload: {
        patientId: ELDER,
        ageYears: 60,
        medications: [
          { drugKey: 'amitriptyline', drugName: 'Amitriptyline' },
          { drugKey: 'oxybutynin', drugName: 'Oxybutynin' },
        ],
      },
    });
    // The burden is a property of the drugs; the Beers list turns on the age.
    expect(younger.json<{ acbScore: number; beersCount: number }>()).toMatchObject({
      acbScore: 6,
      beersCount: 0,
    });
  });

  it('scores frailty and falls risk from their items', async () => {
    const frail = await call({
      method: 'POST',
      url: '/api/v1/lifespan/geri-assessments',
      token: nurse.token,
      payload: {
        patientId: ELDER,
        ageYears: 78,
        friedItems: {
          weightLoss: true,
          exhaustion: true,
          lowActivity: true,
          slowGait: false,
          weakGrip: false,
        },
        fallsLastYear: 1,
        fallsInjury: true,
        adlBarthel: 75,
      },
    });
    expect(frail.statusCode, frail.body).toBe(201);
    expect(frail.json<{ friedScore: number; frailtyBand: string; fallsRisk: string }>()).toMatchObject({
      friedScore: 3,
      frailtyBand: 'frail',
      fallsRisk: 'high',
    });

    // A Barthel index of 73 is not a Barthel index.
    const odd = await call({
      method: 'POST',
      url: '/api/v1/lifespan/geri-assessments',
      token: nurse.token,
      payload: {
        patientId: ELDER,
        ageYears: 78,
        friedItems: {
          weightLoss: false,
          exhaustion: false,
          lowActivity: false,
          slowGait: false,
          weakGrip: false,
        },
        adlBarthel: 73,
      },
    });
    expect(odd.statusCode).toBe(400);
  });

  it('leaves a high burden on the outbox, and answers every filtered list', async () => {
    const { rows } = await pg
      .pool('migrator')
      .query<{ event_type: string }>(
        `SELECT DISTINCT event_type FROM core.outbox_events WHERE event_type LIKE 'geri.%'`,
      );
    expect(rows.map((r) => r.event_type)).toContain('geri.burden.high');

    for (const url of [
      '/api/v1/lifespan/growth?falteringOnly=true',
      '/api/v1/lifespan/nicu-admissions?currentOnly=true',
      '/api/v1/lifespan/medication-reviews?highBurdenOnly=true',
    ]) {
      const res = await call({ method: 'GET', url, token: doctor.token });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    }
  });
});
