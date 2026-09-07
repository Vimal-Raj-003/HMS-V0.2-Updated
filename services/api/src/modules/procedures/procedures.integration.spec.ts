import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module.js';
import { ProceduresController } from './procedures.controller.js';
import { ProceduresService } from './procedures.service.js';

/**
 * OP-010 and OP-039 against a real PostgreSQL 17.
 *
 * The spine most other consoles call into, so these are the rules every one of
 * them inherits:
 *
 *  1. **A procedure does not start on a promise.** Consent where required — with
 *     no override anywhere, in any request field, held by any role — a time-out
 *     where the procedure is invasive, and a checklist either complete or
 *     overridden by a named person with a reason.
 *  2. **A time-out is two different people and five yeses.** One person
 *     confirming is a person agreeing with themselves.
 *  3. **A sedated patient leaves on a score and an escort.**
 *  4. **A room holds one case at a time**, and back-to-back is a turnover.
 *  5. **A drug given at a chair carries the ward's five rights**: identity, a
 *     batch in date, an allergy list read, and a second person on a high-alert
 *     drug who is not the one giving it.
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

/** Orders, performs, overrides, signs. */
const doctor = actor('proc-doctor');
/** The second pair of eyes in the room, and the second name on a time-out. */
const nurse = actor('proc-nurse');
/** A second nurse, so a high-alert check is genuinely two people. */
const nurseTwo = actor('proc-nurse-2');
/** Records and performs; never overrides, never signs. */
const resident = actor('proc-resident');

const DOCTOR_KEYS = [
  'procedure.order.read',
  'procedure.order.create',
  'procedure.room.configure',
  'procedure.booking.manage',
  'procedure.checklist.record',
  'procedure.checklist.override',
  'procedure.timeout.confirm',
  'procedure.perform',
  'procedure.sign',
  'procedure.recovery.record',
];
const NURSE_KEYS = [
  'procedure.order.read',
  'procedure.checklist.record',
  'procedure.timeout.confirm',
  'opdnursing.task.read',
  'opdnursing.task.manage',
  'opdnursing.administer',
  'opdnursing.administer.verify',
  'opdnursing.dressing.record',
];
const RESIDENT_KEYS = [
  'procedure.order.read',
  'procedure.order.create',
  'procedure.checklist.record',
  'procedure.timeout.confirm',
  'procedure.perform',
];

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

async function newEncounter(): Promise<string> {
  const pool = pg.pool('migrator');
  const visitId = newId();
  const encounterId = newId();
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
  return encounterId;
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

/** An invasive order that needs consent — the hard case, used throughout. */
async function invasiveOrder(): Promise<string> {
  const encounter = await newEncounter();
  const res = await call({
    method: 'POST',
    url: '/api/v1/procedures/orders',
    token: doctor.token,
    payload: {
      patientId: PATIENT,
      encounterId: encounter,
      procedureCode: 'EXCISION',
      procedureName: 'Excision of sebaceous cyst',
      category: 'invasive',
      side: 'right',
      requiresConsent: true,
      sourceModule: 'DERM',
    },
  });
  return res.json<{ id: string }>().id;
}

const appControllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as unknown[];
const alreadyWired = appControllers.includes(ProceduresController);

@Module({
  imports: [AppModule],
  controllers: alreadyWired ? [] : [ProceduresController],
  providers: alreadyWired ? [] : [ProceduresService],
})
class ProceduresTestModule {}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'PRC' });
  await syncPermissions();
  await defineSeries('PROC', 'PROC{BR}{SEQ:5}');

  await seedActor(doctor, DOCTOR_KEYS);
  await seedActor(nurse, NURSE_KEYS);
  await seedActor(nurseTwo, NURSE_KEYS);
  await seedActor(resident, RESIDENT_KEYS);

  await pg.pool('migrator').query(
    `INSERT INTO patient.patients
       (id, hospital_id, branch_id, uhid, uhid_normalised, first_name, full_name, gender, dob,
        mobile, mobile_local, dedupe_fingerprint, status, updated_at)
     VALUES ($1, $2, $3, $4, $4, 'Nandini', 'Nandini Rao', 'female', '1969-08-21'::date,
             '+919845000000', '9845000000', $5, 'active', now())`,
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

  app = await NestFactory.create<NestFastifyApplication>(ProceduresTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  for (const who of [doctor, nurse, nurseTwo, resident]) {
    who.token = await login(who.username);
  }
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('a procedure does not start on a promise', () => {
  let orderId = '';

  it('lists the blockers before anybody walks the patient into a room', async () => {
    orderId = await invasiveOrder();

    const listed = await call({
      method: 'GET',
      url: '/api/v1/procedures/orders?openOnly=true',
      token: nurse.token,
    });
    expect(listed.statusCode).toBe(200);
    const row = listed
      .json<{ id: string; blockers: string[]; readyToStart: boolean }[]>()
      .find((o) => o.id === orderId);
    expect(row?.readyToStart).toBe(false);
    expect(row?.blockers.some((b) => b.includes('Consent'))).toBe(true);
    expect(row?.blockers.some((b) => b.includes('time-out'))).toBe(true);
  });

  it('refuses to start without consent, whoever asks and whatever they send', async () => {
    for (const [token, who] of [
      [doctor.token, 'doctor'],
      [resident.token, 'resident'],
    ] as const) {
      const res = await call({
        method: 'POST',
        url: `/api/v1/procedures/orders/${orderId}/start`,
        token,
        payload: { anaesthesia: 'local' },
      });
      expect(res.statusCode, who).toBe(409);
      expect(res.json<{ detail: string }>().detail).toContain('no override');
    }

    // Every field a caller might reach for. All ignored, all the same refusal.
    for (const payload of [
      { anaesthesia: 'local', force: true },
      { anaesthesia: 'local', consentWaived: true },
      { anaesthesia: 'local', emergency: true },
      { anaesthesia: 'local', override: 'consultant decision' },
    ]) {
      const res = await call({
        method: 'POST',
        url: `/api/v1/procedures/orders/${orderId}/start`,
        token: doctor.token,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(409);
    }
  });

  it('offers no endpoint that waives consent', async () => {
    // `PATCH …/consent` attaches a signed document. There is no sibling that
    // marks the order consented without one, and a 404 is what a client that
    // guessed at one gets.
    const guessed = await call({
      method: 'POST',
      url: `/api/v1/procedures/orders/${orderId}/consent/waive`,
      token: doctor.token,
      payload: { reason: 'urgent' },
    });
    expect(guessed.statusCode).toBe(404);
  });

  it('still refuses once consent is recorded but no time-out has been done', async () => {
    const consented = await call({
      method: 'PATCH',
      url: `/api/v1/procedures/orders/${orderId}/consent`,
      token: doctor.token,
      payload: { consentId: newId() },
    });
    expect(consented.statusCode).toBe(200);

    const res = await call({
      method: 'POST',
      url: `/api/v1/procedures/orders/${orderId}/start`,
      token: doctor.token,
      payload: { anaesthesia: 'local' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: string }>().detail).toContain('time-out');
  });

  it('refuses a time-out one person confirmed, and one with an answer of no', async () => {
    const alone = await call({
      method: 'POST',
      url: `/api/v1/procedures/orders/${orderId}/timeout`,
      token: doctor.token,
      payload: {
        confirmedBy2: doctor.userId,
        patientOk: true,
        procedureOk: true,
        sideOk: true,
        consentOk: true,
        allergyOk: true,
      },
    });
    expect(alone.statusCode).toBe(400);
    expect(alone.json<{ detail: string }>().detail).toContain('agreeing with themselves');

    // A "no" is not a value the schema accepts: it stops the procedure rather
    // than being filed.
    const withNo = await call({
      method: 'POST',
      url: `/api/v1/procedures/orders/${orderId}/timeout`,
      token: doctor.token,
      payload: {
        confirmedBy2: nurse.userId,
        patientOk: true,
        procedureOk: true,
        sideOk: false,
        consentOk: true,
        allergyOk: true,
      },
    });
    expect(withNo.statusCode).toBe(400);
  });

  it('refuses to start on an incomplete checklist, and proceeds on a signed override', async () => {
    const confirmed = await call({
      method: 'POST',
      url: `/api/v1/procedures/orders/${orderId}/timeout`,
      token: doctor.token,
      payload: {
        confirmedBy2: nurse.userId,
        patientOk: true,
        procedureOk: true,
        sideOk: true,
        consentOk: true,
        allergyOk: true,
      },
    });
    expect(confirmed.statusCode).toBe(201);

    await call({
      method: 'POST',
      url: `/api/v1/procedures/orders/${orderId}/checklist`,
      token: nurse.token,
      payload: {
        templateKey: 'minor_ot',
        items: [{ key: 'fasting', label: 'Fasting confirmed', required: true }],
        ready: false,
      },
    });

    const blocked = await call({
      method: 'POST',
      url: `/api/v1/procedures/orders/${orderId}/start`,
      token: doctor.token,
      payload: { anaesthesia: 'local' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ detail: string }>().detail).toContain('not silently');

    // A resident does not hold the override key.
    const byResident = await call({
      method: 'POST',
      url: `/api/v1/procedures/orders/${orderId}/checklist/override`,
      token: resident.token,
      payload: { reason: 'Bleeding lesion; proceeding without the fasting item' },
    });
    expect(byResident.statusCode).toBe(403);

    const overridden = await call({
      method: 'POST',
      url: `/api/v1/procedures/orders/${orderId}/checklist/override`,
      token: doctor.token,
      payload: { reason: 'Bleeding lesion; proceeding without the fasting item' },
    });
    expect(overridden.statusCode).toBe(201);
    expect(overridden.json<{ overrideBy: string | null }>().overrideBy).toBe(doctor.userId);

    const started = await call({
      method: 'POST',
      url: `/api/v1/procedures/orders/${orderId}/start`,
      token: doctor.token,
      payload: { anaesthesia: 'local' },
    });
    expect(started.statusCode).toBe(201);
  });

  it('records on the event what was true before it began', async () => {
    const rows = await pg
      .pool('migrator')
      .query(`SELECT payload FROM core.outbox_events WHERE event_type = 'procedure.started'`);
    expect(rows.rowCount).toBeGreaterThanOrEqual(1);
    const payload = (rows.rows[0] as { payload: Record<string, unknown> }).payload;
    expect(payload['consented']).toBe(true);
    expect(payload['timeoutConfirmed']).toBe(true);
    expect(payload['checklistOverridden']).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('sedation, recovery and the signed note', () => {
  let procedureId = '';

  beforeAll(async () => {
    const orderId = await invasiveOrder();
    await call({
      method: 'PATCH',
      url: `/api/v1/procedures/orders/${orderId}/consent`,
      token: doctor.token,
      payload: { consentId: newId() },
    });
    await call({
      method: 'POST',
      url: `/api/v1/procedures/orders/${orderId}/timeout`,
      token: doctor.token,
      payload: {
        confirmedBy2: nurse.userId,
        patientOk: true,
        procedureOk: true,
        sideOk: true,
        consentOk: true,
        allergyOk: true,
      },
    });
    const started = await call({
      method: 'POST',
      url: `/api/v1/procedures/orders/${orderId}/start`,
      token: doctor.token,
      payload: { anaesthesia: 'sedation', anaesthetistId: nurse.userId },
    });
    procedureId = started.json<{ id: string }>().id;
  });

  it('refuses discharge below Aldrete 9, and with no escort', async () => {
    const low = await call({
      method: 'POST',
      url: `/api/v1/procedures/${procedureId}/recovery`,
      token: doctor.token,
      payload: { aldreteScore: 7, escortName: 'Ramesh Kumar', discharge: true },
    });
    expect(low.statusCode).toBe(409);
    expect(low.json<{ detail: string }>().detail).toContain('9 or above');

    const alone = await call({
      method: 'POST',
      url: `/api/v1/procedures/${procedureId}/recovery`,
      token: doctor.token,
      payload: { aldreteScore: 9, discharge: true },
    });
    expect(alone.statusCode).toBe(409);
    expect(alone.json<{ detail: string }>().detail).toContain('escort');
  });

  it('discharges at 9 with somebody to take them home', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/procedures/${procedureId}/recovery`,
      token: doctor.token,
      payload: {
        aldreteScore: 9,
        escortName: 'Ramesh Kumar',
        escortRelationship: 'son',
        instructions: 'No driving today',
        discharge: true,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ dischargedAt: string | null }>().dischargedAt).not.toBeNull();

    const events = await pg
      .pool('migrator')
      .query(`SELECT payload FROM core.outbox_events WHERE event_type = 'procedure.recovery.discharged'`);
    expect(events.rowCount).toBeGreaterThanOrEqual(1);
    expect((events.rows[0] as { payload: Record<string, unknown> }).payload['escortRecorded']).toBe(true);
  });

  it('signs the note once and then refuses every edit', async () => {
    const completed = await call({
      method: 'PATCH',
      url: `/api/v1/procedures/${procedureId}/complete`,
      token: doctor.token,
      payload: {
        findings: 'Cyst excised intact; wound closed with four interrupted sutures',
        outcome: 'completed',
      },
    });
    expect(completed.statusCode).toBe(200);

    const signed = await call({
      method: 'POST',
      url: `/api/v1/procedures/${procedureId}/sign`,
      token: doctor.token,
    });
    expect(signed.statusCode).toBe(201);

    const edited = await call({
      method: 'PATCH',
      url: `/api/v1/procedures/${procedureId}/complete`,
      token: doctor.token,
      payload: { findings: 'Something else entirely', outcome: 'completed' },
    });
    expect(edited.statusCode).toBe(409);

    // Written straight to the table, past the service: the trigger is the rule.
    await expect(
      pg
        .pool('migrator')
        .query(`UPDATE clinical.procedures SET findings = 'rewritten' WHERE id = $1`, [procedureId]),
    ).rejects.toThrow(/signed and cannot be edited/u);

    const again = await call({
      method: 'POST',
      url: `/api/v1/procedures/${procedureId}/sign`,
      token: doctor.token,
    });
    expect(again.statusCode).toBe(409);
  });

  it('keeps signing with the consultant and off the resident', async () => {
    expect(RESIDENT_KEYS).not.toContain('procedure.sign');
    const res = await call({
      method: 'POST',
      url: `/api/v1/procedures/${procedureId}/sign`,
      token: resident.token,
    });
    expect(res.statusCode).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('the room, and two cases that want it', () => {
  let roomId = '';

  beforeAll(async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/procedures/rooms',
      token: doctor.token,
      payload: { code: 'MOT-T', name: 'Minor OT (test)', type: 'minor_ot' },
    });
    roomId = created.json<{ id: string }>().id;
  });

  it('gives the room to one case, refuses the overlap, and allows the turnover', async () => {
    const first = await invasiveOrder();
    const second = await invasiveOrder();

    const start = new Date(Date.now() + 3_600_000).toISOString();
    const middle = new Date(Date.now() + 5_400_000).toISOString();
    const end = new Date(Date.now() + 7_200_000).toISOString();
    const later = new Date(Date.now() + 10_800_000).toISOString();

    const booked = await call({
      method: 'POST',
      url: `/api/v1/procedures/orders/${first}/bookings`,
      token: doctor.token,
      payload: { roomId, startAt: start, endAt: end },
    });
    expect(booked.statusCode).toBe(201);

    const clash = await call({
      method: 'POST',
      url: `/api/v1/procedures/orders/${second}/bookings`,
      token: doctor.token,
      payload: { roomId, startAt: middle, endAt: end },
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json<{ detail: string }>().detail).toContain('already taken');

    // Half-open: a case ending at the hour and another starting at it is a
    // turnover, not a clash.
    const turnover = await call({
      method: 'POST',
      url: `/api/v1/procedures/orders/${second}/bookings`,
      token: doctor.token,
      payload: { roomId, startAt: end, endAt: later },
    });
    expect(turnover.statusCode).toBe(201);
  });

  it('releases the room when the order is cancelled', async () => {
    const order = await invasiveOrder();
    const start = new Date(Date.now() + 86_400_000).toISOString();
    const end = new Date(Date.now() + 90_000_000).toISOString();

    await call({
      method: 'POST',
      url: `/api/v1/procedures/orders/${order}/bookings`,
      token: doctor.token,
      payload: { roomId, startAt: start, endAt: end },
    });

    const noReason = await call({
      method: 'POST',
      url: `/api/v1/procedures/orders/${order}/cancel`,
      token: doctor.token,
      payload: { reason: 'no' },
    });
    expect(noReason.statusCode).toBe(400);

    const cancelled = await call({
      method: 'POST',
      url: `/api/v1/procedures/orders/${order}/cancel`,
      token: doctor.token,
      payload: { reason: 'Patient unwell; rebooking next week' },
    });
    expect(cancelled.statusCode).toBe(201);

    // And the hour is free again.
    const reused = await invasiveOrder();
    const rebooked = await call({
      method: 'POST',
      url: `/api/v1/procedures/orders/${reused}/bookings`,
      token: doctor.token,
      payload: { roomId, startAt: start, endAt: end },
    });
    expect(rebooked.statusCode).toBe(201);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('OP-039 — the five rights at a chair', () => {
  let taskId = '';

  beforeAll(async () => {
    const encounter = await newEncounter();
    const created = await call({
      method: 'POST',
      url: '/api/v1/opd-nursing/tasks',
      token: nurse.token,
      payload: {
        patientId: PATIENT,
        encounterId: encounter,
        type: 'injection',
        roomType: 'injection_room',
        dayNo: 3,
        dayTotal: 5,
      },
    });
    taskId = created.json<{ id: string }>().id;
  });

  it('refuses day seven of a five-day course, and a hold with no reason', async () => {
    const encounter = await newEncounter();
    const impossible = await call({
      method: 'POST',
      url: '/api/v1/opd-nursing/tasks',
      token: nurse.token,
      payload: {
        patientId: PATIENT,
        encounterId: encounter,
        type: 'injection',
        roomType: 'injection_room',
        dayNo: 7,
        dayTotal: 5,
      },
    });
    expect(impossible.statusCode).toBe(400);

    const held = await call({
      method: 'PATCH',
      url: `/api/v1/opd-nursing/tasks/${taskId}/status`,
      token: nurse.token,
      payload: { status: 'held' },
    });
    expect(held.statusCode).toBe(400);
  });

  it('refuses an expired batch, with no override anywhere', async () => {
    const res = await call({
      method: 'POST',
      url: `/api/v1/opd-nursing/tasks/${taskId}/administer`,
      token: nurse.token,
      payload: {
        drugName: 'Ceftriaxone',
        orderedDose: 1,
        givenDose: 1,
        doseUnit: 'g',
        route: 'iv_push',
        batchNo: 'B-2201',
        expiry: '2020-01-31',
        identityMethod: 'wristband',
        allergyChecked: true,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: string }>().detail).toContain('no override');
  });

  it('has no way to give a drug without reading the allergy list', async () => {
    // `allergyChecked` is `z.literal(true)`: false is not a value the schema
    // has, so there is nothing to send.
    const res = await call({
      method: 'POST',
      url: `/api/v1/opd-nursing/tasks/${taskId}/administer`,
      token: nurse.token,
      payload: {
        drugName: 'Ceftriaxone',
        orderedDose: 1,
        givenDose: 1,
        doseUnit: 'g',
        route: 'iv_push',
        identityMethod: 'wristband',
        allergyChecked: false,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a changed dose with no reason, and takes one with', async () => {
    const silent = await call({
      method: 'POST',
      url: `/api/v1/opd-nursing/tasks/${taskId}/administer`,
      token: nurse.token,
      payload: {
        drugName: 'Ceftriaxone',
        orderedDose: 1,
        givenDose: 0.5,
        doseUnit: 'g',
        route: 'iv_push',
        identityMethod: 'wristband',
        allergyChecked: true,
      },
    });
    expect(silent.statusCode).toBe(400);

    const explained = await call({
      method: 'POST',
      url: `/api/v1/opd-nursing/tasks/${taskId}/administer`,
      token: nurse.token,
      payload: {
        drugName: 'Ceftriaxone',
        orderedDose: 1,
        givenDose: 0.5,
        doseUnit: 'g',
        doseChangeReason: 'Renal impairment; dose halved on the prescriber’s note',
        route: 'iv_push',
        identityMethod: 'wristband',
        allergyChecked: true,
      },
    });
    expect(explained.statusCode).toBe(201);
  });

  it('refuses a high-alert drug verified by the person giving it', async () => {
    const encounter = await newEncounter();
    const task = await call({
      method: 'POST',
      url: '/api/v1/opd-nursing/tasks',
      token: nurse.token,
      payload: {
        patientId: PATIENT,
        encounterId: encounter,
        type: 'injection',
        roomType: 'injection_room',
      },
    });
    const insulinTask = task.json<{ id: string }>().id;

    const itself = await call({
      method: 'POST',
      url: `/api/v1/opd-nursing/tasks/${insulinTask}/administer`,
      token: nurse.token,
      payload: {
        drugName: 'Insulin regular',
        orderedDose: 10,
        givenDose: 10,
        doseUnit: 'unit',
        route: 'sc',
        identityMethod: 'wristband',
        highAlert: true,
        verifierId: nurse.userId,
        barcodeVerified: true,
        batchNo: 'INS-9',
        allergyChecked: true,
      },
    });
    expect(itself.statusCode).toBe(400);
    expect(itself.json<{ detail: string }>().detail).toContain('not the one giving it');

    const properly = await call({
      method: 'POST',
      url: `/api/v1/opd-nursing/tasks/${insulinTask}/administer`,
      token: nurse.token,
      payload: {
        drugName: 'Insulin regular',
        orderedDose: 10,
        givenDose: 10,
        doseUnit: 'unit',
        route: 'sc',
        identityMethod: 'wristband',
        highAlert: true,
        verifierId: nurseTwo.userId,
        barcodeVerified: true,
        batchNo: 'INS-9',
        allergyChecked: true,
      },
    });
    expect(properly.statusCode).toBe(201);
    expect(properly.json<{ verifierId: string | null }>().verifierId).toBe(nurseTwo.userId);
  });

  it('watches a first parenteral dose, and lets a reaction out of the module', async () => {
    const encounter = await newEncounter();
    const task = await call({
      method: 'POST',
      url: '/api/v1/opd-nursing/tasks',
      token: nurse.token,
      payload: {
        patientId: PATIENT,
        encounterId: encounter,
        type: 'injection',
        roomType: 'injection_room',
      },
    });
    const watchedTask = task.json<{ id: string }>().id;

    const given = await call({
      method: 'POST',
      url: `/api/v1/opd-nursing/tasks/${watchedTask}/administer`,
      token: nurse.token,
      payload: {
        drugName: 'Ceftriaxone',
        orderedDose: 1,
        givenDose: 1,
        doseUnit: 'g',
        route: 'iv_push',
        batchNo: 'B-2311',
        expiry: '2099-06-30',
        barcodeVerified: true,
        identityMethod: 'wristband',
        allergyChecked: true,
        observationMinutes: 30,
      },
    });
    expect(given.statusCode).toBe(201);
    const administrationId = given.json<{ id: string; observationUntil: string | null }>().id;
    expect(given.json<{ observationUntil: string | null }>().observationUntil).not.toBeNull();

    // The task sits in observation, so a patient who walks out is visible
    // rather than silently complete.
    const listed = await call({
      method: 'GET',
      url: '/api/v1/opd-nursing/tasks?roomType=injection_room',
      token: nurse.token,
    });
    const row = listed
      .json<{ id: string; status: string; underObservation: number }[]>()
      .find((t) => t.id === watchedTask);
    expect(row?.status).toBe('observation');
    expect(row?.underObservation).toBe(1);

    const closed = await call({
      method: 'PATCH',
      url: `/api/v1/opd-nursing/administrations/${administrationId}/observation`,
      token: nurse.token,
      payload: { outcome: 'reaction', reaction: { type: 'urticaria' } },
    });
    expect(closed.statusCode).toBe(200);

    const events = await pg
      .pool('migrator')
      .query(`SELECT payload FROM core.outbox_events WHERE event_type = 'opdnursing.reaction'`);
    expect(
      events.rowCount,
      'a reaction recorded only in a nursing note is one the next prescriber never sees',
    ).toBeGreaterThanOrEqual(1);
  });

  it('counts sutures, and refuses a negative count', async () => {
    const encounter = await newEncounter();
    const task = await call({
      method: 'POST',
      url: '/api/v1/opd-nursing/tasks',
      token: nurse.token,
      payload: {
        patientId: PATIENT,
        encounterId: encounter,
        type: 'suture_removal',
        roomType: 'dressing',
      },
    });
    const dressingTask = task.json<{ id: string }>().id;

    const negative = await call({
      method: 'POST',
      url: `/api/v1/opd-nursing/tasks/${dressingTask}/dressing`,
      token: nurse.token,
      payload: { patientId: PATIENT, site: 'left forearm', suturesRemoved: -2 },
    });
    expect(negative.statusCode).toBe(400);

    const recorded = await call({
      method: 'POST',
      url: `/api/v1/opd-nursing/tasks/${dressingTask}/dressing`,
      token: nurse.token,
      payload: {
        patientId: PATIENT,
        site: 'left forearm',
        assessment: { sizeMm: 22 },
        suturesRemoved: 6,
        suturesRetained: 2,
        infectionSigns: false,
      },
    });
    expect(recorded.statusCode).toBe(201);
    expect(recorded.json<{ suturesRetained: number | null }>().suturesRetained).toBe(2);
  });
});
