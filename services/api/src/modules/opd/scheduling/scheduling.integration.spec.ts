import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';

/**
 * Appointments, visits and doctor schedules against a real PostgreSQL 17.
 *
 * The properties here are the ones that cannot be established by reading the
 * code:
 *
 *  1. **Concurrent double-booking is impossible.** Eight receptionists take the
 *     last place in a one-place slot at the same instant; exactly one succeeds.
 *     A sequential version of this test passes against a read-then-write
 *     implementation, which is why it is written with `Promise.all` and eight
 *     *different* patients — with one patient the same-day unique index would be
 *     doing the work and the slot lock would never be exercised.
 *  2. **Permission gating is real**: the same request 403s without the key and
 *     succeeds with it, and `schedule.configure` does not imply
 *     `schedule.publish`.
 *  3. **A cross-tenant id is 404, not 403** (`docs/09` §3.1 case 2). No query in
 *     this module carries a `hospital_id` predicate, so if isolation holds it is
 *     row-level security doing it.
 *  4. **Audit and outbox rows are written inside the mutating transaction**
 *     (EN-024 §5) — one audit row per mutated row, and the registered event.
 *  5. **Check-in creates the visit and the token atomically**: when the token
 *     cannot be issued, no visit survives.
 */

/** Root for the test app: the module under test, wired the way it ships. */
/**
 * `AppModule` declares this module's controllers and providers directly (see
 * app.module.ts), so importing the feature module here as well mounts every
 * route twice and Fastify refuses the second with FST_ERR_DUPLICATED_ROUTE --
 * the suite then fails to bootstrap at all rather than failing a test.
 */
@Module({ imports: [AppModule] })
class SchedulingTestModule {}

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

const actor = (username: string): Actor => ({
  userId: newId(),
  roleId: newId(),
  username,
  token: '',
});

/** Front-office desk in hospital A: everything OP-001 §12 gives a receptionist. */
const desk = actor('desk-alpha');
/** Same desk, plus the deliberate overbooking authority. */
const charge = actor('charge-alpha');
/** A doctor: may configure their own grid, may not publish it. */
const doctor = actor('doctor-alpha');
/** Read-only: proves the write keys are actually being checked. */
const viewer = actor('viewer-alpha');
/** The same desk role in hospital B, for the isolation checks. */
const deskB = actor('desk-bravo');

const DESK_KEYS = [
  'appointment.slot.read',
  'appointment.create',
  'appointment.list',
  'appointment.update',
  'appointment.cancel',
  'appointment.waitlist',
  'visit.create',
  'visit.list',
  'visit.update',
  'visit.cancel',
  'visit.transfer',
  'schedule.configure',
  'schedule.publish',
];
const CHARGE_KEYS = [...DESK_KEYS, 'appointment.overbook'];
const DOCTOR_KEYS = ['appointment.slot.read', 'appointment.list', 'schedule.configure'];
const VIEWER_KEYS = ['appointment.list', 'appointment.slot.read', 'visit.list'];

interface Site {
  readonly hospitalId: string;
  readonly branchId: string;
  readonly doctorKey: string;
  readonly otherDoctorKey: string;
  readonly queueId: string;
  readonly otherQueueId: string;
  readonly patients: string[];
}

let siteA: Site;
let siteB: Site;

/** Non-overlapping slot windows, so `schedule_slots_no_overlap` never fires. */
let slotWindow = 1;

// ── fixture helpers ──────────────────────────────────────────────────────────

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

async function seedActor(
  hospitalId: string,
  branchId: string,
  who: Actor,
  keys: readonly string[],
): Promise<void> {
  const pool = pg.pool('migrator');
  const hash = await argon2.hash(PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  await pool.query(
    `INSERT INTO core.roles (id, hospital_id, key, name, description, home_workspace, category, updated_at)
     VALUES ($1, $2, $3, $4, 'Scheduling integration role', 'front_office', 'clinical', now())`,
    [who.roleId, hospitalId, `role_${who.username.replace(/-/g, '_')}`, `Role ${who.username}`],
  );
  for (const key of keys) {
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
      hospitalId,
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
    [newId(), hospitalId, who.userId, who.roleId, branchId],
  );
}

/** Numbering series, doctors, queues and patients — the master data OP-001 assumes. */
async function seedSite(hospitalId: string, branchId: string, prefix: string): Promise<Site> {
  const pool = pg.pool('migrator');

  for (const key of ['APPT', 'OP_VISIT']) {
    await pool.query(
      `INSERT INTO core.numbering_series
         (id, hospital_id, branch_id, key, pattern, scope, current_value, gapless,
          reset_policy, version, effective_from, active, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'branch', 0, false, 'never', 1, now() - interval '1 day', true, now())`,
      [newId(), hospitalId, branchId, key, `${prefix}/${key === 'APPT' ? 'A' : 'V'}/{SEQ:6}`],
    );
  }

  const doctorKey = newId();
  const otherDoctorKey = newId();
  for (const [key, name] of [
    [doctorKey, 'Anand'],
    [otherDoctorKey, 'Bhaskar'],
  ] as const) {
    await pool.query(
      `INSERT INTO mdm.mdm_practitioners
         (id, record_key, hospital_id, branch_id, version, code, full_name, display_name,
          effective_from, status, updated_at)
       VALUES ($1, $2, $3, $4, 1, $5, $6, $6, now() - interval '1 day', 'active', now())`,
      [newId(), key, hospitalId, branchId, `${prefix}-${name}`, `Dr ${name}`],
    );
  }

  const queueId = newId();
  const otherQueueId = newId();
  for (const [id, key, code] of [
    [queueId, doctorKey, 'Q1'],
    [otherQueueId, otherDoctorKey, 'Q2'],
  ] as const) {
    await pool.query(
      `INSERT INTO queue.queue_definitions
         (id, hospital_id, branch_id, code, name, kind, practitioner_key, series_prefix,
          series_scope, number_width, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'doctor', $6, $7, 'per_queue', 3, now())`,
      [id, hospitalId, branchId, `${prefix}-${code}`, `${prefix} ${code}`, key, code === 'Q1' ? 'A' : 'B'],
    );
  }

  const patients: string[] = [];
  for (let i = 0; i < 140; i += 1) {
    const id = newId();
    const uhid = `${prefix}${String(i).padStart(5, '0')}`;
    await pool.query(
      `INSERT INTO patient.patients
         (id, hospital_id, branch_id, uhid, uhid_normalised, first_name, full_name, gender,
          dob, mobile, mobile_local, dedupe_fingerprint, updated_at)
       VALUES ($1, $2, $3, $4, $4, $5, $5, 'female', date '1990-05-05', $6, $7, $8, now())`,
      [
        id,
        hospitalId,
        branchId,
        uhid,
        `Patient ${uhid}`,
        `+9199${prefix.length}${String(i).padStart(6, '0')}`,
        String(i).padStart(10, '0'),
        `${prefix}-fp-${i}`,
      ],
    );
    patients.push(id);
  }

  return { hospitalId, branchId, doctorKey, otherDoctorKey, queueId, otherQueueId, patients };
}

/**
 * Creates one materialised slot directly.
 *
 * The publish path is exercised by its own test; here the fixture writes the row
 * so capacity, overbooking allowance and the exact distance from `now()` are
 * under the test's control rather than the calendar's.
 */
async function createSlot(
  site: Site,
  options: { capacity?: number; overbook?: number; doctorKey?: string; minutesFromNow?: number } = {},
): Promise<string> {
  const id = newId();
  const window = options.minutesFromNow ?? slotWindow * 20;
  slotWindow += 1;

  await pg.pool('migrator').query(
    `INSERT INTO clinical.schedule_slots
       (id, hospital_id, branch_id, practitioner_key, slot_date, slot_start, slot_end,
        capacity, overbook_allowance, status, updated_at)
     SELECT $1, $2, $3, $4,
            ((now() + make_interval(mins => $5::int)) AT TIME ZONE 'Asia/Kolkata')::date,
            now() + make_interval(mins => $5::int),
            now() + make_interval(mins => $5::int + 10),
            $6, $7, 'open', now()`,
    [
      id,
      site.hospitalId,
      site.branchId,
      options.doctorKey ?? site.doctorKey,
      window,
      options.capacity ?? 1,
      options.overbook ?? 0,
    ],
  );
  return id;
}

/**
 * Two slots that are certainly on the same Asia/Kolkata date.
 *
 * `createSlot` marches a shared counter forward twenty minutes at a time, so by
 * the middle of a suite run two consecutive slots can be hours apart — and when
 * that gap straddles 18:30 UTC they land on different Kolkata dates. The
 * one-appointment-per-patient-per-doctor-per-day rule then correctly does not
 * fire, and the test that asserts it fails for a reason that has nothing to do
 * with the rule. Anchoring both to tomorrow morning removes the clock from the
 * test entirely.
 */
async function createSameDaySlots(site: Site): Promise<readonly [string, string]> {
  const ids: [string, string] = [newId(), newId()];
  for (const [index, id] of ids.entries()) {
    await pg.pool('migrator').query(
      `INSERT INTO clinical.schedule_slots
         (id, hospital_id, branch_id, practitioner_key, slot_date, slot_start, slot_end,
          capacity, overbook_allowance, status, updated_at)
       SELECT $1, $2, $3, $4, x.d,
              (x.d + make_interval(hours => 10, mins => $5::int)) AT TIME ZONE 'Asia/Kolkata',
              (x.d + make_interval(hours => 10, mins => $5::int + 10)) AT TIME ZONE 'Asia/Kolkata',
              1, 0, 'open', now()
         FROM (SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date + 1) AS d) x`,
      [id, site.hospitalId, site.branchId, site.doctorKey, index * 20],
    );
  }
  return ids;
}

async function login(hospitalId: string, identifier: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { hospitalId, identifier, password: PASSWORD },
  });
  const body = res.json<{ accessToken?: string }>();
  if (typeof body.accessToken !== 'string') {
    throw new Error(`login failed for ${identifier}: ${res.statusCode} ${res.body}`);
  }
  return body.accessToken;
}

interface CallOptions {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  readonly url: string;
  readonly token: string;
  readonly reason?: string;
  readonly traceId?: string;
  readonly idempotencyKey?: string;
  readonly payload?: Record<string, unknown>;
}

async function call(options: CallOptions) {
  const headers: Record<string, string> = { authorization: `Bearer ${options.token}` };
  if (options.reason !== undefined) headers['x-reason'] = options.reason;
  if (options.traceId !== undefined) headers['x-trace-id'] = options.traceId;
  // Routes marked `@Idempotent()` refuse a POST with no key. A fresh key per
  // call keeps each one a distinct submission, which is what these tests mean;
  // a test about replay passes the same key twice deliberately.
  if (options.method === 'POST') {
    headers['idempotency-key'] = options.idempotencyKey ?? newId();
  } else if (options.idempotencyKey !== undefined) {
    headers['idempotency-key'] = options.idempotencyKey;
  }
  return app.inject({
    method: options.method,
    url: options.url,
    headers,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

async function auditForTrace(traceId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pg.pool('migrator').query(
    `SELECT entity, action::text AS action, row_id, business_key, actor_user_id, patient_id,
            reason_code, reason_text, before, after, data_class::text AS data_class
       FROM core.audit_log WHERE trace_id = $1 ORDER BY entity, action`,
    [traceId],
  );
  return rows as Array<Record<string, unknown>>;
}

async function outboxForTrace(traceId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pg.pool('migrator').query(
    `SELECT event_type, aggregate, aggregate_id, payload, contains_phi
       FROM core.outbox_events WHERE trace_id = $1 ORDER BY event_type`,
    [traceId],
  );
  return rows as Array<Record<string, unknown>>;
}

async function slotRow(slotId: string): Promise<{ booked_count: number; status: string }> {
  const { rows } = await pg
    .pool('migrator')
    .query(`SELECT booked_count, status::text AS status FROM clinical.schedule_slots WHERE id = $1`, [
      slotId,
    ]);
  return rows[0] as { booked_count: number; status: string };
}

let patientCursor = 0;
function nextPatient(site: Site): string {
  const id = site.patients[patientCursor % site.patients.length];
  patientCursor += 1;
  if (id === undefined) throw new Error('no patient in the fixture');
  return id;
}

// ── boot ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'SCH' });
  await syncPermissions();

  siteA = await seedSite(tenants.hospitalA, tenants.branchA, 'SCHA');
  siteB = await seedSite(tenants.hospitalB, tenants.branchB, 'SCHB');

  await seedActor(tenants.hospitalA, tenants.branchA, desk, DESK_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, charge, CHARGE_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, doctor, DOCTOR_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, viewer, VIEWER_KEYS);
  await seedActor(tenants.hospitalB, tenants.branchB, deskB, DESK_KEYS);

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(SchedulingTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  desk.token = await login(tenants.hospitalA, desk.username);
  charge.token = await login(tenants.hospitalA, charge.username);
  doctor.token = await login(tenants.hospitalA, doctor.username);
  viewer.token = await login(tenants.hospitalA, viewer.username);
  deskB.token = await login(tenants.hospitalB, deskB.username);
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

// ── doctor schedules ─────────────────────────────────────────────────────────

describe('doctor schedules', () => {
  /**
   * OP-001 §12 and `docs/05` segregation of duties: a doctor configures, a
   * branch admin publishes. If these two keys ever collapse into one, this test
   * is what notices.
   */
  it('lets a doctor save a draft grid but refuses to let them publish it', async () => {
    const saved = await call({
      method: 'PUT',
      url: `/api/v1/doctors/${siteA.otherDoctorKey}/schedule-templates`,
      token: doctor.token,
      payload: {
        effectiveFrom: '2026-01-01',
        sessions: [{ weekday: 1, startTime: '09:00', endTime: '10:00', slotMinutes: 15 }],
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<{ items: unknown[] }>().items).toHaveLength(1);

    const published = await call({
      method: 'POST',
      url: `/api/v1/doctors/${siteA.otherDoctorKey}/schedule/publish`,
      token: doctor.token,
      payload: {},
    });
    expect(published.statusCode).toBe(403);
    expect(published.headers['content-type']).toContain('application/problem+json');
  });

  it('refuses to configure a grid for a role without schedule.configure', async () => {
    const res = await call({
      method: 'PUT',
      url: `/api/v1/doctors/${siteA.otherDoctorKey}/schedule-templates`,
      token: viewer.token,
      payload: {
        effectiveFrom: '2026-01-01',
        sessions: [{ weekday: 1, startTime: '09:00', endTime: '10:00' }],
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('publishes a version, materialises the slots and emits schedule.published once', async () => {
    const traceId = newId();
    const res = await call({
      method: 'POST',
      url: `/api/v1/doctors/${siteA.otherDoctorKey}/schedule/publish`,
      token: desk.token,
      traceId,
      payload: { horizonDays: 14 },
    });
    expect(res.statusCode).toBe(201);

    const body = res.json<{ version: number; slotsCreated: number; templatesPublished: number }>();
    expect(body.version).toBe(1);
    expect(body.templatesPublished).toBe(1);
    // Two Mondays inside a 14-day horizon at worst, four slots each.
    expect(body.slotsCreated).toBeGreaterThanOrEqual(4);
    expect(body.slotsCreated % 4).toBe(0);

    const audit = await auditForTrace(traceId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      entity: 'clinical.doctor_schedule_templates',
      action: 'config_change',
      actor_user_id: desk.userId,
    });

    const events = await outboxForTrace(traceId);
    expect(events.map((e) => e.event_type)).toEqual(['schedule.published']);
    expect(events[0]?.payload).toMatchObject({ doctorId: siteA.otherDoctorKey, version: 1 });
  });

  it('refuses to publish when there is no draft', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/doctors/${siteA.otherDoctorKey}/schedule/publish`,
      token: desk.token,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  it('returns a doctor’s future slots for a date', async () => {
    const slotId = await createSlot(siteA, { minutesFromNow: 60 * 24 * 3 });
    const { rows } = await pg
      .pool('migrator')
      .query(`SELECT slot_date::text AS d FROM clinical.schedule_slots WHERE id = $1`, [slotId]);
    const date = (rows[0] as { d: string }).d;

    const res = await call({
      method: 'GET',
      url: `/api/v1/doctors/${siteA.doctorKey}/slots?date=${date}`,
      token: desk.token,
    });
    expect(res.statusCode).toBe(200);
    const items = res.json<{ items: Array<{ id: string; available: number }> }>().items;
    expect(items.map((s) => s.id)).toContain(slotId);
    expect(items.find((s) => s.id === slotId)?.available).toBe(1);
  });

  it('hides another hospital’s slots from the same route', async () => {
    const foreign = await createSlot(siteB, { minutesFromNow: 60 * 24 * 4 });
    const { rows } = await pg
      .pool('migrator')
      .query(`SELECT slot_date::text AS d FROM clinical.schedule_slots WHERE id = $1`, [foreign]);
    const date = (rows[0] as { d: string }).d;

    const res = await call({
      method: 'GET',
      url: `/api/v1/doctors/${siteB.doctorKey}/slots?date=${date}`,
      token: desk.token,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: unknown[] }>().items).toHaveLength(0);
  });
});

// ── booking ──────────────────────────────────────────────────────────────────

describe('booking', () => {
  it('refuses a booking from a role without appointment.create', async () => {
    const slotId = await createSlot(siteA);
    const res = await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: viewer.token,
      payload: { slotId, patientId: nextPatient(siteA) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('books, takes the place, and writes one audit row and one event in the same transaction', async () => {
    const slotId = await createSlot(siteA, { capacity: 2 });
    const patientId = nextPatient(siteA);
    const traceId = newId();

    const res = await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: desk.token,
      traceId,
      payload: { slotId, patientId, channel: 'counter' },
    });
    expect(res.statusCode).toBe(201);

    const appointment = res.json<{ id: string; appointment_no: string; status: string; slot_date: string }>();
    expect(appointment.status).toBe('booked');
    expect(appointment.appointment_no).toMatch(/^SCHA\/A\/\d{6}$/);
    expect(appointment.slot_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect(await slotRow(slotId)).toMatchObject({ booked_count: 1, status: 'filling' });

    const audit = await auditForTrace(traceId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      entity: 'clinical.appointments',
      action: 'insert',
      row_id: appointment.id,
      business_key: appointment.appointment_no,
      actor_user_id: desk.userId,
      patient_id: patientId,
      data_class: 'phi',
    });

    const events = await outboxForTrace(traceId);
    expect(events.map((e) => e.event_type)).toEqual(['appointment.booked']);
    expect(events[0]).toMatchObject({ aggregate: 'appointment', contains_phi: true });
    expect(events[0]?.payload).toMatchObject({
      appointmentId: appointment.id,
      patientId,
      doctorId: siteA.doctorKey,
      channel: 'counter',
    });
  });

  it('records the status transition history', async () => {
    const slotId = await createSlot(siteA);
    const res = await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: desk.token,
      payload: { slotId, patientId: nextPatient(siteA) },
    });
    const id = res.json<{ id: string }>().id;
    const { rows } = await pg.pool('migrator').query(
      `SELECT from_status, to_status::text AS to_status FROM clinical.appointment_status_history
          WHERE appointment_id = $1`,
      [id],
    );
    expect(rows).toEqual([{ from_status: null, to_status: 'booked' }]);
  });

  it('returns 404 — not 403 — for another hospital’s slot, and leaves it untouched', async () => {
    const foreignSlot = await createSlot(siteB);
    const res = await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: desk.token,
      payload: { slotId: foreignSlot, patientId: nextPatient(siteA) },
    });
    expect(res.statusCode).toBe(404);

    const ghost = await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: desk.token,
      payload: { slotId: newId(), patientId: nextPatient(siteA) },
    });
    // Indistinguishable from an id that exists nowhere: no existence oracle.
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json<{ detail: string }>().detail).toBe(res.json<{ detail: string }>().detail);
    expect(await slotRow(foreignSlot)).toMatchObject({ booked_count: 0 });
  });

  it('blocks a second live appointment for the same patient, doctor and day (OP-001 §5)', async () => {
    const [first, second] = await createSameDaySlots(siteA);
    const patientId = nextPatient(siteA);

    const a = await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: desk.token,
      payload: { slotId: first, patientId },
    });
    expect(a.statusCode).toBe(201);

    const b = await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: desk.token,
      payload: { slotId: second, patientId },
    });
    expect(b.statusCode).toBe(422);
    expect(b.json<{ detail: string }>().detail).toContain('already has appointment');
    expect(await slotRow(second)).toMatchObject({ booked_count: 0 });
  });

  it('refuses a slot that has already started', async () => {
    const past = await createSlot(siteA, { minutesFromNow: -60 });
    const res = await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: desk.token,
      payload: { slotId: past, patientId: nextPatient(siteA) },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: string }>().detail).toContain('in the past');
  });

  it('returns the same appointment for a retried Idempotency-Key', async () => {
    const slotId = await createSlot(siteA, { capacity: 2 });
    const patientId = nextPatient(siteA);
    const key = `idem-${newId()}`;

    const first = await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: desk.token,
      idempotencyKey: key,
      payload: { slotId, patientId },
    });
    const second = await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: desk.token,
      idempotencyKey: key,
      payload: { slotId, patientId },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    expect(await slotRow(slotId)).toMatchObject({ booked_count: 1 });
  });
});

// ── overbooking ──────────────────────────────────────────────────────────────

describe('overbooking', () => {
  it('refuses a full slot rather than silently exceeding it', async () => {
    const slotId = await createSlot(siteA, { capacity: 1, overbook: 1 });
    const first = await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: desk.token,
      payload: { slotId, patientId: nextPatient(siteA) },
    });
    expect(first.statusCode).toBe(201);

    const second = await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: desk.token,
      payload: { slotId, patientId: nextPatient(siteA) },
    });
    expect(second.statusCode).toBe(422);
    expect(await slotRow(slotId)).toMatchObject({ booked_count: 1 });
  });

  it('refuses a deliberate overbooking from a role without appointment.overbook', async () => {
    const slotId = await createSlot(siteA, { capacity: 1, overbook: 1 });
    await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: desk.token,
      payload: { slotId, patientId: nextPatient(siteA) },
    });

    const res = await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: desk.token,
      reason: 'Consultant agreed to see one more',
      payload: { slotId, patientId: nextPatient(siteA), overbook: true },
    });
    expect(res.statusCode).toBe(403);
    expect(await slotRow(slotId)).toMatchObject({ booked_count: 1 });
  });

  it('refuses an overbooking without a reason, even with the permission', async () => {
    const slotId = await createSlot(siteA, { capacity: 1, overbook: 1 });
    await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: charge.token,
      payload: { slotId, patientId: nextPatient(siteA) },
    });

    const res = await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: charge.token,
      payload: { slotId, patientId: nextPatient(siteA), overbook: true },
    });
    expect(res.statusCode).toBe(403);
  });

  /** An overbooking is *recorded* as one, with its approver — never absorbed. */
  it('records an authorised overbooking with the approver, and still stops at the allowance', async () => {
    const slotId = await createSlot(siteA, { capacity: 1, overbook: 1 });
    await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: charge.token,
      payload: { slotId, patientId: nextPatient(siteA) },
    });

    const forced = await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: charge.token,
      reason: 'Consultant agreed to see one more',
      payload: { slotId, patientId: nextPatient(siteA), overbook: true },
    });
    expect(forced.statusCode).toBe(201);
    expect(forced.json<{ is_overbooked: boolean }>().is_overbooked).toBe(true);

    const { rows } = await pg
      .pool('migrator')
      .query(`SELECT overbook_approved_by FROM clinical.appointments WHERE id = $1`, [
        forced.json<{ id: string }>().id,
      ]);
    expect(rows[0]).toMatchObject({ overbook_approved_by: charge.userId });
    expect(await slotRow(slotId)).toMatchObject({ booked_count: 2, status: 'full' });

    // The allowance is a ceiling, not a bypass: a third booking fails even with
    // the permission and a reason.
    const third = await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: charge.token,
      reason: 'And one more',
      payload: { slotId, patientId: nextPatient(siteA), overbook: true },
    });
    expect(third.statusCode).toBe(422);
    expect(await slotRow(slotId)).toMatchObject({ booked_count: 2 });
  });
});

// ── concurrency ──────────────────────────────────────────────────────────────

describe('concurrent booking', () => {
  /**
   * The property the whole booking design exists for.
   *
   * Eight requests for one place, issued together, with eight different
   * patients — so the same-patient-same-day unique index cannot be what saves
   * us. Exactly one appointment exists afterwards and the counter reads one.
   */
  it('lets exactly one of eight simultaneous bookings take the last place', async () => {
    const slotId = await createSlot(siteA, { capacity: 1 });
    const contenders = Array.from({ length: 8 }, () => nextPatient(siteA));

    const results = await Promise.all(
      contenders.map(async (patientId) =>
        call({
          method: 'POST',
          url: '/api/v1/appointments',
          token: desk.token,
          payload: { slotId, patientId },
        }),
      ),
    );

    const created = results.filter((r) => r.statusCode === 201);
    const refused = results.filter((r) => r.statusCode !== 201);

    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(7);
    // Every loser gets a real refusal, not a 500.
    expect(refused.every((r) => r.statusCode === 422)).toBe(true);

    expect(await slotRow(slotId)).toMatchObject({ booked_count: 1, status: 'full' });

    const { rows } = await pg.pool('migrator').query(
      `SELECT count(*)::int AS n FROM clinical.appointments
          WHERE slot_id = $1 AND status IN ('booked','confirmed','checked_in')`,
      [slotId],
    );
    expect(rows[0]).toMatchObject({ n: 1 });
  }, 120_000);

  /**
   * The case that the row lock, and only the row lock, prevents.
   *
   * A slot with one place and an overbooking allowance of two. Three
   * receptionists — none of whom holds `appointment.overbook` — book it at the
   * same instant.
   *
   * With `SELECT … FOR UPDATE`, each request reads `booked_count` *after* the
   * previous one committed, so the second and third see the slot at capacity and
   * are refused. Take the `FOR UPDATE` away and all three read `booked_count =
   * 0`, all three conclude they are booking within capacity, and all three
   * `UPDATE … booked_count + 1` succeed — because 1, 2 and 3 are all inside
   * `capacity + overbook_allowance`, so the CHECK constraint has nothing to say.
   * The result is three patients in a one-place clinic, overbooked twice, with
   * nobody holding the permission that decision requires and no `is_overbooked`
   * flag on any of the rows.
   *
   * This is the test that goes red when the lock is removed; the capacity CHECK
   * alone does not catch it, which is exactly why the lock is not optional.
   */
  it('never lets a stale read consume the overbooking allowance without the permission', async () => {
    const slotId = await createSlot(siteA, { capacity: 1, overbook: 2 });
    const contenders = Array.from({ length: 3 }, () => nextPatient(siteA));

    const results = await Promise.all(
      contenders.map(async (patientId) =>
        call({
          method: 'POST',
          url: '/api/v1/appointments',
          token: desk.token,
          payload: { slotId, patientId },
        }),
      ),
    );

    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(await slotRow(slotId)).toMatchObject({ booked_count: 1 });

    const { rows } = await pg.pool('migrator').query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE is_overbooked)::int AS forced
         FROM clinical.appointments
        WHERE slot_id = $1 AND status IN ('booked','confirmed','checked_in')`,
      [slotId],
    );
    expect(rows[0]).toMatchObject({ n: 1, forced: 0 });
  }, 120_000);

  /** The same race, on a slot that holds three: three winners and no more. */
  it('lets exactly three of eight simultaneous bookings into a three-place slot', async () => {
    const slotId = await createSlot(siteA, { capacity: 3 });
    const contenders = Array.from({ length: 8 }, () => nextPatient(siteA));

    const results = await Promise.all(
      contenders.map(async (patientId) =>
        call({
          method: 'POST',
          url: '/api/v1/appointments',
          token: desk.token,
          payload: { slotId, patientId },
        }),
      ),
    );

    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(3);
    expect(await slotRow(slotId)).toMatchObject({ booked_count: 3, status: 'full' });
  }, 120_000);
});

// ── lifecycle ────────────────────────────────────────────────────────────────

describe('appointment lifecycle', () => {
  async function book(options: { capacity?: number } = {}): Promise<{ id: string; slotId: string }> {
    const slotId = await createSlot(siteA, options);
    const res = await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: desk.token,
      payload: { slotId, patientId: nextPatient(siteA) },
    });
    expect(res.statusCode).toBe(201);
    return { id: res.json<{ id: string }>().id, slotId };
  }

  it('confirms a booking and emits appointment.confirmed once', async () => {
    const { id } = await book();
    const traceId = newId();

    const res = await call({
      method: 'PATCH',
      url: `/api/v1/appointments/${id}/confirm`,
      token: desk.token,
      traceId,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('confirmed');

    expect(await auditForTrace(traceId)).toHaveLength(1);
    const events = await outboxForTrace(traceId);
    expect(events.map((e) => e.event_type)).toEqual(['appointment.confirmed']);
    expect(events[0]?.payload).toMatchObject({ appointmentId: id });
  });

  it('reschedules onto a new slot, keeps the old row and links the two', async () => {
    const { id, slotId } = await book();
    const target = await createSlot(siteA);
    const traceId = newId();

    const res = await call({
      method: 'PATCH',
      url: `/api/v1/appointments/${id}/reschedule`,
      token: desk.token,
      traceId,
      payload: { slotId: target, note: 'Patient asked for a later time' },
    });
    expect(res.statusCode).toBe(200);

    const replacement = res.json<{ id: string; rescheduled_from_id: string; status: string }>();
    expect(replacement.status).toBe('booked');
    expect(replacement.rescheduled_from_id).toBe(id);

    // The place moved: old slot released, new slot taken.
    expect(await slotRow(slotId)).toMatchObject({ booked_count: 0, status: 'open' });
    expect(await slotRow(target)).toMatchObject({ booked_count: 1 });

    const old = await call({ method: 'GET', url: `/api/v1/appointments/${id}`, token: desk.token });
    expect(old.json<{ status: string; rescheduled_to_id: string }>()).toMatchObject({
      status: 'rescheduled',
      rescheduled_to_id: replacement.id,
    });

    // One audit row per mutated row: the old appointment and the new one.
    const audit = await auditForTrace(traceId);
    expect(audit).toHaveLength(2);
    expect(audit.map((a) => a.action).sort()).toEqual(['insert', 'update']);

    const events = await outboxForTrace(traceId);
    expect(events.map((e) => e.event_type)).toEqual(['appointment.rescheduled']);
    expect(events[0]?.payload).toMatchObject({
      appointmentId: replacement.id,
      previousAppointmentId: id,
    });
  });

  it('refuses a cancellation with no reason header, because the refund policy needs one', async () => {
    const { id } = await book();
    const res = await call({
      method: 'PATCH',
      url: `/api/v1/appointments/${id}/cancel`,
      token: desk.token,
      payload: { reason: 'patient_request', cancelledBy: 'patient' },
    });
    expect(res.statusCode).toBe(403);
  });

  /**
   * OP-001 §5: "refund … 100 % if cancelled ≥ 24 h, else 0, always full if the
   * hospital cancels". OP-005 cannot compute that from an appointment id, so the
   * reason and the party are in the event itself.
   */
  it('cancels with the reason and the cancelling party in the event, and releases the place', async () => {
    const { id, slotId } = await book();
    const traceId = newId();

    const res = await call({
      method: 'PATCH',
      url: `/api/v1/appointments/${id}/cancel`,
      token: desk.token,
      traceId,
      reason: 'Doctor called to theatre',
      payload: { reason: 'doctor_unavailable', cancelledBy: 'hospital', note: 'Emergency list' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string; cancel_reason: string }>()).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'doctor_unavailable',
    });
    expect(await slotRow(slotId)).toMatchObject({ booked_count: 0, status: 'open' });

    const audit = await auditForTrace(traceId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ reason_code: 'doctor_unavailable', actor_user_id: desk.userId });

    const events = await outboxForTrace(traceId);
    expect(events.map((e) => e.event_type)).toEqual(['appointment.cancelled']);
    expect(events[0]?.payload).toMatchObject({
      appointmentId: id,
      cancelledBy: 'hospital',
      reason: 'doctor_unavailable: Emergency list',
    });
  });

  it('lets the released place be taken again', async () => {
    const { id, slotId } = await book();
    await call({
      method: 'PATCH',
      url: `/api/v1/appointments/${id}/cancel`,
      token: desk.token,
      reason: 'Patient rang to cancel',
      payload: { reason: 'patient_request', cancelledBy: 'patient' },
    });

    const rebook = await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: desk.token,
      payload: { slotId, patientId: nextPatient(siteA) },
    });
    expect(rebook.statusCode).toBe(201);
  });

  it('refuses to cancel twice', async () => {
    const { id } = await book();
    const payload = { reason: 'patient_request', cancelledBy: 'patient' };
    const first = await call({
      method: 'PATCH',
      url: `/api/v1/appointments/${id}/cancel`,
      token: desk.token,
      reason: 'Patient rang',
      payload,
    });
    expect(first.statusCode).toBe(200);

    const again = await call({
      method: 'PATCH',
      url: `/api/v1/appointments/${id}/cancel`,
      token: desk.token,
      reason: 'Patient rang',
      payload,
    });
    expect(again.statusCode).toBe(409);
  });

  it('pages the day list on a signed cursor without overlap', async () => {
    const res = await call({
      method: 'GET',
      url: `/api/v1/appointments?doctor=${siteA.doctorKey}&limit=3`,
      token: desk.token,
    });
    expect(res.statusCode).toBe(200);
    const page = res.json<{ items: Array<{ id: string }>; nextCursor: string | null; hasMore: boolean }>();
    expect(page.items.length).toBeLessThanOrEqual(3);
    expect(page).not.toHaveProperty('total');

    if (page.nextCursor !== null) {
      const next = await call({
        method: 'GET',
        url: `/api/v1/appointments?doctor=${siteA.doctorKey}&limit=3&cursor=${encodeURIComponent(page.nextCursor)}`,
        token: desk.token,
      });
      expect(next.statusCode).toBe(200);
      const second = next.json<{ items: Array<{ id: string }> }>();
      const overlap = second.items.filter((i) => page.items.some((f) => f.id === i.id));
      expect(overlap).toHaveLength(0);
    }
  });

  it('never lists another hospital’s appointments', async () => {
    const foreignSlot = await createSlot(siteB, { minutesFromNow: 60 * 24 * 5 });
    const booked = await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: deskB.token,
      payload: { slotId: foreignSlot, patientId: nextPatient(siteB) },
    });
    expect(booked.statusCode).toBe(201);
    const foreignId = booked.json<{ id: string }>().id;

    const list = await call({ method: 'GET', url: '/api/v1/appointments?limit=100', token: desk.token });
    expect(list.json<{ items: Array<{ id: string }> }>().items.map((i) => i.id)).not.toContain(foreignId);

    const direct = await call({
      method: 'GET',
      url: `/api/v1/appointments/${foreignId}`,
      token: desk.token,
    });
    expect(direct.statusCode).toBe(404);
  });
});

// ── check-in, visits and tokens ──────────────────────────────────────────────

describe('check-in', () => {
  /**
   * Check-in slots must sit inside the early-arrival tolerance, so they cannot
   * use the shared far-future windows; 15-minute steps keep the ten-minute
   * slots from overlapping (`schedule_slots_no_overlap`).
   */
  let checkInWindow = 15;

  async function bookForCheckIn(): Promise<{ id: string; patientId: string; slotId: string }> {
    const slotId = await createSlot(siteA, { minutesFromNow: checkInWindow });
    checkInWindow += 15;
    const patientId = nextPatient(siteA);
    const res = await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: desk.token,
      payload: { slotId, patientId },
    });
    expect(res.statusCode).toBe(201);
    return { id: res.json<{ id: string }>().id, patientId, slotId };
  }

  it('creates the visit and the token in one transaction', async () => {
    const { id, patientId } = await bookForCheckIn();
    const traceId = newId();

    const res = await call({
      method: 'POST',
      url: `/api/v1/appointments/${id}/check-in`,
      token: desk.token,
      traceId,
      payload: { payerType: 'self', sourceChannel: 'counter' },
    });
    expect(res.statusCode).toBe(201);

    const result = res.json<{ visitId: string; visitNo: string; tokenDisplay: string; queueId: string }>();
    expect(result.visitNo).toMatch(/^SCHA\/V\/\d{6}$/);
    expect(result.tokenDisplay).toMatch(/^A\d{3}$/);
    expect(result.queueId).toBe(siteA.queueId);

    const { rows } = await pg.pool('migrator').query(
      `SELECT v.status::text AS visit_status, v.token_id, v.token_display, v.queue_id,
              t.id AS token_row, t.status::text AS token_status, t.patient_id AS token_patient,
              t.class::text AS token_class, t.priority_rank
         FROM clinical.op_visits v
         JOIN queue.queue_tokens t ON t.id = v.token_id
        WHERE v.id = $1`,
      [result.visitId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      visit_status: 'waiting_doctor',
      token_status: 'waiting',
      token_patient: patientId,
      // An appointment token outranks a walk-in (OP-001 §5).
      token_class: 'appointment',
      priority_rank: 50,
    });

    const appointment = await call({
      method: 'GET',
      url: `/api/v1/appointments/${id}`,
      token: desk.token,
    });
    expect(appointment.json<{ status: string; visit_id: string }>()).toMatchObject({
      status: 'checked_in',
      visit_id: result.visitId,
    });

    // One audit row per mutated row — the appointment and the new visit — and
    // both domain events, all on the one transaction.
    const audit = await auditForTrace(traceId);
    expect(audit.map((a) => `${String(a.entity)}:${String(a.action)}`).sort()).toEqual([
      'clinical.appointments:update',
      'clinical.op_visits:insert',
    ]);

    const events = await outboxForTrace(traceId);
    expect(events.map((e) => e.event_type)).toEqual(['queue.token.issued', 'visit.checked_in']);
    expect(events[1]?.payload).toMatchObject({
      visitId: result.visitId,
      patientId,
      doctorId: siteA.doctorKey,
      tokenNo: result.tokenDisplay,
      branchId: siteA.branchId,
    });
  });

  /**
   * Atomicity, proved by failure. The doctor has no queue configured, so the
   * token cannot be issued — and if the visit were written on its own
   * connection, or committed before the token, a row would survive. None does.
   */
  it('leaves neither a visit nor a token behind when the token cannot be issued', async () => {
    const pool = pg.pool('migrator');
    const lonelyDoctor = newId();
    await pool.query(
      `INSERT INTO mdm.mdm_practitioners
         (id, record_key, hospital_id, branch_id, version, code, full_name, display_name,
          effective_from, status, updated_at)
       VALUES ($1, $2, $3, $4, 1, $5, 'Dr Nobody', 'Dr Nobody', now() - interval '1 day', 'active', now())`,
      [newId(), lonelyDoctor, siteA.hospitalId, siteA.branchId, `SCHA-NOQ-${Date.now()}`],
    );
    const slotId = await createSlot(siteA, { doctorKey: lonelyDoctor, minutesFromNow: 45 });
    const patientId = nextPatient(siteA);

    const booked = await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: desk.token,
      payload: { slotId, patientId },
    });
    expect(booked.statusCode).toBe(201);
    const appointmentId = booked.json<{ id: string }>().id;

    const before = await pool.query(`SELECT count(*)::int AS n FROM clinical.op_visits`);
    const traceId = newId();
    const res = await call({
      method: 'POST',
      url: `/api/v1/appointments/${appointmentId}/check-in`,
      token: desk.token,
      traceId,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: string }>().detail).toContain('No active queue');

    const after = await pool.query(`SELECT count(*)::int AS n FROM clinical.op_visits`);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(await auditForTrace(traceId)).toHaveLength(0);
    expect(await outboxForTrace(traceId)).toHaveLength(0);

    const appointment = await call({
      method: 'GET',
      url: `/api/v1/appointments/${appointmentId}`,
      token: desk.token,
    });
    expect(appointment.json<{ status: string }>().status).toBe('booked');
  });

  it('refuses a check-in far ahead of the appointment', async () => {
    const slotId = await createSlot(siteA, { minutesFromNow: 60 * 24 });
    const res = await call({
      method: 'POST',
      url: '/api/v1/appointments',
      token: desk.token,
      payload: { slotId, patientId: nextPatient(siteA) },
    });
    const id = res.json<{ id: string }>().id;

    const checkIn = await call({
      method: 'POST',
      url: `/api/v1/appointments/${id}/check-in`,
      token: desk.token,
      payload: {},
    });
    expect(checkIn.statusCode).toBe(422);
    expect(checkIn.json<{ detail: string }>().detail).toContain('minutes away');
  });

  it('refuses a check-in from a role without visit.create', async () => {
    const { id } = await bookForCheckIn();
    const res = await call({
      method: 'POST',
      url: `/api/v1/appointments/${id}/check-in`,
      token: viewer.token,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('visits', () => {
  async function walkIn(overrides: Record<string, unknown> = {}): Promise<{ id: string; patientId: string }> {
    const patientId = nextPatient(siteA);
    const res = await call({
      method: 'POST',
      url: '/api/v1/visits',
      token: desk.token,
      payload: { patientId, practitionerKey: siteA.doctorKey, ...overrides },
    });
    expect(res.statusCode).toBe(201);
    return { id: res.json<{ id: string }>().id, patientId };
  }

  it('opens a walk-in visit with its token, one audit row and both events', async () => {
    const traceId = newId();
    const patientId = nextPatient(siteA);

    const res = await call({
      method: 'POST',
      url: '/api/v1/visits',
      token: desk.token,
      traceId,
      payload: { patientId, practitionerKey: siteA.doctorKey, visitType: 'new' },
    });
    expect(res.statusCode).toBe(201);

    const visit = res.json<{ id: string; visit_no: string; token_display: string; status: string }>();
    expect(visit.visit_no).toMatch(/^SCHA\/V\/\d{6}$/);
    expect(visit.token_display).toMatch(/^A\d{3}$/);
    expect(visit.status).toBe('waiting_doctor');

    const audit = await auditForTrace(traceId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entity: 'clinical.op_visits', action: 'insert', patient_id: patientId });

    const events = await outboxForTrace(traceId);
    expect(events.map((e) => e.event_type)).toEqual(['queue.token.issued', 'visit.checked_in']);
  });

  it('refuses a walk-in from a role without visit.create', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/visits',
      token: viewer.token,
      payload: { patientId: nextPatient(siteA), practitionerKey: siteA.doctorKey },
    });
    expect(res.statusCode).toBe(403);
  });

  it('gives a walk-in a lower priority rank than an appointment', async () => {
    const { id } = await walkIn();
    const { rows } = await pg.pool('migrator').query(
      `SELECT t.priority_rank, t.class::text AS class FROM queue.queue_tokens t
           JOIN clinical.op_visits v ON v.token_id = t.id WHERE v.id = $1`,
      [id],
    );
    expect(rows[0]).toMatchObject({ priority_rank: 0, class: 'regular' });
  });

  it('cancels a visit, voids its token and emits visit.cancelled', async () => {
    const { id } = await walkIn();
    const traceId = newId();

    const res = await call({
      method: 'PATCH',
      url: `/api/v1/visits/${id}/cancel`,
      token: desk.token,
      traceId,
      reason: 'Patient left before consultation',
      payload: { reason: 'Patient left before consultation' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('cancelled');

    const { rows } = await pg.pool('migrator').query(
      `SELECT t.status::text AS status FROM queue.queue_tokens t
           JOIN clinical.op_visits v ON v.token_id = t.id WHERE v.id = $1`,
      [id],
    );
    expect(rows[0]).toMatchObject({ status: 'cancelled' });

    expect(await auditForTrace(traceId)).toHaveLength(1);
    expect((await outboxForTrace(traceId)).map((e) => e.event_type)).toEqual(['visit.cancelled']);
  });

  it('refuses to cancel a visit without a reason header', async () => {
    const { id } = await walkIn();
    const res = await call({
      method: 'PATCH',
      url: `/api/v1/visits/${id}/cancel`,
      token: desk.token,
      payload: { reason: 'Changed their mind' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses to cancel a visit whose consultation has started (OP-001 §5)', async () => {
    const { id } = await walkIn();
    await pg
      .pool('migrator')
      .query(
        `UPDATE clinical.op_visits SET consult_started_at = now(), status = 'in_consult' WHERE id = $1`,
        [id],
      );

    const res = await call({
      method: 'PATCH',
      url: `/api/v1/visits/${id}/cancel`,
      token: desk.token,
      reason: 'Tried to cancel after the consultation started',
      payload: { reason: 'Tried too late' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ detail: string }>().detail).toContain('already started');
  });

  it('transfers a visit to another doctor and reissues the token in that queue', async () => {
    const { id } = await walkIn();
    const traceId = newId();

    const res = await call({
      method: 'PATCH',
      url: `/api/v1/visits/${id}/transfer`,
      token: desk.token,
      traceId,
      reason: 'Wrong speciality at the desk',
      payload: { practitionerKey: siteA.otherDoctorKey, reason: 'Wrong speciality at the desk' },
    });
    expect(res.statusCode).toBe(200);

    const moved = res.json<{ practitioner_key: string; queue_id: string; token_display: string }>();
    expect(moved.practitioner_key).toBe(siteA.otherDoctorKey);
    expect(moved.queue_id).toBe(siteA.otherQueueId);
    expect(moved.token_display).toMatch(/^B\d{3}$/);

    expect(await auditForTrace(traceId)).toHaveLength(1);
    expect((await outboxForTrace(traceId)).map((e) => e.event_type)).toEqual([
      'queue.token.issued',
      'queue.token.transferred',
    ]);
  });

  it('closes a visit and emits visit.closed', async () => {
    const { id } = await walkIn();
    const traceId = newId();

    const res = await call({
      method: 'PATCH',
      url: `/api/v1/visits/${id}/close`,
      token: desk.token,
      traceId,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('closed');

    expect(await auditForTrace(traceId)).toHaveLength(1);
    const events = await outboxForTrace(traceId);
    expect(events.map((e) => e.event_type)).toEqual(['visit.closed']);
    expect(events[0]?.payload).toMatchObject({ visitId: id, automatic: false });
  });

  it('lists this branch’s visits and never another hospital’s', async () => {
    const { id } = await walkIn();

    const mine = await call({ method: 'GET', url: '/api/v1/visits?limit=100', token: desk.token });
    expect(mine.statusCode).toBe(200);
    expect(mine.json<{ items: Array<{ id: string }> }>().items.map((v) => v.id)).toContain(id);

    const theirs = await call({ method: 'GET', url: '/api/v1/visits?limit=100', token: deskB.token });
    expect(theirs.json<{ items: Array<{ id: string }> }>().items.map((v) => v.id)).not.toContain(id);

    const direct = await call({ method: 'GET', url: `/api/v1/visits/${id}`, token: deskB.token });
    expect(direct.statusCode).toBe(404);
  });

  it('refuses to list visits without visit.list', async () => {
    const stranger = await call({
      method: 'GET',
      url: '/api/v1/visits',
      token: doctor.token,
    });
    expect(stranger.statusCode).toBe(403);
  });
});
