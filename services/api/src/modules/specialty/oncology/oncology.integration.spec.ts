import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import { OncologyController } from './oncology.controller.js';
import { OncologyService } from './oncology.service.js';

/**
 * OP-031 and IP-023 against a real PostgreSQL 17.
 *
 * The rules whose violation kills somebody the same week:
 *
 *  1. **The dose is derived** from a height and a weight, and no request can
 *     carry the answer.
 *  2. **A vinca alkaloid is never intrathecal** — refused in the library and
 *     refused again on the order, with no key that reaches it.
 *  3. **An absolute cap is absolute**: vincristine computes to 2.55 mg on a
 *     tall adult and comes out at 2.
 *  4. **The lifetime total is the database's**, across cycles and years, and
 *     the ceiling refuses.
 *  5. **Counts, pharmacy and two nurses** each gate the next step, and the
 *     second person is always a second person.
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

/** Writes the plan, signs the cycle, and is the Act of this module. */
const oncologist = actor('onc-doctor');
/** The second oncologist. A countersignature is a second person. */
const second = actor('onc-doctor2');
/** Recomputes the dose independently, and can stop it. */
const pharmacist = actor('onc-pharm');
/** Gives it at the chair, with a colleague. */
const nurse = actor('onc-nurse');
const nurse2 = actor('onc-nurse2');

const DOCTOR_KEYS = [
  'onco.case.read',
  'onco.case.manage',
  'onco.plan.write',
  'onco.cycle.schedule',
  'onco.cycle.sign',
  'onco.administer',
  'onco.toxicity.record',
  'onco.report.read',
  'onco.regimen.configure',
];
const SECOND_KEYS = [...DOCTOR_KEYS, 'onco.cycle.cosign'];
const PHARM_KEYS = ['onco.case.read', 'onco.pharmacy.verify'];
const NURSE_KEYS = ['onco.case.read', 'onco.administer', 'onco.toxicity.record'];

const PATIENT = newId();

/** What the suites hand each other. */
const state = {
  regimen: '',
  drugCyclo: '',
  drugDoxo: '',
  drugVincristine: '',
  drugMethotrexate: '',
  caseId: '',
  plan: '',
  cycle: '',
  lineDoxo: '',
  lineVinc: '',
};

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

/** A moment that many minutes ago, as an ISO timestamp. */
const minutesAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();

const appControllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as unknown[];
const alreadyWired = appControllers.includes(OncologyController);

@Module({
  imports: [AppModule],
  controllers: alreadyWired ? [] : [OncologyController],
  providers: alreadyWired ? [] : [OncologyService],
})
class OncologyTestModule {}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'ONC' });
  await syncPermissions();

  await seedActor(oncologist, DOCTOR_KEYS);
  await seedActor(second, SECOND_KEYS);
  await seedActor(pharmacist, PHARM_KEYS);
  await seedActor(nurse, NURSE_KEYS);
  await seedActor(nurse2, NURSE_KEYS);

  await seedPatient(PATIENT, 'Meera Iyer');

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(OncologyTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();

  for (const who of [oncologist, second, pharmacist, nurse, nurse2]) {
    who.token = await login(who.username);
  }
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe('OP-031 · the library', () => {
  it('refuses a regimen that puts a vinca alkaloid intrathecally', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/onco/regimens',
      token: oncologist.token,
      reason: 'Adding CHOP to the library.',
      payload: {
        code: 'BAD',
        name: 'Not a regimen',
        cycleLengthDays: 21,
        plannedCycles: 6,
        reason: 'Adding a regimen to the library.',
        drugs: [
          {
            seq: 1,
            drugName: 'Vincristine',
            drugClass: 'vinca',
            doseBasis: 'mg_m2',
            doseValue: 1.4,
            unit: 'mg',
            route: 'it',
            days: [1],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toContain('uniformly fatal');
  });

  it('takes CHOP, with the caps and the days that make it CHOP', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/onco/regimens',
      token: oncologist.token,
      reason: 'Adding CHOP to the library, verified against the protocol.',
      payload: {
        code: 'CHOP',
        name: 'Cyclophosphamide, doxorubicin, vincristine, prednisolone',
        cycleLengthDays: 21,
        plannedCycles: 6,
        labThresholds: { anc: 1.5, platelets: 100 },
        reason: 'Adding CHOP to the library, verified against the protocol.',
        drugs: [
          {
            seq: 1,
            drugName: 'Cyclophosphamide',
            drugClass: 'alkylating',
            doseBasis: 'mg_m2',
            doseValue: 750,
            unit: 'mg',
            route: 'iv',
            days: [1],
          },
          {
            seq: 2,
            drugName: 'Doxorubicin',
            drugClass: 'anthracycline',
            doseBasis: 'mg_m2',
            doseValue: 50,
            unit: 'mg',
            route: 'iv',
            days: [1],
            vesicant: true,
            cumulativeCap: 450,
            capUnit: 'mg/m²',
          },
          {
            seq: 3,
            drugName: 'Vincristine',
            drugClass: 'vinca',
            doseBasis: 'mg_m2',
            doseValue: 1.4,
            unit: 'mg',
            route: 'iv',
            days: [1],
            // The cap that exists because the arithmetic is what kills.
            absoluteCap: 2,
            vesicant: true,
          },
          {
            seq: 4,
            drugName: 'Methotrexate',
            drugClass: 'antimetabolite',
            doseBasis: 'flat',
            doseValue: 12,
            unit: 'mg',
            route: 'it',
            days: [1, 8],
          },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{ id: string; version: number; drugs: { seq: number; id: string }[] }>();
    state.regimen = body.id;
    expect(body.version).toBe(1);
    state.drugCyclo = body.drugs.find((d) => d.seq === 1)?.id ?? '';
    state.drugDoxo = body.drugs.find((d) => d.seq === 2)?.id ?? '';
    state.drugVincristine = body.drugs.find((d) => d.seq === 3)?.id ?? '';
    state.drugMethotrexate = body.drugs.find((d) => d.seq === 4)?.id ?? '';
  });

  it('keeps the library out of the pharmacist’s and the nurse’s hands', async () => {
    for (const who of [pharmacist, nurse]) {
      const res = await call({
        method: 'POST',
        url: '/api/v1/onco/regimens',
        token: who.token,
        reason: 'Adding a regimen.',
        payload: {
          code: 'X',
          name: 'X',
          cycleLengthDays: 21,
          plannedCycles: 1,
          reason: 'Adding a regimen.',
          drugs: [
            {
              seq: 1,
              drugName: 'X',
              drugClass: 'other',
              doseBasis: 'flat',
              doseValue: 1,
              unit: 'mg',
              route: 'iv',
              days: [1],
            },
          ],
        },
      });
      expect(res.statusCode, who.username).toBe(403);
    }
  });
});

describe('OP-031 · the arithmetic', () => {
  it('derives the surface area and the clearance from two measurements', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/onco/cases',
      token: oncologist.token,
      payload: {
        patientId: PATIENT,
        caseNo: 'ONC-1001',
        primarySiteIcdo3: 'C83.3',
        dxDate: '2026-08-01',
        dxBasis: 'histology',
        intent: 'curative',
        oncologistId: oncologist.userId,
        ecog: 1,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    state.caseId = created.json<{ id: string }>().id;

    const plan = await call({
      method: 'POST',
      url: '/api/v1/onco/plans',
      token: oncologist.token,
      payload: {
        caseId: state.caseId,
        regimenId: state.regimen,
        intent: 'curative',
        startDate: '2026-09-01',
        plannedCycles: 6,
        heightCm: 170,
        weightKg: 70,
        ageYears: 58,
        female: false,
        creatinineMgDl: 1.0,
      },
    });
    expect(plan.statusCode, plan.body).toBe(201);
    const body = plan.json<{ id: string; bsa: number; crcl: number }>();
    state.plan = body.id;
    // √(170 × 70 / 3600) = 1.82.
    expect(body.bsa).toBeCloseTo(1.82, 2);
    // (140 − 58) × 70 / (72 × 1.0) = 79.7.
    expect(body.crcl).toBeCloseTo(79.72, 1);
  });

  it('computes each dose, and holds vincristine at its absolute cap', async () => {
    const cycle = await call({
      method: 'POST',
      url: `/api/v1/onco/plans/${state.plan}/cycles`,
      token: oncologist.token,
      payload: {
        cycleNo: 1,
        dayNo: 1,
        scheduledAt: minutesAgo(-60),
        fitness: { ancK: 3.2, plateletsK: 240 },
      },
    });
    expect(cycle.statusCode, cycle.body).toBe(201);
    state.cycle = cycle.json<{ cycle: { id: string } }>().cycle.id;

    for (const drugId of [state.drugCyclo, state.drugDoxo, state.drugVincristine]) {
      const res = await call({
        method: 'POST',
        url: `/api/v1/onco/cycles/${state.cycle}/lines`,
        token: oncologist.token,
        payload: { regimenDrugId: drugId },
      });
      expect(res.statusCode, res.body).toBe(201);
    }

    const detailRes = await call({
      method: 'GET',
      url: `/api/v1/onco/cycles/${state.cycle}`,
      token: oncologist.token,
    });
    const lines = detailRes.json<{
      lines: { id: string; drugName: string; calcDose: number; finalDose: number; capApplied: boolean }[];
    }>().lines;

    // 750 × 1.82 = 1365.
    expect(lines.find((l) => l.drugName === 'Cyclophosphamide')?.finalDose).toBeCloseTo(1365, 0);
    // 50 × 1.82 = 91.
    const doxo = lines.find((l) => l.drugName === 'Doxorubicin');
    expect(doxo?.finalDose).toBeCloseTo(91, 0);
    state.lineDoxo = doxo?.id ?? '';
    // 1.4 × 1.82 = 2.55, held at 2 — the cap that exists because the
    // arithmetic is what kills.
    const vinc = lines.find((l) => l.drugName === 'Vincristine');
    expect(vinc?.finalDose).toBeCloseTo(2, 2);
    expect(vinc?.capApplied).toBe(true);
    state.lineVinc = vinc?.id ?? '';
  });

  it('refuses a drug on the wrong day of the protocol', async () => {
    const day8 = await call({
      method: 'POST',
      url: `/api/v1/onco/plans/${state.plan}/cycles`,
      token: oncologist.token,
      payload: { cycleNo: 1, dayNo: 8, scheduledAt: minutesAgo(-60), fitness: { ancK: 3, plateletsK: 200 } },
    });
    const id = day8.json<{ cycle: { id: string } }>().cycle.id;

    const wrongDay = await call({
      method: 'POST',
      url: `/api/v1/onco/cycles/${id}/lines`,
      token: oncologist.token,
      payload: { regimenDrugId: state.drugDoxo },
    });
    expect(wrongDay.statusCode).toBe(409);
    expect(detail(wrongDay)).toContain('day 1');

    // Methotrexate is a day 1 and day 8 drug, and it is intrathecal, and that
    // is correct and ordinary.
    const rightDay = await call({
      method: 'POST',
      url: `/api/v1/onco/cycles/${id}/lines`,
      token: oncologist.token,
      payload: { regimenDrugId: state.drugMethotrexate },
    });
    expect(rightDay.statusCode, rightDay.body).toBe(201);
    expect(rightDay.json<{ lines: { drugName: string; route: string }[] }>().lines[0]?.route).toBe('it');
  });

  it('refuses a reduction with no reason and takes one with', async () => {
    const noReason = await call({
      method: 'POST',
      url: `/api/v1/onco/cycles/${state.cycle}/lines`,
      token: oncologist.token,
      payload: { regimenDrugId: state.drugCyclo, reductionPct: 25 },
    });
    expect(noReason.statusCode).toBe(409);
    expect(detail(noReason)).toContain('reason');

    const withReason = await call({
      method: 'POST',
      url: `/api/v1/onco/cycles/${state.cycle}/lines`,
      token: oncologist.token,
      payload: {
        regimenDrugId: state.drugCyclo,
        reductionPct: 25,
        reductionReason: 'Grade 3 neutropenia after the last cycle.',
      },
    });
    expect(withReason.statusCode, withReason.body).toBe(201);
    const reduced = withReason
      .json<{ lines: { reductionPct: number; calcDose: number; finalDose: number }[] }>()
      .lines.find((l) => l.reductionPct === 25);
    expect(reduced?.finalDose).toBeCloseTo(1023.75, 1);
  });
});

describe('OP-031 · the gates', () => {
  it('refuses to sign on counts out of range, and takes a second oncologist', async () => {
    const unwell = await call({
      method: 'POST',
      url: `/api/v1/onco/cycles/${state.cycle}/sign`,
      token: oncologist.token,
      payload: { fitness: { ancK: 0.6, plateletsK: 80 } },
    });
    expect(unwell.statusCode).toBe(409);
    expect(detail(unwell)).toContain('a second oncologist takes with you');

    // The countersignature is a second person's act at a second moment. The
    // first signer cannot name their co-signer.
    const wrongPerson = await call({
      method: 'POST',
      url: `/api/v1/onco/cycles/${state.cycle}/cosign`,
      token: oncologist.token,
      reason: 'Curable disease; marrow will not recover with more delay.',
      payload: { reason: 'Curable disease; marrow will not recover with more delay.' },
    });
    expect(wrongPerson.statusCode).toBe(403);

    const cosigned = await call({
      method: 'POST',
      url: `/api/v1/onco/cycles/${state.cycle}/cosign`,
      token: second.token,
      reason: 'Curable disease; marrow will not recover with more delay.',
      payload: { reason: 'Curable disease; marrow will not recover with more delay.' },
    });
    expect(cosigned.statusCode, cosigned.body).toBe(201);

    const signed = await call({
      method: 'POST',
      url: `/api/v1/onco/cycles/${state.cycle}/sign`,
      token: oncologist.token,
      payload: { fitness: { ancK: 0.6, plateletsK: 80 } },
    });
    expect(signed.statusCode, signed.body).toBe(201);
    expect(signed.json<{ cycle: { signedAt: string | null } }>().cycle.signedAt).not.toBeNull();
  });

  it('will not run a drug pharmacy has not approved, and pharmacy can stop it', async () => {
    const early = await call({
      method: 'POST',
      url: `/api/v1/onco/cycles/${state.cycle}/administrations`,
      token: nurse.token,
      payload: { orderLineId: state.lineDoxo, verifyNurse2Id: nurse2.userId },
    });
    expect(early.statusCode).toBe(409);
    expect(detail(early)).toContain('has not been approved by pharmacy');

    // Only pharmacy holds the key. Not the prescriber, not the nurse.
    for (const who of [oncologist, nurse]) {
      const res = await call({
        method: 'POST',
        url: `/api/v1/onco/order-lines/${state.lineDoxo}/verify`,
        token: who.token,
        payload: { status: 'approved' },
      });
      expect(res.statusCode, who.username).toBe(403);
    }

    const queried = await call({
      method: 'POST',
      url: `/api/v1/onco/order-lines/${state.lineDoxo}/verify`,
      token: pharmacist.token,
      payload: { status: 'queried', notes: 'Please confirm the weight — it differs from cycle 1.' },
    });
    expect(queried.statusCode, queried.body).toBe(201);

    const stillBlocked = await call({
      method: 'POST',
      url: `/api/v1/onco/cycles/${state.cycle}/administrations`,
      token: nurse.token,
      payload: { orderLineId: state.lineDoxo, verifyNurse2Id: nurse2.userId },
    });
    expect(stillBlocked.statusCode).toBe(409);

    const approved = await call({
      method: 'POST',
      url: `/api/v1/onco/order-lines/${state.lineDoxo}/verify`,
      token: pharmacist.token,
      payload: { status: 'approved' },
    });
    expect(approved.statusCode, approved.body).toBe(201);
  });

  it('needs two nurses, and they are two people', async () => {
    const alone = await call({
      method: 'POST',
      url: `/api/v1/onco/cycles/${state.cycle}/administrations`,
      token: nurse.token,
      payload: { orderLineId: state.lineDoxo, verifyNurse2Id: nurse.userId },
    });
    expect(alone.statusCode).toBe(409);
    expect(detail(alone)).toContain('two people');

    const together = await call({
      method: 'POST',
      url: `/api/v1/onco/cycles/${state.cycle}/administrations`,
      token: nurse.token,
      payload: { orderLineId: state.lineDoxo, verifyNurse2Id: nurse2.userId, barcodeVerified: true },
    });
    expect(together.statusCode, together.body).toBe(201);
  });
});

describe('OP-031 · the lifetime', () => {
  it('adds to the lifetime total only when the drug has actually gone in', async () => {
    const before = await call({
      method: 'GET',
      url: `/api/v1/onco/cases/${state.caseId}`,
      token: oncologist.token,
    });
    expect(before.json<{ cumulative: unknown[] }>().cumulative).toEqual([]);

    const detailRes = await call({
      method: 'GET',
      url: `/api/v1/onco/cycles/${state.cycle}`,
      token: nurse.token,
    });
    const admin = detailRes
      .json<{ administrations: { id: string; drugName: string }[] }>()
      .administrations.find((a) => a.drugName === 'Doxorubicin');

    const finished = await call({
      method: 'POST',
      url: `/api/v1/onco/administrations/${admin?.id ?? ''}`,
      token: nurse.token,
      payload: { completed: true, endedAt: new Date().toISOString() },
    });
    expect(finished.statusCode, finished.body).toBe(201);

    const after = await call({
      method: 'GET',
      url: `/api/v1/onco/cases/${state.caseId}`,
      token: oncologist.token,
    });
    const doxo = after
      .json<{ cumulative: { drugName: string; totalPerM2: number; cap: number; capFraction: number }[] }>()
      .cumulative.find((c) => c.drugName === 'Doxorubicin');
    // 91 mg on 1.82 m² is 50 mg/m², out of a lifetime 450.
    expect(doxo?.totalPerM2).toBeCloseTo(50, 0);
    expect(doxo?.cap).toBeCloseTo(450, 0);
    expect(doxo?.capFraction).toBeCloseTo(0.11, 2);
  });

  it('refuses a dose that would cross the lifetime ceiling', async () => {
    // Put the running total near the ceiling the way years of treatment would.
    await pg
      .pool('migrator')
      .query(`UPDATE specialty.onco_cumulative_doses SET total_per_m2 = 430 WHERE case_id = $1`, [
        state.caseId,
      ]);

    const later = await call({
      method: 'POST',
      url: `/api/v1/onco/plans/${state.plan}/cycles`,
      token: oncologist.token,
      payload: { cycleNo: 9, dayNo: 1, scheduledAt: minutesAgo(-60), fitness: { ancK: 3, plateletsK: 200 } },
    });
    const cycleId = later.json<{ cycle: { id: string } }>().cycle.id;

    const res = await call({
      method: 'POST',
      url: `/api/v1/onco/cycles/${cycleId}/lines`,
      token: oncologist.token,
      payload: { regimenDrugId: state.drugDoxo },
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toContain('past the ceiling of 450');
    expect(detail(res)).toContain('cardiology clearance');

    // And nothing in the API can raise it: the way through is a different
    // regimen, which is a different plan.
    const flagged = await call({
      method: 'GET',
      url: '/api/v1/onco/cases?nearingCapOnly=true',
      token: oncologist.token,
    });
    expect(flagged.statusCode, flagged.body).toBe(200);
    expect(flagged.json<{ id: string }[]>().map((c) => c.id)).toContain(state.caseId);
  });
});

describe('OP-031 · toxicity, and what leaves the console', () => {
  it('derives the worst grade and what it obliges', async () => {
    const grade3 = await call({
      method: 'POST',
      url: `/api/v1/onco/cases/${state.caseId}/toxicity`,
      token: nurse.token,
      payload: {
        cycleId: state.cycle,
        items: [
          { term: 'Neutrophil count decreased', grade: 3, attribution: 'probable' },
          { term: 'Nausea', grade: 1, attribution: 'definite' },
        ],
      },
    });
    expect(grade3.statusCode, grade3.body).toBe(201);
    expect(grade3.json<{ maxGrade: number; action: string }>()).toMatchObject({
      maxGrade: 3,
      action: 'dose_reduce',
    });

    const grade4 = await call({
      method: 'POST',
      url: `/api/v1/onco/cases/${state.caseId}/toxicity`,
      token: nurse.token,
      payload: { items: [{ term: 'Febrile neutropenia', grade: 4 }] },
    });
    // Grade 4 holds the treatment rather than reducing it.
    expect(grade4.json<{ action: string }>().action).toBe('hold');
  });

  it('leaves the query, the toxicity and the extravasation on the outbox', async () => {
    const detailRes = await call({
      method: 'GET',
      url: `/api/v1/onco/cycles/${state.cycle}`,
      token: nurse.token,
    });
    const admin = detailRes.json<{ administrations: { id: string }[] }>().administrations[0];
    await call({
      method: 'POST',
      url: `/api/v1/onco/administrations/${admin?.id ?? ''}`,
      token: nurse.token,
      payload: {
        extravasation: { at: new Date().toISOString(), volumeMl: 5, antidote: 'Dexrazoxane' },
      },
    });

    const { rows } = await pg
      .pool('migrator')
      .query<{ event_type: string }>(
        `SELECT DISTINCT event_type FROM core.outbox_events WHERE event_type LIKE 'onco.%'`,
      );
    const types = rows.map((r) => r.event_type);
    for (const type of ['onco.pharmacy.queried', 'onco.toxicity.severe', 'onco.extravasation']) {
      expect(types, type).toContain(type);
    }
  });

  it('answers every filtered list', async () => {
    for (const url of [
      '/api/v1/onco/cases?activeOnly=true',
      '/api/v1/onco/cases?nearingCapOnly=true',
      '/api/v1/onco/cycles?pendingPharmacyOnly=true',
      '/api/v1/onco/regimens',
    ]) {
      const res = await call({ method: 'GET', url, token: oncologist.token });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    }
  });
});
