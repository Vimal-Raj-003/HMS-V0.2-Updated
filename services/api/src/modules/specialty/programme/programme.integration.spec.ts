import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import { HealthCheckService } from './healthcheck.service.js';
import { ImmunisationService } from './immunisation.service.js';
import { ProgrammeController } from './programme.controller.js';

/**
 * OP-013 and OP-014 against a real PostgreSQL 17.
 *
 * Both run people through a plan, and in both the characteristic failure is the
 * right thing in the wrong order:
 *
 *  1. **A dose respects its minimum age and its minimum interval**, and the
 *     refusal names the date it becomes valid — because a nurse holding a
 *     syringe needs "come back on the 14th", not a constraint name.
 *  2. **An opened vial has a clock**, its doses are counted by the database,
 *     and a batch under a cold chain hold does not move until somebody decides.
 *  3. **A dose is voided, never deleted**, and voiding puts it back on the
 *     recall list — because a record struck in error means the child is owed
 *     the dose again.
 *  4. **A health check station waits for what it depends on**, and the board
 *     says what is ready rather than offering a queue of refusals.
 *  5. **A report is not signed over a station nobody did**, and the refusal
 *     names them.
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

/** Runs the session and the slip. Cannot void a dose or decide a breach. */
const nurse = actor('prog-nurse');
/** Holds the two cold chain keys the floor does not. */
const officer = actor('prog-officer');
/** Signs the health check report. */
const physician = actor('prog-physician');

const FLOOR_KEYS = [
  'immunisation.record.read',
  'immunisation.dose.administer',
  'immunisation.plan.manage',
  'immunisation.vial.open',
  'immunisation.vial.discard',
  'immunisation.coldchain.record',
  'immunisation.aefi.report',
  'healthcheck.booking.create',
  'healthcheck.episode.read',
  'healthcheck.episode.checkin',
  'healthcheck.station.record',
];
const OFFICER_KEYS = [...FLOOR_KEYS, 'immunisation.breach.decide', 'immunisation.record.void'];
const PHYSICIAN_KEYS = [...FLOOR_KEYS, 'healthcheck.report.write', 'healthcheck.report.sign'];

const CHILD = newId();
const ADULT = newId();
const VACCINE = newId();
const SCHEDULE = newId();
const PACKAGE = newId();

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

async function seedPatient(id: string, name: string, ageDays: number): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO patient.patients
       (id, hospital_id, branch_id, uhid, uhid_normalised, first_name, full_name, gender, dob,
        mobile, mobile_local, dedupe_fingerprint, status, updated_at)
     VALUES ($1, $2, $3, $4, $4, $5, $5, 'male', (current_date - ($6::int))::date,
             '+91984500' || lpad($7, 4, '0'), '984500' || lpad($7, 4, '0'), $4, 'active', now())`,
    [
      id,
      tenants.hospitalA,
      tenants.branchA,
      `UH-${id.replace(/-/g, '').slice(-10)}`,
      name,
      ageDays,
      String(Math.abs(ageDays) % 10_000),
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

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

const appControllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as unknown[];
const alreadyWired = appControllers.includes(ProgrammeController);

@Module({
  imports: [AppModule],
  controllers: alreadyWired ? [] : [ProgrammeController],
  providers: alreadyWired ? [] : [ImmunisationService, HealthCheckService],
})
class ProgrammeTestModule {}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'PROG' });
  await syncPermissions();

  await seedActor(nurse, FLOOR_KEYS);
  await seedActor(officer, OFFICER_KEYS);
  await seedActor(physician, PHYSICIAN_KEYS);

  await seedPatient(CHILD, 'Baby Kumar', 200);
  await seedPatient(ADULT, 'Ravi Kumar', 14_600);

  // Pentavalent: three doses, from six weeks, four weeks apart.
  await pg.pool('migrator').query(
    `INSERT INTO mdm.immunisation_schedules (id, hospital_id, name, version, rules, effective_from, updated_at)
     VALUES ($1, NULL, 'NIS-TEST', 1, $2::jsonb, '2020-01-01', now())`,
    [
      SCHEDULE,
      JSON.stringify([
        { antigen: 'PENTA', doseNo: 1, minAgeDays: 42, dueAgeDays: 42 },
        { antigen: 'PENTA', doseNo: 2, minAgeDays: 70, dueAgeDays: 70, minIntervalDays: 28 },
        { antigen: 'PENTA', doseNo: 3, minAgeDays: 98, dueAgeDays: 98, minIntervalDays: 28 },
      ]),
    ],
  );
  await pg.pool('migrator').query(
    `INSERT INTO mdm.vaccines
       (id, hospital_id, antigen_code, name, doses_per_vial, dose_volume_ml, route, storage,
        open_vial_hours, live, updated_at)
     VALUES ($1, $2, 'PENTA', 'Pentavalent', 10, 0.5, 'im', 'ilr', 6, false, now())`,
    [VACCINE, tenants.hospitalA],
  );

  // A health check whose sugar waits on its breakfast.
  await pg.pool('migrator').query(
    `INSERT INTO specialty.hc_packages
       (id, hospital_id, package_id, code, name, station_sequence, updated_at)
     VALUES ($1, $2, $3, 'EXEC', 'Executive', $4::jsonb, now())`,
    [
      PACKAGE,
      tenants.hospitalA,
      newId(),
      JSON.stringify([
        { station: 'registration' },
        { station: 'vitals', dependsOn: ['registration'] },
        { station: 'phlebotomy', dependsOn: ['vitals'] },
        { station: 'breakfast', dependsOn: ['phlebotomy'] },
        { station: 'ppbs', dependsOn: ['breakfast'] },
        { station: 'physician', dependsOn: ['ppbs'] },
      ]),
    ],
  );

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(ProgrammeTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  for (const who of [nurse, officer, physician]) {
    who.token = await login(who.username);
  }
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

// ═════════════════════════════════════════════════════════════════════════════

describe('OP-013 · the interval, the vial and the cold chain', () => {
  let vialId = '';
  let doseId = '';

  it('derives a vial’s discard time from the vaccine’s own policy', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/immunisation/vials',
      token: nurse.token,
      payload: { vaccineId: VACCINE, batchNo: 'B-2026-01', expiryDate: '2027-12-31' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      id: string;
      dosesTotal: number;
      dosesUsed: number;
      minutesLeft: number;
      usable: boolean;
    }>();
    vialId = body.id;
    // Ten doses from the vaccine master, six hours from the puncture.
    expect(body.dosesTotal).toBe(10);
    expect(body.dosesUsed).toBe(0);
    expect(body.minutesLeft).toBeGreaterThan(350);
    expect(body.minutesLeft).toBeLessThanOrEqual(360);
    expect(body.usable).toBe(true);
  });

  it('gives dose 1, and counts it against the vial', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/immunisation/records',
      token: nurse.token,
      payload: {
        patientId: CHILD,
        vaccineId: VACCINE,
        antigenCode: 'PENTA',
        doseNo: 1,
        batchNo: 'B-2026-01',
        expiryDate: '2027-12-31',
        vialId,
        site: 'left_thigh',
        route: 'im',
        doseMl: 0.5,
        administeredAt: daysAgo(20),
      },
    });
    expect(res.statusCode).toBe(201);
    doseId = res.json<{ id: string }>().id;

    const vials = await call({ method: 'GET', url: '/api/v1/immunisation/vials', token: nurse.token });
    const mine = vials
      .json<{ id: string; dosesUsed: number; dosesLeft: number }[]>()
      .find((v) => v.id === vialId);
    expect(mine?.dosesUsed).toBe(1);
    expect(mine?.dosesLeft).toBe(9);
  });

  it('refuses dose 2 inside the interval, and names the date it becomes valid', async () => {
    const early = await call({
      method: 'POST',
      url: '/api/v1/immunisation/records',
      token: nurse.token,
      payload: {
        patientId: CHILD,
        vaccineId: VACCINE,
        antigenCode: 'PENTA',
        doseNo: 2,
        batchNo: 'B-2026-01',
        expiryDate: '2027-12-31',
        site: 'right_thigh',
        route: 'im',
        doseMl: 0.5,
        administeredAt: new Date().toISOString(),
      },
    });
    expect(early.statusCode).toBe(409);
    expect(detail(early)).toContain('needs 28 days');
    // The date, not a constraint name — a nurse with a syringe needs "come back
    // on the 14th".
    expect(detail(early)).toContain('becomes valid on');

    const onTime = await call({
      method: 'POST',
      url: '/api/v1/immunisation/records',
      token: nurse.token,
      payload: {
        patientId: CHILD,
        vaccineId: VACCINE,
        antigenCode: 'PENTA',
        doseNo: 2,
        batchNo: 'B-2026-01',
        expiryDate: '2027-12-31',
        site: 'right_thigh',
        route: 'im',
        doseMl: 0.5,
        administeredAt: new Date(Date.now() + 9 * 86_400_000).toISOString(),
      },
    });
    expect(onTime.statusCode).toBe(201);
  });

  it('refuses a dose below the minimum age, and names the day of eligibility', async () => {
    const newborn = newId();
    await seedPatient(newborn, 'Newborn Kumar', 20);

    const res = await call({
      method: 'POST',
      url: '/api/v1/immunisation/records',
      token: nurse.token,
      payload: {
        patientId: newborn,
        vaccineId: VACCINE,
        antigenCode: 'PENTA',
        doseNo: 1,
        batchNo: 'B-2026-01',
        expiryDate: '2027-12-31',
        site: 'left_thigh',
        route: 'im',
        doseMl: 0.5,
        administeredAt: new Date().toISOString(),
      },
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toContain('42 days of age');
    expect(detail(res)).toContain('becomes eligible on');
  });

  it('holds a batch after a cold chain breach, and releases it only on a named decision', async () => {
    const { rows: unit } = await pg.pool('migrator').query<{ id: string }>(
      `INSERT INTO specialty.cold_chain_units
         (id, hospital_id, branch_id, code, kind, location, min_c, max_c, updated_at)
       VALUES ($1, $2, $3, 'ILR-1', 'ilr', 'Immunisation room', 2, 8, now())
       RETURNING id`,
      [newId(), tenants.hospitalA, tenants.branchA],
    );

    const breach = await call({
      method: 'POST',
      url: '/api/v1/immunisation/breaches',
      token: nurse.token,
      payload: {
        unitId: unit[0]?.id,
        startedAt: daysAgo(0),
        peakC: 14.5,
        batchesAffected: ['B-2026-01'],
        note: 'Power outage overnight.',
      },
    });
    expect(breach.statusCode).toBe(201);
    expect(breach.json<{ holding: boolean }>().holding).toBe(true);
    const breachId = breach.json<{ id: string }>().id;

    const blocked = await call({
      method: 'POST',
      url: '/api/v1/immunisation/records',
      token: nurse.token,
      payload: {
        patientId: CHILD,
        vaccineId: VACCINE,
        antigenCode: 'PENTA',
        doseNo: 3,
        batchNo: 'B-2026-01',
        expiryDate: '2027-12-31',
        site: 'left_thigh',
        route: 'im',
        doseMl: 0.5,
        administeredAt: new Date(Date.now() + 40 * 86_400_000).toISOString(),
      },
    });
    expect(blocked.statusCode).toBe(409);
    expect(detail(blocked)).toContain('held after a cold chain breach');

    // The nurse who recorded the breach cannot decide it.
    const denied = await call({
      method: 'POST',
      url: `/api/v1/immunisation/breaches/${breachId}/decide`,
      token: nurse.token,
      reason: 'Data logger shows the excursion stayed under two hours.',
      payload: { action: 'released', reason: 'Data logger shows the excursion stayed under two hours.' },
    });
    expect(denied.statusCode).toBe(403);

    const released = await call({
      method: 'POST',
      url: `/api/v1/immunisation/breaches/${breachId}/decide`,
      token: officer.token,
      reason: 'Data logger shows the excursion stayed under two hours; VVM stage 1 on inspection.',
      payload: {
        action: 'released',
        reason: 'Data logger shows the excursion stayed under two hours; VVM stage 1 on inspection.',
      },
    });
    expect(released.statusCode).toBe(201);
    expect(released.json<{ holding: boolean }>().holding).toBe(false);

    const now = await call({
      method: 'POST',
      url: '/api/v1/immunisation/records',
      token: nurse.token,
      payload: {
        patientId: CHILD,
        vaccineId: VACCINE,
        antigenCode: 'PENTA',
        doseNo: 3,
        batchNo: 'B-2026-01',
        expiryDate: '2027-12-31',
        site: 'left_thigh',
        route: 'im',
        doseMl: 0.5,
        administeredAt: new Date(Date.now() + 40 * 86_400_000).toISOString(),
      },
    });
    expect(now.statusCode).toBe(201);
  });

  it('refuses a second live record of the same antigen and dose', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/immunisation/records',
      token: nurse.token,
      payload: {
        patientId: CHILD,
        vaccineId: VACCINE,
        antigenCode: 'PENTA',
        doseNo: 1,
        batchNo: 'B-2026-01',
        expiryDate: '2027-12-31',
        site: 'left_thigh',
        route: 'im',
        doseMl: 0.5,
        administeredAt: new Date().toISOString(),
      },
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toContain('double dose');
  });

  it('voids a dose rather than deleting it, and only with the key and a reason', async () => {
    const denied = await call({
      method: 'POST',
      url: `/api/v1/immunisation/records/${doseId}/void`,
      token: nurse.token,
      reason: 'Recorded against the wrong child.',
      payload: { reason: 'Recorded against the wrong child.' },
    });
    expect(denied.statusCode).toBe(403);

    const voided = await call({
      method: 'POST',
      url: `/api/v1/immunisation/records/${doseId}/void`,
      token: officer.token,
      reason: 'Recorded against the wrong child at a camp; corrected on the register.',
      payload: { reason: 'Recorded against the wrong child at a camp; corrected on the register.' },
    });
    expect(voided.statusCode).toBe(201);
    expect(voided.json<{ voided: boolean }>().voided).toBe(true);

    // The row is still there — an outbreak investigation needs to know somebody
    // once thought the dose had been given.
    const { rows } = await pg
      .pool('migrator')
      .query<{ voided: boolean; void_reason: string }>(
        `SELECT voided, void_reason FROM specialty.vaccination_records WHERE id = $1`,
        [doseId],
      );
    expect(rows[0]?.voided).toBe(true);
    expect(rows[0]?.void_reason).toContain('wrong child');

    // And `hms_app` cannot delete one at all.
    const { rows: grants } = await pg
      .pool('migrator')
      .query<{ del: boolean }>(
        `SELECT has_table_privilege('hms_app','specialty.vaccination_records','DELETE') AS del`,
      );
    expect(grants[0]?.del).toBe(false);
  });

  it('sets the statutory clock on a serious adverse event', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/immunisation/aefi',
      token: nurse.token,
      payload: {
        patientId: CHILD,
        vaccinationRecordIds: [doseId],
        onsetAt: new Date().toISOString(),
        severity: 'serious',
        symptoms: { seizure: true },
        category: 'vaccine_reaction',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ pirDueAt: string | null; cifDueAt: string | null; firOverdue: boolean }>();
    // Seven and ninety days from the report, by the programme's own clock.
    expect(body.pirDueAt).not.toBeNull();
    expect(body.cifDueAt).not.toBeNull();
    // And the first information report is showing as outstanding, which is the
    // point of the flag: twenty-four hours starts now.
    expect(body.firOverdue).toBe(true);
  });
});

describe('OP-014 · the routing slip and the report', () => {
  let episodeId = '';
  let stations: { id: string; station: string; status: string; ready: boolean; blockedBy: string[] }[] = [];

  const stationId = (name: string): string => stations.find((s) => s.station === name)?.id ?? '';

  async function refresh(): Promise<void> {
    const res = await call({
      method: 'GET',
      url: `/api/v1/healthcheck/episodes/${episodeId}`,
      token: nurse.token,
    });
    stations = res.json<{
      stations: { id: string; station: string; status: string; ready: boolean; blockedBy: string[] }[];
    }>().stations;
  }

  it('raises the routing slip from the package at check-in', async () => {
    const booking = await call({
      method: 'POST',
      url: '/api/v1/healthcheck/bookings',
      token: nurse.token,
      payload: {
        patientId: ADULT,
        packageId: PACKAGE,
        scheduledAt: new Date().toISOString(),
        channel: 'front_office',
      },
    });
    expect(booking.statusCode).toBe(201);

    const res = await call({
      method: 'POST',
      url: `/api/v1/healthcheck/bookings/${booking.json<{ id: string }>().id}/check-in`,
      token: nurse.token,
      payload: { patientId: ADULT },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      episode: { id: string; routingSlipNo: string; stationsTotal: number; reportBlockedBy: string[] };
      stations: { id: string; station: string; status: string; ready: boolean; blockedBy: string[] }[];
    }>();
    episodeId = body.episode.id;
    stations = body.stations;

    expect(body.episode.stationsTotal).toBe(6);
    expect(body.episode.routingSlipNo).toMatch(/^RS-\d{5}$/);
    // The board says what can be called next rather than offering refusals.
    expect(stations.find((s) => s.station === 'registration')?.ready).toBe(true);
    expect(stations.find((s) => s.station === 'ppbs')?.ready).toBe(false);
    expect(stations.find((s) => s.station === 'ppbs')?.blockedBy).toEqual(['breakfast']);
  });

  it('refuses a station that starts before what it depends on', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/healthcheck/stations/${stationId('ppbs')}`,
      token: nurse.token,
      payload: { status: 'in_progress' },
    });
    expect(res.statusCode).toBe(409);
    expect(detail(res)).toContain('cannot start until breakfast');
  });

  it('walks the slip in order, and skipping records a reason that goes on the report', async () => {
    for (const station of ['registration', 'vitals', 'phlebotomy']) {
      const res = await call({
        method: 'POST',
        url: `/api/v1/healthcheck/stations/${stationId(station)}`,
        token: nurse.token,
        payload: { status: 'done' },
      });
      expect(res.statusCode, station).toBe(201);
      await refresh();
    }

    const silent = await call({
      method: 'POST',
      url: `/api/v1/healthcheck/stations/${stationId('breakfast')}`,
      token: nurse.token,
      payload: { status: 'skipped' },
    });
    expect(silent.statusCode).toBe(400);

    const withReason = await call({
      method: 'POST',
      url: `/api/v1/healthcheck/stations/${stationId('breakfast')}`,
      token: nurse.token,
      payload: {
        status: 'skipped',
        skipReason: 'Patient declined the meal; post-prandial sugar deferred to the GP.',
      },
    });
    expect(withReason.statusCode).toBe(201);

    await refresh();
    // A skip resolves the dependency: a station somebody declined does not
    // block the rest of the morning, it just has to have been a decision.
    expect(stations.find((s) => s.station === 'ppbs')?.ready).toBe(true);
  });

  it('refuses a final report while a station is outstanding, and names it', async () => {
    const draft = await call({
      method: 'POST',
      url: `/api/v1/healthcheck/episodes/${episodeId}/reports`,
      token: physician.token,
      payload: { domainScores: { cardiac: 80, metabolic: 50 }, summary: 'Broadly well.' },
    });
    expect(draft.statusCode).toBe(201);
    const reportId = draft.json<{ id: string }>().id;
    // The score is the database's, weighted — with no model on this package,
    // the mean of the domains.
    expect(draft.json<{ healthScore: number }>().healthScore).toBe(65);

    const early = await call({
      method: 'POST',
      url: `/api/v1/healthcheck/reports/${reportId}/sign`,
      token: physician.token,
    });
    expect(early.statusCode).toBe(409);
    expect(detail(early)).toContain('ppbs');
    expect(detail(early)).toContain('reads as reassurance');

    // The list screen carries the same list the refusal would.
    const list = await call({
      method: 'GET',
      url: `/api/v1/healthcheck/episodes?patientId=${ADULT}&inProgressOnly=true`,
      token: nurse.token,
    });
    const mine = list.json<{ id: string; reportBlockedBy: string[] }[]>().find((e) => e.id === episodeId);
    expect(mine?.reportBlockedBy).toEqual(['ppbs', 'physician']);

    for (const station of ['ppbs', 'physician']) {
      await call({
        method: 'POST',
        url: `/api/v1/healthcheck/stations/${stationId(station)}`,
        token: nurse.token,
        payload: { status: 'done' },
      });
      await refresh();
    }

    const signed = await call({
      method: 'POST',
      url: `/api/v1/healthcheck/reports/${reportId}/sign`,
      token: physician.token,
    });
    expect(signed.statusCode).toBe(201);
    expect(signed.json<{ status: string }>().status).toBe('final');
    expect(signed.json<{ signedBy: string }>().signedBy).toBe(physician.userId);
  });

  it('never lets the floor sign the report it ran the slip for', async () => {
    const draft = await call({
      method: 'POST',
      url: `/api/v1/healthcheck/episodes/${episodeId}/reports`,
      token: physician.token,
      payload: { domainScores: { cardiac: 80 } },
    });
    const res = await call({
      method: 'POST',
      url: `/api/v1/healthcheck/reports/${draft.json<{ id: string }>().id}/sign`,
      token: nurse.token,
    });
    expect(res.statusCode).toBe(403);
  });
});
