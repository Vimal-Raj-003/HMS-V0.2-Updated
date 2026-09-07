import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import { DialysisController } from './dialysis.controller.js';
import { DialysisService } from './dialysis.service.js';

/**
 * OP-012 and IP-022 against a real PostgreSQL 17.
 *
 * The first console in the phase whose scheduling is a physical object, and the
 * five things that make a dialysis unit safe:
 *
 *  1. **The isolation zone is computed from the serology**, and a session on a
 *     machine that does not match it is refused. This is the rule the module
 *     exists for: hepatitis moving through a unit is never one patient, it is a
 *     cohort discovered months later on a routine screen.
 *  2. **One patient per machine per window**, half-open so a turnover is not a
 *     clash — and one machine per patient, so nobody is on two at once.
 *  3. **The ultrafiltration rate is derived and capped**, and the refusal names
 *     the duration that would make the same fluid safe.
 *  4. **A dialyser is counted by the database**, licensed by an integrity test
 *     and a cell volume, and a session cannot name a filter that was not
 *     logged.
 *  5. **A fistula that has not matured is not cannulated** — one of the few
 *     permanent harms in the module.
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

/** Runs the floor. Cannot declare an access active, prescribe, or re-zone. */
const tech = actor('dial-tech');
/** Adds the access and ends a session early. */
const nurse = actor('dial-nurse');
/** Writes the prescription — and with it the ultrafiltration ceiling. */
const nephrologist = actor('dial-nephro');
/** Holds the one high key: moving a machine between zones. */
const incharge = actor('dial-incharge');

const FLOOR_KEYS = [
  'dialysis.program.read',
  'dialysis.session.schedule',
  'dialysis.session.record',
  'dialysis.machine.manage',
  'dialysis.dialyser.log',
  'dialysis.dialyser.reprocess',
  'dialysis.dialyser.discard',
];
const NURSE_KEYS = [...FLOOR_KEYS, 'dialysis.access.manage', 'dialysis.session.abort'];
const DOCTOR_KEYS = [...NURSE_KEYS, 'dialysis.program.manage', 'dialysis.prescription.write'];
const INCHARGE_KEYS = [...DOCTOR_KEYS, 'dialysis.machine.rezone'];

const CLEAN = newId();
const POSITIVE = newId();

const clean = (hbsag: boolean, hcv = false, hiv = false): Record<string, unknown> => ({
  hbsag,
  hcv,
  hiv,
  testedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
});

/** What the suites hand each other. Filled as the file walks the unit. */
const machines: { general: string; hbv: string } = { general: '', hbv: '' };
const programs: { general: string; hbv: string } = { general: '', hbv: '' };
const state: { access: string; maturing: string; session: string; dialyser: string } = {
  access: '',
  maturing: '',
  session: '',
  dialyser: '',
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
     VALUES ($1, $2, $3, $4, 'Integration test role', 'dialysis-board', 'therapy', now())`,
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
     VALUES ($1, $2, $3, $4, $4, $5, $5, 'male', '1968-04-02',
             '+91984500' || lpad($6, 4, '0'), '984500' || lpad($6, 4, '0'), $4, 'active', now())`,
    [
      id,
      tenants.hospitalA,
      tenants.branchA,
      `UH-${id.replace(/-/g, '').slice(-10)}`,
      name,
      String(Math.abs(name.length * 37) % 10_000),
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

/** A slot far enough into the future that nothing else in this file uses it. */
let slotCounter = 0;
function slot(hours = 4): { scheduledAt: string; scheduledEnd: string } {
  const base = new Date('2027-03-01T02:00:00.000Z').getTime() + slotCounter++ * 6 * 3_600_000;
  return {
    scheduledAt: new Date(base).toISOString(),
    scheduledEnd: new Date(base + hours * 3_600_000).toISOString(),
  };
}

const appControllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as unknown[];
const alreadyWired = appControllers.includes(DialysisController);

@Module({
  imports: [AppModule],
  controllers: alreadyWired ? [] : [DialysisController],
  providers: alreadyWired ? [] : [DialysisService],
})
class DialysisTestModule {}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'DIAL' });
  await syncPermissions();

  await seedActor(tech, FLOOR_KEYS);
  await seedActor(nurse, NURSE_KEYS);
  await seedActor(nephrologist, DOCTOR_KEYS);
  await seedActor(incharge, INCHARGE_KEYS);

  await seedPatient(CLEAN, 'Ravi Kumar');
  await seedPatient(POSITIVE, 'Suresh Nair');

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(DialysisTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();

  for (const who of [tech, nurse, nephrologist, incharge]) {
    who.token = await login(who.username);
  }
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('OP-012 · the isolation zone', () => {
  let generalProgram = '';
  let hbvProgram = '';

  it('computes the zone from the serology and ignores anything sent alongside it', async () => {
    const a = await call({
      method: 'POST',
      url: '/api/v1/dialysis/programs',
      token: nephrologist.token,
      payload: {
        patientId: CLEAN,
        modality: 'hd',
        startDate: '2026-01-04',
        dryWeightKg: 62,
        viralStatus: clean(false),
        // Sent on purpose. There is no `isolationZone` field in the schema, so
        // this is stripped rather than honoured — which is the point.
        isolationZone: 'hbv',
      },
    });
    expect(a.statusCode).toBe(201);
    expect(a.json<{ isolationZone: string }>().isolationZone).toBe('general');
    generalProgram = a.json<{ id: string }>().id;

    const b = await call({
      method: 'POST',
      url: '/api/v1/dialysis/programs',
      token: nephrologist.token,
      payload: {
        patientId: POSITIVE,
        modality: 'hd',
        startDate: '2026-02-11',
        dryWeightKg: 71,
        viralStatus: clean(true, false, true),
      },
    });
    expect(b.statusCode).toBe(201);
    // HBV leads: a patient positive for more than one virus is nursed in the
    // strictest room they qualify for.
    expect(b.json<{ isolationZone: string }>().isolationZone).toBe('hbv');
    hbvProgram = b.json<{ id: string }>().id;
  });

  it('refuses a serology that is missing a result or a date', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/dialysis/programs',
      token: nephrologist.token,
      payload: {
        patientId: newId(),
        modality: 'hd',
        startDate: '2026-01-04',
        dryWeightKg: 62,
        viralStatus: { hbsag: false, hcv: false },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a hepatitis-positive patient on a general machine, and names both zones', async () => {
    const general = await call({
      method: 'POST',
      url: '/api/v1/dialysis/machines',
      token: incharge.token,
      payload: { code: 'GEN-01', zone: 'general', model: 'Fresenius 4008S' },
    });
    expect(general.statusCode).toBe(201);
    const hbv = await call({
      method: 'POST',
      url: '/api/v1/dialysis/machines',
      token: incharge.token,
      payload: { code: 'HBV-01', zone: 'hbv' },
    });
    expect(hbv.statusCode).toBe(201);
    machines.general = general.json<{ id: string }>().id;
    machines.hbv = hbv.json<{ id: string }>().id;

    for (const program of [generalProgram, hbvProgram]) {
      const rx = await call({
        method: 'POST',
        url: '/api/v1/dialysis/prescriptions',
        token: nephrologist.token,
        payload: {
          programId: program,
          frequencyPerWeek: 3,
          durationMin: 240,
          dialyserMaxUses: program === generalProgram ? 6 : 1,
          qb: 300,
          qd: 500,
          dialysate: { k: 2, ca: 1.25, na: 138, hco3: 32 },
          effectiveFrom: '2026-01-04',
        },
      });
      expect(rx.statusCode).toBe(201);
    }
    programs.general = generalProgram;
    programs.hbv = hbvProgram;

    const res = await call({
      method: 'POST',
      url: '/api/v1/dialysis/sessions',
      token: tech.token,
      payload: { programId: hbvProgram, machineId: machines.general, ...slot() },
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toContain('GEN-01');
    expect(detail(res)).toContain('hbv');
  });

  it('accepts the same patient on the machine in their own zone', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/dialysis/sessions',
      token: tech.token,
      payload: { programId: programs.hbv, machineId: machines.hbv, ...slot() },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ machineZone: string; patientZone: string }>()).toMatchObject({
      machineZone: 'hbv',
      patientZone: 'hbv',
    });
    // Nothing about the *zone* stands in the way. The access does — which is
    // the forward view doing its job on a booking made days ahead.
    expect(res.json<{ blockedBy: string[] }>().blockedBy.join(' ')).not.toContain('machine');
    expect(res.json<{ blockedBy: string[] }>().blockedBy).toContain('no access has been recorded');
  });

  it('releases the bookings a patient holds when their serology turns positive', async () => {
    // A zone change is not an edit: every machine they were booked on is now
    // the wrong machine, and leaving the bookings in place would be four
    // refusals discovered one at a time on the morning of the treatment.
    const held = await call({
      method: 'POST',
      url: '/api/v1/dialysis/sessions',
      token: tech.token,
      payload: { programId: programs.general, machineId: machines.general, ...slot() },
    });
    expect(held.statusCode).toBe(201);
    const sessionId = held.json<{ id: string }>().id;

    const seroconvert = await call({
      method: 'POST',
      url: `/api/v1/dialysis/programs/${programs.general}`,
      token: nephrologist.token,
      payload: { viralStatus: clean(false, true, false) },
    });
    expect(seroconvert.statusCode).toBe(201);
    expect(seroconvert.json<{ isolationZone: string }>().isolationZone).toBe('hcv');

    const after = await call({
      method: 'GET',
      url: `/api/v1/dialysis/sessions/${sessionId}`,
      token: tech.token,
    });
    expect(after.json<{ session: { machineId: string | null } }>().session.machineId).toBeNull();

    // And back, so the rest of the file works on a general-zone patient.
    const revert = await call({
      method: 'POST',
      url: `/api/v1/dialysis/programs/${programs.general}`,
      token: nephrologist.token,
      payload: { viralStatus: clean(false) },
    });
    expect(revert.json<{ isolationZone: string }>().isolationZone).toBe('general');
  });

  it('refuses to re-zone a machine that still holds a booking, and takes it once nothing does', async () => {
    const spare = await call({
      method: 'POST',
      url: '/api/v1/dialysis/machines',
      token: incharge.token,
      payload: { code: 'GEN-09', zone: 'general' },
    });
    const spareId = spare.json<{ id: string }>().id;

    const booking = await call({
      method: 'POST',
      url: '/api/v1/dialysis/sessions',
      token: tech.token,
      payload: { programId: programs.general, machineId: spareId, ...slot() },
    });
    expect(booking.statusCode).toBe(201);

    const refused = await call({
      method: 'POST',
      url: `/api/v1/dialysis/machines/${spareId}/rezone`,
      token: incharge.token,
      reason: 'Cohorting change after the June serology round.',
      payload: { zone: 'hcv', reason: 'Cohorting change after the June serology round.' },
    });
    expect(refused.statusCode).toBe(409);
    expect(detail(refused)).toContain('GEN-09');

    await call({
      method: 'POST',
      url: `/api/v1/dialysis/sessions/${booking.json<{ id: string }>().id}`,
      token: tech.token,
      payload: { status: 'cancelled' },
    });

    const ok = await call({
      method: 'POST',
      url: `/api/v1/dialysis/machines/${spareId}/rezone`,
      token: incharge.token,
      reason: 'Cohorting change after the June serology round.',
      payload: { zone: 'hcv', reason: 'Cohorting change after the June serology round.' },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json<{ zone: string }>().zone).toBe('hcv');
  });

  it('does not let the floor re-zone a machine at all', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/dialysis/machines/${machines.general}/rezone`,
      token: tech.token,
      reason: 'Two machines are down and the list is running late.',
      payload: { zone: 'hbv', reason: 'Two machines are down and the list is running late.' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('OP-012 · the machine as a physical resource', () => {
  it('refuses a second patient on one machine in an overlapping window, and allows a turnover', async () => {
    const first = slot(4);
    const booked = await call({
      method: 'POST',
      url: '/api/v1/dialysis/sessions',
      token: tech.token,
      payload: { programId: programs.general, machineId: machines.general, ...first },
    });
    expect(booked.statusCode).toBe(201);

    const overlapping = await call({
      method: 'POST',
      url: '/api/v1/dialysis/sessions',
      token: tech.token,
      payload: {
        programId: programs.general,
        machineId: machines.general,
        scheduledAt: new Date(new Date(first.scheduledAt).getTime() + 3_600_000).toISOString(),
        scheduledEnd: new Date(new Date(first.scheduledEnd).getTime() + 3_600_000).toISOString(),
      },
    });
    expect(overlapping.statusCode).toBe(409);
    expect(detail(overlapping)).toContain('four hours');

    // Half-open: starting exactly when the last one ends is a turnover.
    const turnover = await call({
      method: 'POST',
      url: '/api/v1/dialysis/sessions',
      token: tech.token,
      payload: {
        programId: programs.general,
        machineId: machines.general,
        scheduledAt: first.scheduledEnd,
        scheduledEnd: new Date(new Date(first.scheduledEnd).getTime() + 4 * 3_600_000).toISOString(),
      },
    });
    expect(turnover.statusCode).toBe(201);
    state.session = booked.json<{ id: string }>().id;
  });

  it('refuses a booking on a machine that has broken down, and says why', async () => {
    const broken = await call({
      method: 'POST',
      url: '/api/v1/dialysis/machines',
      token: incharge.token,
      payload: { code: 'GEN-99', zone: 'general' },
    });
    const brokenId = broken.json<{ id: string }>().id;
    const down = await call({
      method: 'POST',
      url: `/api/v1/dialysis/machines/${brokenId}/status`,
      token: tech.token,
      payload: { status: 'breakdown' },
    });
    expect(down.statusCode).toBe(201);

    const res = await call({
      method: 'POST',
      url: '/api/v1/dialysis/sessions',
      token: tech.token,
      payload: { programId: programs.general, machineId: brokenId, ...slot() },
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toContain('GEN-99');
    expect(detail(res)).toContain('breakdown');
  });

  it('shows the board with each machine, who is on it and who is next', async () => {
    const res = await call({ method: 'GET', url: '/api/v1/dialysis/board', token: tech.token });
    expect(res.statusCode).toBe(200);
    const rows = res.json<{ machine: { code: string; zone: string }; next: unknown }[]>();
    expect(rows.map((r) => r.machine.code)).toContain('HBV-01');
    // The zone is on the board because it is what decides who may go there.
    expect(rows.every((r) => typeof r.machine.zone === 'string')).toBe(true);
  });
});

describe('OP-012 · the needle', () => {
  it('refuses a fistula that has not matured, and takes the one that has', async () => {
    const maturing = await call({
      method: 'POST',
      url: '/api/v1/dialysis/accesses',
      token: nurse.token,
      payload: {
        programId: programs.general,
        type: 'avf',
        site: 'right brachiocephalic',
        side: 'right',
        status: 'maturing',
      },
    });
    expect(maturing.statusCode).toBe(201);
    state.maturing = maturing.json<{ id: string }>().id;

    const active = await call({
      method: 'POST',
      url: '/api/v1/dialysis/accesses',
      token: nurse.token,
      payload: {
        programId: programs.general,
        type: 'avf',
        site: 'left radiocephalic',
        side: 'left',
        status: 'active',
      },
    });
    expect(active.statusCode).toBe(201);
    state.access = active.json<{ id: string }>().id;

    const refused = await call({
      method: 'POST',
      url: `/api/v1/dialysis/sessions/${state.session}`,
      token: tech.token,
      payload: { accessId: state.maturing },
    });
    expect(refused.statusCode).toBe(409);
    expect(detail(refused)).toContain('maturing');
    expect(detail(refused)).toContain('permanently');

    const ok = await call({
      method: 'POST',
      url: `/api/v1/dialysis/sessions/${state.session}`,
      token: tech.token,
      payload: { accessId: state.access },
    });
    expect(ok.statusCode).toBe(201);
  });

  it('refuses connecting a patient with no access recorded', async () => {
    const bare = await call({
      method: 'POST',
      url: '/api/v1/dialysis/sessions',
      token: tech.token,
      payload: { programId: programs.general, machineId: machines.general, ...slot() },
    });
    const res = await call({
      method: 'POST',
      url: `/api/v1/dialysis/sessions/${bare.json<{ id: string }>().id}`,
      token: tech.token,
      payload: { status: 'on_machine' },
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toContain('access');
  });

  it('does not let the technician declare an access fit to cannulate', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/dialysis/accesses/${state.maturing}`,
      token: tech.token,
      payload: { status: 'active' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('OP-012 · the fluid', () => {
  it('derives the goal from the dry weight and the rate from the goal', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/dialysis/sessions/${state.session}`,
      token: tech.token,
      payload: { preWeightKg: 64.0 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ ufGoalL: number; ufRateMlKgH: number; suggestedUfGoalL: number }>();
    // 2.0 L over four hours on a 62 kg dry weight.
    expect(body.ufGoalL).toBeCloseTo(2.0, 2);
    expect(body.ufRateMlKgH).toBeCloseTo(8.06, 1);
    expect(body.suggestedUfGoalL).toBeCloseTo(2.0, 2);
  });

  it('refuses a goal that would take the patient below their dry weight', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/dialysis/sessions/${state.session}`,
      token: tech.token,
      payload: { ufGoalL: 4.0 },
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toContain('62');
  });

  it('accepts a deliberately smaller goal, because a hypotensive patient is pulled less on purpose', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/dialysis/sessions/${state.session}`,
      token: tech.token,
      payload: { ufGoalL: 1.2 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ ufGoalL: number }>().ufGoalL).toBeCloseTo(1.2, 2);
  });

  it('refuses a rate above the ceiling and names the duration that would work', async () => {
    // A short session with a large excess: 3.5 L off 62 kg in two hours.
    const short = slot(2);
    const created = await call({
      method: 'POST',
      url: '/api/v1/dialysis/sessions',
      token: tech.token,
      payload: { programId: programs.general, ...short },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;

    const res = await call({
      method: 'POST',
      url: `/api/v1/dialysis/sessions/${id}`,
      token: tech.token,
      payload: { preWeightKg: 65.5, ufGoalL: 3.5 },
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toContain('ml/kg/hour');
    const minutes = /run the session for (\d+) minutes/i.exec(detail(res));
    expect(minutes).not.toBeNull();

    // The duration the refusal named is one the same fluid is accepted over.
    const needed = Number(minutes?.[1] ?? 0);
    expect(needed).toBeGreaterThan(120);
    const extended = await call({
      method: 'POST',
      url: `/api/v1/dialysis/sessions/${id}`,
      token: tech.token,
      payload: { preWeightKg: 65.5, ufGoalL: 3.5 },
    });
    expect(extended.statusCode).toBe(409);

    const rebooked = await call({
      method: 'POST',
      url: '/api/v1/dialysis/sessions',
      token: tech.token,
      payload: {
        programId: programs.general,
        scheduledAt: short.scheduledAt,
        scheduledEnd: new Date(new Date(short.scheduledAt).getTime() + needed * 60_000).toISOString(),
      },
    });
    const settled = await call({
      method: 'POST',
      url: `/api/v1/dialysis/sessions/${rebooked.json<{ id: string }>().id}`,
      token: tech.token,
      payload: { preWeightKg: 65.5, ufGoalL: 3.5 },
    });
    expect(settled.statusCode).toBe(201);
    expect(settled.json<{ ufRateMlKgH: number }>().ufRateMlKgH).toBeLessThanOrEqual(13);
  });

  it('computes URR and Kt/V from the two ureas', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/dialysis/sessions/${state.session}`,
      token: tech.token,
      payload: {
        connectAt: '2027-03-01T02:05:00.000Z',
        disconnectAt: '2027-03-01T06:05:00.000Z',
        postWeightKg: 62.6,
        actualUfL: 1.2,
        adequacyLabs: { preUreaMgDl: 118, postUreaMgDl: 34 },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ urr: number; ktv: number }>();
    expect(body.urr).toBeCloseTo(71.19, 1);
    // Daugirdas second generation. Hand-computed Kt/V is wrong often enough
    // that the figure is not worth having.
    expect(body.ktv).toBeGreaterThan(1.2);
    expect(body.ktv).toBeLessThan(1.8);
  });

  it('keeps the intradialytic chart on its own session and the machine total going one way', async () => {
    const first = await call({
      method: 'POST',
      url: `/api/v1/dialysis/sessions/${state.session}/observations`,
      token: tech.token,
      payload: {
        recordedAt: '2027-03-01T03:00:00.000Z',
        systolic: 138,
        diastolic: 82,
        pulse: 76,
        ufRemovedL: 0.6,
        venousMmhg: 140,
      },
    });
    expect(first.statusCode).toBe(201);

    const backwards = await call({
      method: 'POST',
      url: `/api/v1/dialysis/sessions/${state.session}/observations`,
      token: tech.token,
      payload: { recordedAt: '2027-03-01T03:30:00.000Z', ufRemovedL: 0.4 },
    });
    expect(backwards.statusCode).toBe(409);
    expect(detail(backwards)).toContain('backwards');

    const wrongDay = await call({
      method: 'POST',
      url: `/api/v1/dialysis/sessions/${state.session}/observations`,
      token: tech.token,
      payload: { recordedAt: '2027-03-04T03:30:00.000Z', systolic: 130, diastolic: 80 },
    });
    expect(wrongDay.statusCode).toBe(409);
    expect(detail(wrongDay)).toContain('chair');

    const onwards = await call({
      method: 'POST',
      url: `/api/v1/dialysis/sessions/${state.session}/observations`,
      token: tech.token,
      payload: { recordedAt: '2027-03-01T03:30:00.000Z', ufRemovedL: 0.95 },
    });
    expect(onwards.statusCode).toBe(201);
    // Where the machine should be by now, against where it is.
    expect(typeof onwards.json<{ ufBehindL: number | null }>().ufBehindL).toBe('number');
  });
});

describe('OP-012 · the dialyser', () => {
  it('numbers a use itself and refuses a second one until the filter has been tested', async () => {
    const first = await call({
      method: 'POST',
      url: '/api/v1/dialysis/dialysers',
      token: tech.token,
      payload: { programId: programs.general, label: 'D-4471' },
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json<{ useNo: number }>().useNo).toBe(1);
    expect(first.json<{ usesRemaining: number }>().usesRemaining).toBe(5);
    // It is not licensed for another use until it has been reprocessed.
    expect(first.json<{ nextUseLicensed: boolean }>().nextUseLicensed).toBe(false);
    state.dialyser = first.json<{ id: string }>().id;

    const early = await call({
      method: 'POST',
      url: '/api/v1/dialysis/dialysers',
      token: tech.token,
      payload: { programId: programs.general, label: 'D-4471' },
    });
    expect(early.statusCode).toBe(409);
    expect(detail(early)).toContain('reprocessed');
  });

  it('refuses the next use after a failed integrity test or a low cell volume', async () => {
    const failed = await call({
      method: 'POST',
      url: `/api/v1/dialysis/dialysers/${state.dialyser}/reprocess`,
      token: tech.token,
      payload: { tcvPct: 95, integrityOk: false, chemical: 'Renalin' },
    });
    expect(failed.statusCode).toBe(201);
    expect(failed.json<{ blockedBy: string[] }>().blockedBy.join(' ')).toContain('integrity');

    const afterFailure = await call({
      method: 'POST',
      url: '/api/v1/dialysis/dialysers',
      token: tech.token,
      payload: { programId: programs.general, label: 'D-4471' },
    });
    expect(afterFailure.statusCode).toBe(409);
    expect(detail(afterFailure)).toContain('pressure hold');

    const thin = await call({
      method: 'POST',
      url: `/api/v1/dialysis/dialysers/${state.dialyser}/reprocess`,
      token: tech.token,
      payload: { tcvPct: 72, integrityOk: true },
    });
    expect(thin.statusCode).toBe(201);
    const afterThin = await call({
      method: 'POST',
      url: '/api/v1/dialysis/dialysers',
      token: tech.token,
      payload: { programId: programs.general, label: 'D-4471' },
    });
    expect(afterThin.statusCode).toBe(409);
    expect(detail(afterThin)).toContain('80');

    const good = await call({
      method: 'POST',
      url: `/api/v1/dialysis/dialysers/${state.dialyser}/reprocess`,
      token: tech.token,
      payload: { tcvPct: 93, integrityOk: true, chemical: 'Renalin' },
    });
    expect(good.json<{ nextUseLicensed: boolean }>().nextUseLicensed).toBe(true);

    const second = await call({
      method: 'POST',
      url: '/api/v1/dialysis/dialysers',
      token: tech.token,
      payload: { programId: programs.general, label: 'D-4471' },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json<{ useNo: number }>().useNo).toBe(2);
  });

  it('refuses a label already logged against another patient', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/dialysis/dialysers',
      token: tech.token,
      payload: { programId: programs.hbv, label: 'D-4471' },
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toContain('one patient');
  });

  it('refuses a second use where the prescription says single use', async () => {
    const first = await call({
      method: 'POST',
      url: '/api/v1/dialysis/dialysers',
      token: tech.token,
      payload: { programId: programs.hbv, label: 'S-0001' },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json<{ usesRemaining: number }>().usesRemaining).toBe(0);

    await call({
      method: 'POST',
      url: `/api/v1/dialysis/dialysers/${first.json<{ id: string }>().id}/reprocess`,
      token: tech.token,
      payload: { tcvPct: 98, integrityOk: true },
    });

    const second = await call({
      method: 'POST',
      url: '/api/v1/dialysis/dialysers',
      token: tech.token,
      payload: { programId: programs.hbv, label: 'S-0001' },
    });
    expect(second.statusCode).toBe(409);
    expect(detail(second)).toContain('limit of 1');
  });

  it('refuses a session naming a filter that was never logged, and takes one that was', async () => {
    const phantom = await call({
      method: 'POST',
      url: `/api/v1/dialysis/sessions/${state.session}`,
      token: tech.token,
      payload: { dialyserLabel: 'D-9999', dialyserUseNo: 1 },
    });
    expect(phantom.statusCode).toBe(409);
    expect(detail(phantom)).toContain('has not been logged');

    const real = await call({
      method: 'POST',
      url: `/api/v1/dialysis/sessions/${state.session}`,
      token: tech.token,
      payload: { dialyserLabel: 'D-4471', dialyserUseNo: 1 },
    });
    expect(real.statusCode).toBe(201);
  });

  it('stops anything further once a filter is condemned', async () => {
    const discarded = await call({
      method: 'POST',
      url: `/api/v1/dialysis/dialysers/${state.dialyser}/discard`,
      token: tech.token,
      payload: { reason: 'Fibre bundle volume 72 per cent' },
    });
    expect(discarded.statusCode).toBe(201);

    const after = await call({
      method: 'POST',
      url: '/api/v1/dialysis/dialysers',
      token: tech.token,
      payload: { programId: programs.general, label: 'D-4471' },
    });
    expect(after.statusCode).toBe(409);
  });
});

describe('OP-012 · ending the session', () => {
  it('takes an abort with a reason from a nurse and refuses one from the technician', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/dialysis/sessions',
      token: tech.token,
      payload: { programId: programs.general, ...slot() },
    });
    const id = created.json<{ id: string }>().id;

    const refused = await call({
      method: 'POST',
      url: `/api/v1/dialysis/sessions/${id}/abort`,
      token: tech.token,
      reason: 'Symptomatic hypotension at ninety minutes.',
      payload: { reason: 'Symptomatic hypotension at ninety minutes.' },
    });
    expect(refused.statusCode).toBe(403);

    const ok = await call({
      method: 'POST',
      url: `/api/v1/dialysis/sessions/${id}/abort`,
      token: nurse.token,
      reason: 'Symptomatic hypotension at ninety minutes; reinfused and disconnected.',
      payload: {
        reason: 'Symptomatic hypotension at ninety minutes; reinfused and disconnected.',
        actualUfL: 0.8,
      },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json<{ status: string }>().status).toBe('aborted');
    expect(ok.json<{ abortReason: string }>().abortReason).toContain('hypotension');
  });

  it('leaves the abort on the outbox for whoever has to move the shift', async () => {
    const { rows } = await pg
      .pool('migrator')
      .query<{ event_type: string }>(
        `SELECT event_type FROM core.outbox_events WHERE event_type LIKE 'dialysis.%' ORDER BY occurred_at`,
      );
    const types = rows.map((r) => r.event_type);
    expect(types).toContain('dialysis.session.aborted');
    expect(types).toContain('dialysis.machine.down');
    expect(types).toContain('dialysis.dialyser.condemned');
  });

  it('records the re-zoning with its reason in the audit log', async () => {
    const { rows } = await pg.pool('migrator').query<{ reason_text: string | null; action: string }>(
      `SELECT action, reason_text FROM core.audit_log
        WHERE entity = 'dialysis_machine' ORDER BY seq DESC LIMIT 1`,
    );
    expect(rows[0]?.action).toBe('override');
    expect(rows[0]?.reason_text).toContain('serology round');
  });
});
