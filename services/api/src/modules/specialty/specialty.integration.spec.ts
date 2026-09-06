import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { CONSOLE_COMPONENT_CATALOGUE, PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module.js';
import { SpecialtyController } from './specialty.controller.js';
import { SpecialtyService } from './specialty.service.js';

/**
 * OP-025 §0.9 — the five framework acceptance criteria, tested once here and
 * never re-tested per console.
 *
 *  F1 A console registered as data appears for the mapped department with no
 *     code deploy — and cannot name a component this build does not ship. The
 *     second half is what makes the first half safe: a tab pointing at nothing
 *     is a blank panel for a whole department, found by a clinician with a
 *     patient in the chair.
 *  F2 A device result attaches through the one shared path and stays
 *     unreviewed until a clinician says otherwise. The technician who uploaded
 *     it cannot be that clinician, in the keys or in the database.
 *  F3 A console action raises a charge intent; cancelling the action before
 *     billing voids it, and once it has reached a bill line it cannot be
 *     voided at all — only reversed, with a reason.
 *  F4 A signed specialty document is immutable and amends to version 2 with a
 *     reason, on the shared `clinical.documents` chain rather than a per-console
 *     copy of it.
 *  F5 Stage moves close one leg and open the next atomically, and each leg
 *     keeps its own clock so a slow dilation and a slow doctor are
 *     distinguishable.
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

/** Composes consoles. Holds no clinical key at all. */
const admin = actor('sp-admin');
/** Orders and reviews. Cannot attach. */
const doctor = actor('sp-doctor');
/** Performs and attaches. Cannot review — the whole point of the split. */
const technician = actor('sp-technician');
/** Runs the lanes. */
const nurse = actor('sp-nurse');

const ADMIN_KEYS = ['console.registry.read', 'console.registry.configure', 'console.device_type.configure'];
const DOCTOR_KEYS = [
  'console.registry.read',
  'console.worklist.read',
  'console.stage.record',
  'device.result.order',
  'device.result.review',
  'device.result.cancel',
];
const TECHNICIAN_KEYS = [
  'console.registry.read',
  'console.worklist.read',
  'console.stage.record',
  'device.result.attach',
];
const NURSE_KEYS = ['console.registry.read', 'console.worklist.read', 'console.stage.record'];

const PATIENT = newId();
const VISIT = newId();
const ENCOUNTER = newId();
const DEPARTMENT = newId();

// ── fixtures ─────────────────────────────────────────────────────────────────

async function syncCatalogues(): Promise<void> {
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
  for (const c of CONSOLE_COMPONENT_CATALOGUE) {
    await pool.query(
      `INSERT INTO mdm.console_components (key, kind, label, description, deprecated, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5, now(), now()) ON CONFLICT (key) DO NOTHING`,
      [c.key, c.kind, c.label, c.description, c.deprecated ?? false],
    );
  }
  // One deliberately retired component, so the "deprecated" refusal has
  // something real to refuse.
  await pool.query(
    `INSERT INTO mdm.console_components (key, kind, label, description, deprecated, created_at, updated_at)
     VALUES ('generic.retired', 'tab_component', 'Retired', 'A panel this build no longer ships.', true, now(), now())
     ON CONFLICT (key) DO NOTHING`,
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

async function seedPatientAndEncounter(): Promise<void> {
  const pool = pg.pool('migrator');
  await pool.query(
    `INSERT INTO patient.patients
       (id, hospital_id, branch_id, uhid, uhid_normalised, first_name, full_name, gender, dob,
        mobile, mobile_local, dedupe_fingerprint, status, updated_at)
     VALUES ($1, $2, $3, $4, $4, 'Asha', 'Asha Rao', 'female', '1974-02-09'::date,
             '+919845000000', '9845000000', $5, 'active', now())`,
    [
      PATIENT,
      tenants.hospitalA,
      tenants.branchA,
      `UH-${PATIENT.replace(/-/g, '').slice(-10)}`,
      PATIENT.replace(/-/g, ''),
    ],
  );
  await pool.query(
    `INSERT INTO clinical.op_visits
       (id, hospital_id, branch_id, visit_no, patient_id, status, checked_in_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'in_consult', now(), now())`,
    [VISIT, tenants.hospitalA, tenants.branchA, `V-${VISIT.replace(/-/g, '').slice(-10)}`, PATIENT],
  );
  await pool.query(
    `INSERT INTO clinical.encounters
       (id, hospital_id, branch_id, patient_id, visit_id, department_key, type, status, started_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'opd', 'in_progress', now(), now())`,
    [ENCOUNTER, tenants.hospitalA, tenants.branchA, PATIENT, VISIT, DEPARTMENT],
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
const alreadyWired = appControllers.includes(SpecialtyController);

@Module({
  imports: [AppModule],
  controllers: alreadyWired ? [] : [SpecialtyController],
  providers: alreadyWired ? [] : [SpecialtyService],
})
class SpecialtyTestModule {}

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'SPC' });
  await syncCatalogues();

  await seedActor(admin, ADMIN_KEYS);
  await seedActor(doctor, DOCTOR_KEYS);
  await seedActor(technician, TECHNICIAN_KEYS);
  await seedActor(nurse, NURSE_KEYS);
  await seedPatientAndEncounter();

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(SpecialtyTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  for (const who of [admin, doctor, technician, nurse]) {
    who.token = await login(who.username);
  }
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('F1 — a console is data, and it cannot outrun the build', () => {
  let consoleId = '';

  it('refuses a tab naming a component this build does not ship', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/specialty/consoles',
      token: admin.token,
      payload: {
        code: 'OPHTHA',
        name: 'Ophthalmology',
        moduleKey: 'module.ophthalmology.enabled',
        tabs: [
          { key: 'history', label: 'History', component: 'generic.history' },
          { key: 'ghost', label: 'Ghost', component: 'nobody.wrote.this' },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ detail: string }>().detail).toContain('does not ship');
  });

  it('refuses a tab naming a deprecated component, and one naming both or neither', async () => {
    const deprecated = await call({
      method: 'POST',
      url: '/api/v1/specialty/consoles',
      token: admin.token,
      payload: {
        code: 'OPHTHA',
        name: 'Ophthalmology',
        moduleKey: 'module.ophthalmology.enabled',
        tabs: [{ key: 'old', label: 'Old', component: 'generic.retired' }],
      },
    });
    // The component is absent from the code catalogue as well as deprecated in
    // the table, so the service refuses it before the trigger has to.
    expect(deprecated.statusCode).toBe(400);

    for (const tabs of [
      [{ key: 'both', label: 'Both', component: 'generic.notes', formTemplateKey: 'generic.notes' }],
      [{ key: 'blank', label: 'Blank' }],
      [],
    ]) {
      const res = await call({
        method: 'POST',
        url: '/api/v1/specialty/consoles',
        token: admin.token,
        payload: {
          code: 'OPHTHA',
          name: 'Ophthalmology',
          moduleKey: 'module.ophthalmology.enabled',
          tabs,
        },
      });
      expect(res.statusCode, JSON.stringify(tabs)).toBe(400);
    }
  });

  it('refuses a console with no licence key to switch it off with', async () => {
    // phase-08: "Every console is behind its own flag." A console with no
    // module key could not be turned off, and gate 11 requires that every one
    // of them can.
    const res = await call({
      method: 'POST',
      url: '/api/v1/specialty/consoles',
      token: admin.token,
      payload: {
        code: 'OPHTHA',
        name: 'Ophthalmology',
        moduleKey: 'ophthalmology',
        tabs: [{ key: 'history', label: 'History', component: 'generic.history' }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('registers a console composed only of what exists, and it appears with no deploy', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/specialty/consoles',
      token: admin.token,
      payload: {
        code: 'OPHTHA',
        name: 'Ophthalmology',
        moduleKey: 'module.ophthalmology.enabled',
        departmentIds: [DEPARTMENT],
        tabs: [
          { key: 'history', label: 'History', component: 'generic.history' },
          { key: 'investigations', label: 'Investigations', component: 'generic.investigations' },
          { key: 'notes', label: 'Notes', component: 'generic.notes' },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    consoleId = created.json<{ id: string }>().id;

    const seen = await call({
      method: 'GET',
      url: `/api/v1/specialty/consoles?departmentId=${DEPARTMENT}`,
      token: doctor.token,
    });
    expect(seen.statusCode).toBe(200);
    const consoles = seen.json<{ code: string; tabs: unknown[] }[]>();
    expect(consoles).toHaveLength(1);
    expect(consoles[0]?.code).toBe('OPHTHA');
    expect(consoles[0]?.tabs).toHaveLength(3);
  });

  it('keeps composing a console away from the clinical floor', async () => {
    const byDoctor = await call({
      method: 'POST',
      url: '/api/v1/specialty/consoles',
      token: doctor.token,
      payload: {
        code: 'DENTAL',
        name: 'Dental',
        moduleKey: 'module.dental.enabled',
        tabs: [{ key: 'history', label: 'History', component: 'generic.history' }],
      },
    });
    expect(byDoctor.statusCode).toBe(403);
  });

  it('writes the console.registered event, so the boards know a department changed', async () => {
    const rows = await pg
      .pool('migrator')
      .query(`SELECT payload FROM core.outbox_events WHERE event_type = 'console.registered'`);
    expect(rows.rowCount).toBeGreaterThanOrEqual(1);
    expect(consoleId).not.toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('F2 — a result is unreviewed until a clinician says otherwise', () => {
  let orderId = '';

  it('declares a device result type against the console', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/specialty/device-types',
      token: admin.token,
      payload: {
        consoleCode: 'OPHTHA',
        code: 'OCT_MACULA',
        name: 'OCT macula',
        transport: 'dicom',
        sideRequired: true,
        reviewDueHours: 2,
        billingServiceCode: 'OPH-OCT',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ sideRequired: boolean }>().sideRequired).toBe(true);
  });

  it('refuses an order that does not name an eye', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/specialty/device-orders',
      token: doctor.token,
      payload: { patientId: PATIENT, encounterId: ENCOUNTER, deviceResultTypeCode: 'OCT_MACULA' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ detail: string }>().detail).toContain('side');
  });

  it('orders it for the right eye, unreviewed from the first moment', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/specialty/device-orders',
      token: doctor.token,
      payload: {
        patientId: PATIENT,
        encounterId: ENCOUNTER,
        deviceResultTypeCode: 'OCT_MACULA',
        side: 'right',
      },
    });
    expect(res.statusCode).toBe(201);
    const row = res.json<{ id: string; status: string; reviewedAt: string | null; side: string }>();
    orderId = row.id;
    expect(row.status).toBe('ordered');
    expect(row.side).toBe('right');
    expect(row.reviewedAt).toBeNull();
  });

  it('keeps attaching with the technician and reviewing with the clinician', async () => {
    const doctorAttaching = await call({
      method: 'PATCH',
      url: `/api/v1/specialty/device-orders/${orderId}/attach`,
      token: doctor.token,
      payload: { pacsStudyUid: '1.2.840.1' },
    });
    expect(doctorAttaching.statusCode).toBe(403);

    const attached = await call({
      method: 'PATCH',
      url: `/api/v1/specialty/device-orders/${orderId}/attach`,
      token: technician.token,
      payload: {
        pacsStudyUid: '1.2.840.113619.2.55.3.1',
        parsed: { centralSubfieldThicknessUm: 312 },
      },
    });
    expect(attached.statusCode).toBe(200);
    const row = attached.json<{ status: string; reviewedAt: string | null; deviceResultTypeName: string }>();
    expect(row.status).toBe('attached');
    expect(row.reviewedAt, 'attaching is not reviewing').toBeNull();
    expect(row.deviceResultTypeName).toBe('OCT macula');

    const technicianReviewing = await call({
      method: 'PATCH',
      url: `/api/v1/specialty/device-orders/${orderId}/review`,
      token: technician.token,
    });
    expect(
      technicianReviewing.statusCode,
      'if the uploader could review, "reviewed" would mean "uploaded"',
    ).toBe(403);
  });

  it('puts it on the doctor’s rail until somebody looks', async () => {
    const rail = await call({
      method: 'GET',
      url: '/api/v1/specialty/device-orders?unreviewedOnly=true',
      token: doctor.token,
    });
    expect(rail.statusCode).toBe(200);
    const rows = rail.json<{ id: string; minutesUnreviewed: number | null }[]>();
    expect(rows.some((r) => r.id === orderId)).toBe(true);
    expect(rows.find((r) => r.id === orderId)?.minutesUnreviewed).not.toBeNull();

    const reviewed = await call({
      method: 'PATCH',
      url: `/api/v1/specialty/device-orders/${orderId}/review`,
      token: doctor.token,
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json<{ reviewedAt: string | null }>().reviewedAt).not.toBeNull();

    const again = await call({
      method: 'PATCH',
      url: `/api/v1/specialty/device-orders/${orderId}/review`,
      token: doctor.token,
    });
    expect(again.statusCode).toBe(409);

    const empty = await call({
      method: 'GET',
      url: '/api/v1/specialty/device-orders?unreviewedOnly=true',
      token: doctor.token,
    });
    expect(empty.json<{ id: string }[]>().some((r) => r.id === orderId)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('F3 — the charge intent, and what happens when the action is cancelled', () => {
  let orderId = '';
  let intentId = '';

  it('raises an intent in the same transaction as the order', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/specialty/device-orders',
      token: doctor.token,
      payload: {
        patientId: PATIENT,
        encounterId: ENCOUNTER,
        deviceResultTypeCode: 'OCT_MACULA',
        side: 'left',
      },
    });
    expect(res.statusCode).toBe(201);
    const row = res.json<{ id: string; chargeIntentId: string | null }>();
    orderId = row.id;
    expect(row.chargeIntentId).not.toBeNull();
    intentId = row.chargeIntentId ?? '';

    const intent = await pg
      .pool('migrator')
      .query(`SELECT status::text AS status, description FROM billing.charge_intents WHERE id = $1`, [
        intentId,
      ]);
    expect((intent.rows[0] as { status: string }).status).toBe('pending');
    expect((intent.rows[0] as { description: string }).description).toContain('left');
  });

  it('voids the intent when the action is cancelled before billing', async () => {
    const cancelled = await call({
      method: 'POST',
      url: `/api/v1/specialty/device-orders/${orderId}/cancel`,
      token: doctor.token,
      payload: { reason: 'Patient could not sit for the scan today' },
    });
    expect(cancelled.statusCode).toBe(201);

    const intent = await pg
      .pool('migrator')
      .query(`SELECT status::text AS status FROM billing.charge_intents WHERE id = $1`, [intentId]);
    expect((intent.rows[0] as { status: string }).status).toBe('cancelled');
  });

  it('refuses to revive the cancelled order', async () => {
    const again = await call({
      method: 'PATCH',
      url: `/api/v1/specialty/device-orders/${orderId}/perform`,
      token: technician.token,
    });
    expect(again.statusCode).toBe(409);
  });

  it('refuses to void an intent that has already reached a bill line', async () => {
    const posted = await call({
      method: 'POST',
      url: '/api/v1/specialty/device-orders',
      token: doctor.token,
      payload: {
        patientId: PATIENT,
        encounterId: ENCOUNTER,
        deviceResultTypeCode: 'OCT_MACULA',
        side: 'right',
      },
    });
    const billedOrder = posted.json<{ id: string; chargeIntentId: string | null }>();
    const billedIntent = billedOrder.chargeIntentId ?? '';

    await pg
      .pool('migrator')
      .query(
        `UPDATE billing.charge_intents SET status = 'posted', bill_line_id = gen_random_uuid(), posted_at = now() WHERE id = $1`,
        [billedIntent],
      );

    await expect(
      pg
        .pool('migrator')
        .query(`UPDATE billing.charge_intents SET status = 'cancelled' WHERE id = $1`, [billedIntent]),
    ).rejects.toThrow(/reversed with a reason|cannot be voided/u);

    await expect(
      pg
        .pool('migrator')
        .query(`UPDATE billing.charge_intents SET status = 'reversed', reversed_at = now() WHERE id = $1`, [
          billedIntent,
        ]),
    ).rejects.toThrow(/records why/u);

    const reversed = await pg.pool('migrator').query(
      `UPDATE billing.charge_intents SET status = 'reversed', reversed_at = now(),
           reversal_reason = 'Scan cancelled after the bill was raised' WHERE id = $1 RETURNING status::text AS status`,
      [billedIntent],
    );
    expect((reversed.rows[0] as { status: string }).status).toBe('reversed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('F4 — a signed specialty document is immutable and amends to a new version', () => {
  const documentId = newId();

  it('signs version 1, refuses to edit it, and chains version 2 with a reason', async () => {
    const pool = pg.pool('migrator');
    await pool.query(
      `INSERT INTO clinical.documents
         (id, hospital_id, branch_id, patient_id, encounter_id, type, title, current_version,
          current_status, owner_module, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'report', 'Ophthalmology visit summary', 1, 'draft', 'OPHTHA', now(), now())`,
      [documentId, tenants.hospitalA, tenants.branchA, PATIENT, ENCOUNTER],
    );

    const v1 = newId();
    await pool.query(
      `INSERT INTO clinical.document_versions
         (id, hospital_id, document_id, version, status, content, signed_by, signed_at, sign_method,
          created_at, created_by)
       VALUES ($1, $2, $3, 1, 'final', $4::jsonb, $5, now(), 'system', now(), $5)`,
      [
        v1,
        tenants.hospitalA,
        documentId,
        JSON.stringify({ finalDiagnosis: 'Nuclear cataract, right eye' }),
        doctor.userId,
      ],
    );

    const signed = await pool.query(
      `SELECT content_sha256, prev_sha256 FROM clinical.document_versions WHERE id = $1`,
      [v1],
    );
    expect((signed.rows[0] as { content_sha256: string }).content_sha256).toMatch(/^[0-9a-f]{64}$/u);

    await expect(
      pool.query(
        `UPDATE clinical.document_versions SET content = '{"finalDiagnosis":"something else"}'::jsonb WHERE id = $1`,
        [v1],
      ),
    ).rejects.toThrow();

    const v2 = newId();
    await pool.query(
      `INSERT INTO clinical.document_versions
         (id, hospital_id, document_id, version, status, content, amendment_reason, signed_by, signed_at,
          sign_method, created_at, created_by)
       VALUES ($1, $2, $3, 2, 'final', $4::jsonb, $5, $6, now(), 'system', now(), $6)`,
      [
        v2,
        tenants.hospitalA,
        documentId,
        JSON.stringify({ finalDiagnosis: 'Nuclear cataract, both eyes' }),
        'Left eye reviewed after dilation',
        doctor.userId,
      ],
    );

    const chain = await pool.query(
      `SELECT version, content_sha256, prev_sha256, amendment_reason
         FROM clinical.document_versions WHERE document_id = $1 ORDER BY version`,
      [documentId],
    );
    const rows = chain.rows as { version: number; content_sha256: string; prev_sha256: string | null }[];
    expect(rows).toHaveLength(2);
    // The chain links itself: version 2 carries version 1's digest, computed by
    // the database rather than supplied by the caller.
    expect(rows[1]?.prev_sha256).toBe(rows[0]?.content_sha256);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════

describe('F5 — one clock per leg of the visit', () => {
  it('closes the open leg and opens the next in one call', async () => {
    const refraction = await call({
      method: 'POST',
      url: '/api/v1/specialty/stages',
      token: nurse.token,
      payload: {
        encounterId: ENCOUNTER,
        patientId: PATIENT,
        consoleCode: 'OPHTHA',
        stageKey: 'refraction',
      },
    });
    expect(refraction.statusCode).toBe(201);
    expect(refraction.json<{ open: boolean }>().open).toBe(true);

    const dilating = await call({
      method: 'POST',
      url: '/api/v1/specialty/stages',
      token: nurse.token,
      payload: {
        encounterId: ENCOUNTER,
        patientId: PATIENT,
        consoleCode: 'OPHTHA',
        stageKey: 'dilating',
      },
    });
    expect(dilating.statusCode).toBe(201);

    const stages = await call({
      method: 'GET',
      url: `/api/v1/specialty/stages/${ENCOUNTER}`,
      token: doctor.token,
    });
    const legs = stages.json<{ stageKey: string; open: boolean }[]>();
    expect(legs.map((l) => l.stageKey)).toEqual(['refraction', 'dilating']);
    expect(legs.filter((l) => l.open)).toHaveLength(1);
    expect(legs.find((l) => l.stageKey === 'dilating')?.open).toBe(true);
  });

  it('refuses a second open leg of the same stage', async () => {
    // Written straight to the table: the service closes the open leg first, and
    // the point of the index is that nothing else can get past it either.
    await expect(
      pg.pool('migrator').query(
        `INSERT INTO clinical.encounter_stages
           (id, hospital_id, branch_id, encounter_id, patient_id, console_code, stage_key, started_by,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'OPHTHA', 'dilating', $6, now(), now())`,
        [newId(), tenants.hospitalA, tenants.branchA, ENCOUNTER, PATIENT, nurse.userId],
      ),
    ).rejects.toThrow(/uq_one_open_stage_per_encounter/u);
  });

  it('shows the patient on the console worklist with what they are waiting on', async () => {
    const res = await call({
      method: 'GET',
      url: '/api/v1/specialty/worklist?consoleCode=OPHTHA',
      token: doctor.token,
    });
    expect(res.statusCode).toBe(200);
    const rows =
      res.json<
        { patientId: string; stageKey: string; pendingResults: number; unreviewedResults: number }[]
      >();
    const mine = rows.find((r) => r.patientId === PATIENT);
    expect(mine?.stageKey).toBe('dilating');
    // Pending and unreviewed are counted separately: a scan not yet done is a
    // scheduling problem, one sitting unlooked-at is a clinical one.
    expect(typeof mine?.pendingResults).toBe('number');
    expect(typeof mine?.unreviewedResults).toBe('number');
  });

  it('emits encounter.stage.moved with the time spent in the leg it closed', async () => {
    const rows = await pg
      .pool('migrator')
      .query(`SELECT payload FROM core.outbox_events WHERE event_type = 'encounter.stage.moved'`);
    expect(rows.rowCount).toBeGreaterThanOrEqual(2);
    const payloads = rows.rows.map((r) => (r as { payload: Record<string, unknown> }).payload);
    expect(payloads.some((p) => p['fromStage'] === 'refraction' && p['toStage'] === 'dilating')).toBe(true);
  });
});
