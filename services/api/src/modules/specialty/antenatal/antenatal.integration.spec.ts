import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import { AntenatalController } from './antenatal.controller.js';
import { AntenatalService } from './antenatal.service.js';

/**
 * OP-040 against a real PostgreSQL 17.
 *
 * Two of these rules are statutes and the rest are arithmetic, and the whole
 * module is a calendar:
 *
 *  1. **The estimated date of delivery is derived**, a dating scan beats a
 *     remembered period by a tolerance that widens with gestation, and moving
 *     the date moves every appointment with it.
 *  2. **Gestational age has no field**, at booking or at a visit.
 *  3. **Anti-D is raised by the database** when Rhesus-negative is recorded,
 *     and the pregnancy cannot close while it is outstanding — because the harm
 *     lands on the next baby, not this one.
 *  4. **No table has a column for the sex of a foetus**, and the migration
 *     asserts it.
 *  5. **Form F needs a sonologist on the statutory register**, and locks.
 *  6. **The MTP gates are the Act**: one opinion, two different opinions and a
 *     named ground, or a Medical Board — and nothing substitutes for the Board.
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

/** Runs the clinic. Cannot sign, move a date, or touch either register. */
const nurse = actor('anc-nurse');
/** The obstetrician: signs, overrides the dating, and is the Act's practitioner. */
const obstetrician = actor('anc-obs');
/** A second practitioner, because two opinions means two doctors. */
const second = actor('anc-obs2');
/** Signs Form F — if the register says they may. */
const sonologist = actor('anc-sono');
/** Holds the one key that decides who may lawfully sign. */
const superintendent = actor('anc-ms');

const FLOOR_KEYS = ['obg.pregnancy.read', 'obg.visit.record', 'obg.schedule.manage', 'obg.pnc.record'];
const OBS_KEYS = [
  ...FLOOR_KEYS,
  'obg.pregnancy.register',
  'obg.pregnancy.update',
  'obg.visit.sign',
  'obg.delivery_plan.write',
  'obg.edd.override',
  'obg.mtp.record',
  'obg.mtp.read',
  'obg.report.read',
];
const SONO_KEYS = [...FLOOR_KEYS, 'pcpndt.form_f.write', 'pcpndt.form_f.sign'];
const MS_KEYS = [...OBS_KEYS, 'pcpndt.register.manage', 'pcpndt.form_f.write'];

const MOTHER_A = newId();
const MOTHER_B = newId();
const MOTHER_C = newId();

/** What the suites hand each other. */
const state = { pregnancyA: '', pregnancyB: '', visitA: '', formF: '', antiDItem: '' };

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
     VALUES ($1, $2, $3, $4, $4, $5, $5, 'female', '1998-06-14',
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

/** A date that many days before today, as `YYYY-MM-DD`. */
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const appControllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as unknown[];
const alreadyWired = appControllers.includes(AntenatalController);

@Module({
  imports: [AppModule],
  controllers: alreadyWired ? [] : [AntenatalController],
  providers: alreadyWired ? [] : [AntenatalService],
})
class AntenatalTestModule {}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'ANC' });
  await syncPermissions();

  await seedActor(nurse, FLOOR_KEYS);
  await seedActor(obstetrician, OBS_KEYS);
  await seedActor(second, OBS_KEYS);
  await seedActor(sonologist, SONO_KEYS);
  await seedActor(superintendent, MS_KEYS);

  await seedPatient(MOTHER_A, 'Lakshmi Devi');
  await seedPatient(MOTHER_B, 'Anjali Rao');
  await seedPatient(MOTHER_C, 'Priya Menon');

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(AntenatalTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();

  for (const who of [nurse, obstetrician, second, sonologist, superintendent]) {
    who.token = await login(who.username);
  }
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('OP-040 · the date everything else is arithmetic on', () => {
  it('derives the estimated date of delivery from the period, adjusted for the cycle', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/obg/pregnancies',
      token: obstetrician.token,
      payload: {
        patientId: MOTHER_A,
        ancNo: 'ANC-1001',
        lmp: daysAgo(70),
        lmpCertain: true,
        cycleDays: 28,
        gravida: 2,
        para: 1,
        living: 1,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{ id: string; workingEdd: string; eddSource: string; gaLabel: string }>();
    state.pregnancyA = body.id;
    expect(body.eddSource).toBe('lmp');
    // Ten weeks since the period.
    expect(body.gaLabel).toBe('10w0d');

    // And the schedule came with it, in weeks rather than dates.
    const detailRes = await call({
      method: 'GET',
      url: `/api/v1/obg/pregnancies/${state.pregnancyA}`,
      token: nurse.token,
    });
    const schedule = detailRes.json<{ schedule: { code: string; dueGaWeeks: number }[] }>().schedule;
    expect(schedule.map((s) => s.code)).toContain('TIFFA');
    expect(schedule.find((s) => s.code === 'TIFFA')?.dueGaWeeks).toBe(20);
  });

  it('lets an early scan beat the period, and leaves a late one alone', async () => {
    // Booked from a period, then a dating scan nine days out at eight weeks.
    // The tolerance at that gestation is five days, so the scan wins.
    const before = await call({
      method: 'GET',
      url: `/api/v1/obg/pregnancies/${state.pregnancyA}`,
      token: nurse.token,
    });
    const eddBefore = before.json<{ pregnancy: { workingEdd: string } }>().pregnancy.workingEdd;

    const res = await call({
      method: 'POST',
      url: `/api/v1/obg/pregnancies/${state.pregnancyA}`,
      token: obstetrician.token,
      payload: { usgDating: { scanDate: daysAgo(14), gaDaysAtScan: 47 } },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{ eddSource: string; workingEdd: string; eddRationale: string }>();
    expect(body.eddSource).toBe('usg');
    expect(body.workingEdd).not.toBe(eddBefore);
    expect(body.eddRationale).toContain('trusted beyond 5 days');

    // A third-trimester scan fifteen days out does not, because a femur at
    // thirty weeks does not date a pregnancy.
    const late = await call({
      method: 'POST',
      url: '/api/v1/obg/pregnancies',
      token: obstetrician.token,
      payload: {
        patientId: MOTHER_B,
        ancNo: 'ANC-1002',
        lmp: daysAgo(225),
        lmpCertain: true,
        gravida: 1,
        // Eighteen days apart, and past twenty-eight weeks the scan is trusted
        // only beyond twenty-one — because a femur at thirty weeks does not
        // date a pregnancy.
        usgDating: { scanDate: daysAgo(7), gaDaysAtScan: 200 },
      },
    });
    expect(late.statusCode, late.body).toBe(201);
    expect(late.json<{ eddSource: string }>().eddSource).toBe('lmp');
    state.pregnancyB = late.json<{ id: string }>().id;
  });

  it('moves every scheduled appointment when the date moves', async () => {
    const before = await call({
      method: 'GET',
      url: `/api/v1/obg/schedule?pregnancyId=${state.pregnancyA}`,
      token: nurse.token,
    });
    expect(before.statusCode, before.body).toBe(200);
    const tiffaBefore = before.json<{ code: string; dueAt: string }[]>().find((s) => s.code === 'TIFFA');

    const res = await call({
      method: 'POST',
      url: `/api/v1/obg/pregnancies/${state.pregnancyA}/edd`,
      token: obstetrician.token,
      reason: 'Two scans four weeks apart disagree; dated from the anomaly scan biometry.',
      payload: {
        workingEdd: new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10),
        rationale: 'Two scans four weeks apart disagree; dated from the anomaly scan biometry.',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<{ eddSource: string }>().eddSource).toBe('clinical');

    const after = await call({
      method: 'GET',
      url: `/api/v1/obg/schedule?pregnancyId=${state.pregnancyA}`,
      token: nurse.token,
    });
    const tiffaAfter = after.json<{ code: string; dueAt: string }[]>().find((s) => s.code === 'TIFFA');
    expect(tiffaAfter?.dueAt).not.toBe(tiffaBefore?.dueAt);
  });

  it('does not let the clinic floor move the date', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/obg/pregnancies/${state.pregnancyA}/edd`,
      token: nurse.token,
      reason: 'The scan sheet says otherwise.',
      payload: { workingEdd: daysAgo(-100), rationale: 'The scan sheet says otherwise.' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a booking with neither a period nor a scan, and a formula that does not add up', async () => {
    const undated = await call({
      method: 'POST',
      url: '/api/v1/obg/pregnancies',
      token: obstetrician.token,
      payload: { patientId: MOTHER_C, ancNo: 'ANC-1003', gravida: 1 },
    });
    expect(undated.statusCode).toBe(400);

    const impossible = await call({
      method: 'POST',
      url: '/api/v1/obg/pregnancies',
      token: obstetrician.token,
      payload: { patientId: MOTHER_C, ancNo: 'ANC-1004', lmp: daysAgo(60), gravida: 1, para: 2 },
    });
    expect(impossible.statusCode).toBe(400);
    expect(detail(impossible)).toContain('Gravida counts this pregnancy');
  });
});

describe('OP-040 · the visit', () => {
  it('derives the gestational age and the warning score from what was entered', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/obg/pregnancies/${state.pregnancyB}/visits`,
      token: nurse.token,
      payload: {
        bpSys: 118,
        bpDia: 74,
        pulse: 84,
        respRate: 16,
        temperatureC: 36.8,
        consciousness: 'alert',
        sfhCm: 30,
        fhr: 142,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{
      id: string;
      gaDays: number;
      gaLabel: string;
      meowsScore: number;
      meowsAction: string | null;
      sfhDeviationCm: number | null;
    }>();
    state.visitA = body.id;
    expect(body.gaDays).toBeGreaterThan(180);
    expect(body.meowsScore).toBe(0);
    expect(body.meowsAction).toBeNull();
    // Fundal height against gestation — the one measurement that finds growth
    // restriction in a clinic with no scanner.
    expect(body.sfhDeviationCm).not.toBeNull();
  });

  it('names the pathway for hypertension with proteinuria, and for severe hypertension', async () => {
    const preEclampsia = await call({
      method: 'POST',
      url: `/api/v1/obg/pregnancies/${state.pregnancyB}/visits`,
      token: nurse.token,
      payload: { bpSys: 150, bpDia: 95, urineAlbumin: '2+', pulse: 88, respRate: 18 },
    });
    expect(preEclampsia.json<{ meowsAction: string }>().meowsAction).toContain('pre-eclampsia');

    const severe = await call({
      method: 'POST',
      url: `/api/v1/obg/pregnancies/${state.pregnancyB}/visits`,
      token: nurse.token,
      payload: { bpSys: 168, bpDia: 114, pulse: 96 },
    });
    // A single parameter at two is a red on its own, whatever the total.
    expect(severe.json<{ meowsAction: string }>().meowsAction).toContain('admit today');
  });

  it('refuses to sign a visit carrying a danger sign until it has a plan', async () => {
    const created = await call({
      method: 'POST',
      url: `/api/v1/obg/pregnancies/${state.pregnancyB}/visits`,
      token: nurse.token,
      payload: { dangerSigns: ['reduced_fetal_movements'], bpSys: 120, bpDia: 78 },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<{ id: string }>().id;
    // The forward view says so before the refusal does.
    expect(created.json<{ blockedBy: string[] }>().blockedBy.join(' ')).toContain('plan');

    const refused = await call({
      method: 'POST',
      url: `/api/v1/obg/visits/${id}/sign`,
      token: obstetrician.token,
    });
    expect(refused.statusCode).toBe(400);
    expect(detail(refused)).toContain('danger sign');

    // Recording the plan is the nurse's; signing is not.
    const nurseSign = await call({
      method: 'POST',
      url: `/api/v1/obg/visits/${state.visitA}/sign`,
      token: nurse.token,
    });
    expect(nurseSign.statusCode).toBe(403);
  });

  it('leaves a danger sign on the outbox for whoever has to see her today', async () => {
    const { rows } = await pg
      .pool('migrator')
      .query<{ event_type: string }>(
        `SELECT event_type FROM core.outbox_events WHERE event_type LIKE 'obg.%' ORDER BY occurred_at`,
      );
    const types = rows.map((r) => r.event_type);
    expect(types).toContain('obg.pregnancy.registered');
    expect(types).toContain('obg.edd.changed');
    expect(types).toContain('obg.visit.danger_sign');
  });
});

describe('OP-040 · anti-D, and the child who has not been conceived', () => {
  it('raises the anti-D item by itself when Rhesus negative is recorded', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/obg/pregnancies/${state.pregnancyA}`,
      token: obstetrician.token,
      payload: { rhNegative: true, bloodGroup: 'O-' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<{ antiDStatus: string }>().antiDStatus).toMatch(/due|overdue/u);

    const schedule = await call({
      method: 'GET',
      url: `/api/v1/obg/schedule?pregnancyId=${state.pregnancyA}&kind=anti_d`,
      token: nurse.token,
    });
    const items = schedule.json<{ id: string; code: string; dueGaWeeks: number }[]>();
    expect(items.map((i) => i.code)).toContain('ANTI_D_28');
    state.antiDItem = items[0]?.id ?? '';
  });

  it('refuses to close the pregnancy while it is outstanding, and takes a reasoned waiver', async () => {
    const refused = await call({
      method: 'POST',
      url: `/api/v1/obg/pregnancies/${state.pregnancyA}`,
      token: obstetrician.token,
      payload: { status: 'delivered' },
    });
    expect(refused.statusCode).toBe(409);
    expect(detail(refused)).toContain('kill the next one');

    const noReason = await call({
      method: 'POST',
      url: `/api/v1/obg/schedule/${state.antiDItem}`,
      token: nurse.token,
      payload: { status: 'waived' },
    });
    expect(noReason.statusCode).toBe(400);

    const waived = await call({
      method: 'POST',
      url: `/api/v1/obg/schedule/${state.antiDItem}`,
      token: nurse.token,
      payload: {
        status: 'waived',
        waivedReason: 'Baby is Rhesus negative on cord blood; no prophylaxis indicated.',
      },
    });
    expect(waived.statusCode, waived.body).toBe(201);

    const closed = await call({
      method: 'POST',
      url: `/api/v1/obg/pregnancies/${state.pregnancyA}`,
      token: obstetrician.token,
      payload: { status: 'delivered' },
    });
    expect(closed.statusCode, closed.body).toBe(201);
    expect(closed.json<{ antiDStatus: string }>().antiDStatus).toBe('waived');
  });

  it('says not applicable for a Rhesus-positive woman rather than leaving it blank', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/obg/pregnancies/${state.pregnancyB}`,
      token: nurse.token,
    });
    expect(res.json<{ pregnancy: { antiDStatus: string } }>().pregnancy.antiDStatus).toBe('not_applicable');
  });
});

describe('OP-040 · PC-PNDT', () => {
  it('has no column anywhere for the sex of a foetus', async () => {
    // The migration asserts this at deployment. Asserting it again here is not
    // redundant: this is the test a reviewer reads.
    const { rows } = await pg.pool('migrator').query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.columns
        WHERE table_schema = 'specialty'
          AND table_name IN ('pregnancies','anc_visits','anc_schedule_items','delivery_plans',
                             'pcpndt_form_f','pcpndt_sonologists','mtp_cases','pnc_visits')
          AND column_name ~* '(^|_)(sex|gender)(_|$)'`,
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('refuses a signature from somebody not on the register, and takes one from somebody on it', async () => {
    const draft = await call({
      method: 'POST',
      url: '/api/v1/obg/form-f',
      token: sonologist.token,
      payload: {
        scanOrderId: newId(),
        patientId: MOTHER_B,
        pregnancyId: state.pregnancyB,
        machineId: newId(),
        centreRegNo: 'KA/BLR/2019/447',
        sonologistId: sonologist.userId,
        referringDoctor: 'Dr A Rao',
        indicationCode: 'ANOMALY',
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    state.formF = draft.json<{ id: string }>().id;
    expect(draft.json<{ sonologistRegistered: boolean }>().sonologistRegistered).toBe(false);

    const refused = await call({
      method: 'POST',
      url: `/api/v1/obg/form-f/${state.formF}/sign`,
      token: sonologist.token,
      payload: { patientAttested: true, sonologistAttested: true },
    });
    expect(refused.statusCode).toBe(409);
    expect(detail(refused)).toContain('not registered under the PC-PNDT Act');

    // Adding somebody to the register is the superintendent's, not radiology's.
    const notAllowed = await call({
      method: 'POST',
      url: '/api/v1/obg/sonologists',
      token: sonologist.token,
      reason: 'Adding myself.',
      payload: {
        userId: sonologist.userId,
        registrationNo: 'PNDT/KA/2201',
        qualification: 'MD Radiodiagnosis',
        validFrom: '2024-01-01',
        reason: 'Adding myself.',
      },
    });
    expect(notAllowed.statusCode).toBe(403);

    const registered = await call({
      method: 'POST',
      url: '/api/v1/obg/sonologists',
      token: superintendent.token,
      reason: 'Registration verified against the appropriate authority’s list on renewal.',
      payload: {
        userId: sonologist.userId,
        registrationNo: 'PNDT/KA/2201',
        qualification: 'MD Radiodiagnosis',
        validFrom: '2024-01-01',
        validTo: '2028-12-31',
        reason: 'Registration verified against the appropriate authority’s list on renewal.',
      },
    });
    expect(registered.statusCode, registered.body).toBe(201);

    const signed = await call({
      method: 'POST',
      url: `/api/v1/obg/form-f/${state.formF}/sign`,
      token: sonologist.token,
      payload: { patientAttested: true, sonologistAttested: true },
    });
    expect(signed.statusCode, signed.body).toBe(201);
    expect(signed.json<{ locked: boolean }>().locked).toBe(true);
  });

  it('will not accept a declaration that was not made, and locks what is signed', async () => {
    // The schema will not even carry a false attestation — the form's whole
    // purpose is that both were made.
    const unattested = await call({
      method: 'POST',
      url: `/api/v1/obg/form-f/${state.formF}/sign`,
      token: sonologist.token,
      payload: { patientAttested: false, sonologistAttested: true },
    });
    expect(unattested.statusCode).toBe(400);

    const edited = await call({
      method: 'POST',
      url: `/api/v1/obg/form-f/${state.formF}/sign`,
      token: sonologist.token,
      payload: { patientAttested: true, sonologistAttested: true, resultSummary: 'Amended.' },
    });
    expect(edited.statusCode).toBe(409);
    expect(detail(edited)).toContain('locked');
  });
});

describe('OP-040 · the MTP Act', () => {
  it('takes one opinion below twenty weeks and assigns the serial itself', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/obg/mtp',
      token: obstetrician.token,
      reason: 'Contraceptive failure; counselled and consented.',
      payload: {
        patientId: MOTHER_C,
        gaDaysByUsg: 112,
        opinionIds: [obstetrician.userId],
        formCConsentId: newId(),
        reason: 'Contraceptive failure; counselled and consented.',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{ mtpSerial: number; category: string; blockedBy: string[] }>();
    expect(body.mtpSerial).toBe(1);
    expect(body.category).toBe('le20');
    expect(body.blockedBy).toEqual([]);
  });

  it('needs two different practitioners and a named ground from twenty weeks', async () => {
    const one = await call({
      method: 'POST',
      url: '/api/v1/obg/mtp',
      token: obstetrician.token,
      reason: 'Foetal anomaly on the anomaly scan.',
      payload: {
        patientId: MOTHER_C,
        gaDaysByUsg: 154,
        opinionIds: [obstetrician.userId],
        grounds: 'foetal_anomaly',
        formCConsentId: newId(),
        reason: 'Foetal anomaly on the anomaly scan.',
      },
    });
    expect(one.statusCode).toBe(409);
    expect(detail(one)).toContain('two registered medical practitioners');

    const twice = await call({
      method: 'POST',
      url: '/api/v1/obg/mtp',
      token: obstetrician.token,
      reason: 'Foetal anomaly on the anomaly scan.',
      payload: {
        patientId: MOTHER_C,
        gaDaysByUsg: 154,
        opinionIds: [obstetrician.userId, obstetrician.userId],
        grounds: 'foetal_anomaly',
        formCConsentId: newId(),
        reason: 'Foetal anomaly on the anomaly scan.',
      },
    });
    expect(twice.statusCode).toBe(409);
    expect(detail(twice)).toContain('two doctors');

    const noGround = await call({
      method: 'POST',
      url: '/api/v1/obg/mtp',
      token: obstetrician.token,
      reason: 'Two opinions obtained.',
      payload: {
        patientId: MOTHER_C,
        gaDaysByUsg: 154,
        opinionIds: [obstetrician.userId, second.userId],
        formCConsentId: newId(),
        reason: 'Two opinions obtained.',
      },
    });
    expect(noGround.statusCode).toBe(409);
    expect(detail(noGround)).toContain('named grounds');

    const ok = await call({
      method: 'POST',
      url: '/api/v1/obg/mtp',
      token: obstetrician.token,
      reason: 'Foetal anomaly on the anomaly scan; two opinions obtained.',
      payload: {
        patientId: MOTHER_C,
        gaDaysByUsg: 154,
        opinionIds: [obstetrician.userId, second.userId],
        grounds: 'foetal_anomaly',
        formCConsentId: newId(),
        reason: 'Foetal anomaly on the anomaly scan; two opinions obtained.',
      },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json<{ category: string; mtpSerial: number }>()).toMatchObject({
      category: 'wk20_24',
      mtpSerial: 2,
    });
  });

  it('lets nothing substitute for a Medical Board beyond twenty-four weeks', async () => {
    const opinions = await call({
      method: 'POST',
      url: '/api/v1/obg/mtp',
      token: obstetrician.token,
      reason: 'Substantial foetal abnormality found late.',
      payload: {
        patientId: MOTHER_C,
        gaDaysByUsg: 182,
        opinionIds: [obstetrician.userId, second.userId],
        grounds: 'foetal_anomaly',
        formCConsentId: newId(),
        reason: 'Substantial foetal abnormality found late.',
      },
    });
    expect(opinions.statusCode).toBe(409);
    expect(detail(opinions)).toContain('Medical Board');

    const board = await call({
      method: 'POST',
      url: '/api/v1/obg/mtp',
      token: obstetrician.token,
      reason: 'Medical Board convened; substantial foetal abnormality.',
      payload: {
        patientId: MOTHER_C,
        gaDaysByUsg: 182,
        medicalBoardRef: 'MB/BLR/2026/17',
        formCConsentId: newId(),
        reason: 'Medical Board convened; substantial foetal abnormality.',
      },
    });
    expect(board.statusCode, board.body).toBe(201);
    expect(board.json<{ category: string }>().category).toBe('gt24_board');
  });

  it('needs a guardian for a minor, and keeps the register out of the clinic floor’s hands', async () => {
    const minor = await call({
      method: 'POST',
      url: '/api/v1/obg/mtp',
      token: obstetrician.token,
      reason: 'Minor; POCSO reporting task raised.',
      payload: {
        patientId: MOTHER_C,
        gaDaysByUsg: 98,
        opinionIds: [obstetrician.userId],
        minor: true,
        formCConsentId: newId(),
        reason: 'Minor; POCSO reporting task raised.',
      },
    });
    expect(minor.statusCode).toBe(409);
    expect(detail(minor)).toContain('guardian');

    const floorRead = await call({ method: 'GET', url: '/api/v1/obg/mtp', token: nurse.token });
    expect(floorRead.statusCode).toBe(403);

    const register = await call({ method: 'GET', url: '/api/v1/obg/mtp', token: obstetrician.token });
    expect(register.statusCode).toBe(200);
    // Gapless: the serials the register shows are 1, 2, 3 with nothing missing.
    const serials = register
      .json<{ mtpSerial: number }[]>()
      .map((m) => m.mtpSerial)
      .sort((a, b) => a - b);
    expect(serials).toEqual([1, 2, 3]);
  });
});

describe('OP-040 · the postnatal screen', () => {
  it('refers on the tenth question even when the total is under thirteen', async () => {
    const low = await call({
      method: 'POST',
      url: `/api/v1/obg/pregnancies/${state.pregnancyB}/pnc`,
      token: nurse.token,
      payload: { dayNo: 42, epdsTotal: 9, epdsItem10: 1 },
    });
    expect(low.statusCode, low.body).toBe(201);
    // The tenth question is about self-harm, which is why it is scored apart
    // from the total.
    expect(low.json<{ epdsReferral: boolean }>().epdsReferral).toBe(true);

    const clear = await call({
      method: 'POST',
      url: `/api/v1/obg/pregnancies/${state.pregnancyB}/pnc`,
      token: nurse.token,
      payload: { dayNo: 14, epdsTotal: 9, epdsItem10: 0 },
    });
    expect(clear.json<{ epdsReferral: boolean }>().epdsReferral).toBe(false);

    const high = await call({
      method: 'POST',
      url: `/api/v1/obg/pregnancies/${state.pregnancyB}/pnc`,
      token: nurse.token,
      payload: { dayNo: 7, epdsTotal: 15, epdsItem10: 0 },
    });
    expect(high.json<{ epdsReferral: boolean }>().epdsReferral).toBe(true);
  });
});
