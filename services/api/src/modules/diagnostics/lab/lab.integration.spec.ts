import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module.js';
import { LAB_CONTROLLERS, LAB_PROVIDERS } from './lab.module.js';

/**
 * OP-004, EN-031 and `docs/DECISIONS.md` D-10, against a real PostgreSQL 17 with
 * row-level security on.
 *
 * The suite exists for the properties that cannot be established by reading the
 * code, and every one of them would fail silently in production:
 *
 *  1. A role **without** the key gets 403 and the same request with the key
 *     succeeds — so the decorator is wired to a guard that actually runs; and a
 *     **cross-tenant id returns 404, not 403** (`docs/09` §3.1). No query in this
 *     module carries a `hospital_id` predicate, so if isolation holds, RLS is
 *     what is holding it.
 *  2. Every mutation leaves its audit row *and* its registered outbox event,
 *     both inside the transaction that made the change (EN-024 §5).
 *  3. **A critical potassium is stored and its alert is raised with no
 *     ceremony** (D-10): the value is visible, flagged and announced before
 *     anybody has telephoned anybody.
 *  4. **Authorisation is refused until the call-back is documented, and accepted
 *     the moment it is** — on either arm, read-back or "unreachable, escalated".
 *  5. **Release is refused while QC is `never_evaluated`** (exit gate 4): the
 *     analyte nobody ran a control on fails closed.
 *  6. **A Westgard 1-3s violation blocks release**, and the only way past is the
 *     Lab Director's recorded authorisation — never a retry.
 *  7. **A rejected sample cannot carry a result**, and its recollection traces
 *     back to the specimen and the order it replaces (exit gate 3).
 *  8. **An amendment writes a new version and the hash chain still verifies**;
 *     the original stays.
 *  9. A confidential analyte is unreadable without `lab.result.sensitive.read`.
 * 10. The bench worklist meets its class-B budget with a real plan.
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

/** Front office / ward: raises the order. */
const orderer = actor('lab-orderer');
/** Phlebotomy: labels, collects, receives, accessions, rejects. */
const phleb = actor('lab-phleb');
/** Bench technician: enters results, records QC, telephones criticals. */
const tech = actor('lab-tech');
/** Senior technician: level 1, technical verification. Never the enterer. */
const senior = actor('lab-senior');
/** Pathologist: level 2, amendment, reports, and the confidential analytes. */
const pathologist = actor('lab-pathologist');
/** Lab Director: the single lawful route past a closed QC gate. */
const director = actor('lab-director');
/** Holds `patient.record.read` and nothing else: the 403 case. */
const clerk = actor('lab-clerk');
/** The same ordering role, in the other hospital. */
const ordererB = actor('lab-orderer-bravo');

const ORDERER_KEYS = [
  'lab.order.create',
  'lab.order.list',
  'lab.order.read',
  'lab.order.addon',
  'lab.order.cancel',
  'patient.record.read',
  'mdm.read',
];
const PHLEB_KEYS = [
  'lab.sample.label',
  'lab.sample.collect',
  'lab.sample.receive',
  'lab.sample.reject',
  'lab.order.read',
  'lab.order.list',
  'mdm.read',
];
const TECH_KEYS = [
  'lab.result.enter',
  'lab.result.read',
  'lab.order.read',
  'lab.critical.notify',
  'lab.critical.read',
  'labq.qc.enter',
  'labq.qc.read',
  'labq.qc.action',
  'lab.qc.unlock',
];
const SENIOR_KEYS = ['lab.result.verify', 'lab.result.read', 'lab.result.enter', 'lab.order.read'];
const PATHOLOGIST_KEYS = [
  'lab.result.validate',
  'lab.result.amend',
  'lab.result.read',
  'lab.result.sensitive.read',
  'lab.report.generate',
  'lab.report.read',
  'lab.critical.notify',
  'lab.critical.read',
  'lab.order.read',
];
const DIRECTOR_KEYS = ['labq.qc.action', 'labq.qc.release_override', 'labq.qc.read', 'lab.qc.unlock'];
const CLERK_KEYS = ['patient.record.read'];

const patientA = newId();
const patientB = newId();

/** Record keys for hospital A's laboratory catalogue, filled in `beforeAll`. */
const A = {
  specimen: newId(),
  container: newId(),
  potassium: newId(),
  sodium: newId(),
  creatinine: newId(),
  hiv: newId(),
  panel: newId(),
  rejectHaemolysed: newId(),
  instrument: newId(),
  qcMaterial: newId(),
};

const B = {
  specimen: newId(),
  container: newId(),
  potassium: newId(),
};

// ─────────────────────────────────────────────────────────────────────────────
// fixtures
// ─────────────────────────────────────────────────────────────────────────────

async function syncPermissionCatalogue(): Promise<void> {
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

async function defineSeries(
  hospitalId: string,
  branchId: string,
  key: string,
  pattern: string,
): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO core.numbering_series
       (id, hospital_id, branch_id, key, pattern, scope, fy, current_value, gapless,
        reset_policy, version, effective_from, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'branch', NULL, 0, false,
             'never', 1, now() - interval '1 day', true, now(), now())`,
    [newId(), hospitalId, branchId, key, pattern],
  );
}

async function seedActor(
  hospitalId: string,
  branchId: string,
  who: Actor,
  permissionKeys: readonly string[],
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
     VALUES ($1, $2, $3, $4, 'Integration test role', 'clinical', 'clinical', now())`,
    [who.roleId, hospitalId, `role_${who.username.replace(/-/g, '_')}`, `Role ${who.username}`],
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

async function seedPatient(id: string, hospitalId: string, branchId: string, uhid: string): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO patient.patients
       (id, hospital_id, branch_id, uhid, uhid_normalised, first_name, last_name, full_name,
        gender, dob, mobile, mobile_local, dedupe_fingerprint, updated_at)
     VALUES ($1, $2, $3, $4, $4, $5, 'Test', $6, 'female'::patient."PatientGender", '1980-05-05'::date,
             $7, $8, $9, now())`,
    [
      id,
      hospitalId,
      branchId,
      uhid,
      `${uhid} Given`,
      `${uhid} Given Test`,
      `+9198450${uhid.slice(-5)}`,
      `98450${uhid.slice(-5)}`,
      newId().replace(/-/g, '').slice(0, 32),
    ],
  );
}

interface TestSeed {
  readonly key: string;
  readonly code: string;
  readonly name: string;
  readonly resultType: string;
  readonly unit: string | null;
  readonly isPanel: boolean;
  readonly isSensitive: boolean;
  readonly absurdLow: number | null;
  readonly absurdHigh: number | null;
}

/**
 * The laboratory catalogue for one hospital.
 *
 * Written out here rather than taken from `packages/db/src/seed/diagnostics.ts`:
 * the tenant fixture creates fresh hospitals, so a suite that leaned on the seed
 * would be testing the seed. The numbers are the *shape* the seed writes — a
 * normal band with the panic bounds outside it — and every expectation below is
 * derived from them.
 */
async function seedCatalogue(
  hospitalId: string,
  keys: {
    specimen: string;
    container: string;
    tests: readonly TestSeed[];
    panel?: { key: string; code: string; members: readonly string[] } | undefined;
  },
): Promise<void> {
  const pool = pg.pool('migrator');

  await pool.query(
    `INSERT INTO mdm.mdm_lab_specimen_types
       (id, record_key, hospital_id, version, code, name, stability_hours, retention_days,
        effective_from, status, updated_at)
     VALUES ($1, $2, $3, 1, 'SER', 'Serum', 24, 7, now() - interval '1 year', 'active', now())`,
    [newId(), keys.specimen, hospitalId],
  );
  await pool.query(
    `INSERT INTO mdm.mdm_lab_containers
       (id, record_key, hospital_id, version, code, name, cap_colour, cap_colour_hex,
        order_of_draw, specimen_type_key, effective_from, status, updated_at)
     VALUES ($1, $2, $3, 1, 'SST-GLD', 'Gold-top SST', 'gold', '#d4af37', 5, $4,
             now() - interval '1 year', 'active', now())`,
    [newId(), keys.container, hospitalId, keys.specimen],
  );

  for (const t of keys.tests) {
    await pool.query(
      `INSERT INTO mdm.mdm_lab_tests
         (id, record_key, hospital_id, branch_id, version, code, name, short_code, loinc_code,
          discipline, specimen_type_key, container_key, is_panel, result_type, unit, decimals,
          method, tat_routine_minutes, tat_urgent_minutes, tat_stat_minutes,
          is_nabl_scope, is_sensitive, is_orderable, absurd_low, absurd_high,
          effective_from, status, updated_at)
       VALUES ($1, $2, $3, NULL, 1, $4, $5, $4, NULL,
               'biochemistry'::mdm."LabDiscipline", $6, $7, $8, $9::mdm."LabResultType", $10, 1,
               'ISE indirect', 240, 60, 30,
               false, $11, true, $12, $13,
               now() - interval '1 year', 'active', now())`,
      [
        newId(),
        t.key,
        hospitalId,
        t.code,
        t.name,
        keys.specimen,
        keys.container,
        t.isPanel,
        t.resultType,
        t.unit,
        t.isSensitive,
        t.absurdLow,
        t.absurdHigh,
      ],
    );
  }

  if (keys.panel !== undefined) {
    let sequence = 0;
    for (const member of keys.panel.members) {
      await pool.query(
        `INSERT INTO mdm.mdm_lab_panel_members
           (id, record_key, hospital_id, version, panel_key, member_test_key, sequence,
            effective_from, status, updated_at)
         VALUES ($1, $2, $3, 1, $4, $5, $6, now() - interval '1 year', 'active', now())`,
        [newId(), newId(), hospitalId, keys.panel.key, member, sequence],
      );
      sequence += 1;
    }
  }
}

async function seedNumericRange(
  hospitalId: string,
  testKey: string,
  band: { low: number; high: number; criticalLow: number; criticalHigh: number; unit: string },
): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO lab.lab_reference_ranges
       (id, record_key, hospital_id, version, test_key, parameter_key, sex,
        age_min_days, age_max_days, unit, low, high, critical_low, critical_high,
        effective_from, status, updated_at)
     VALUES ($1, $2, $3, 1, $4, NULL, 'any', 0, 43800, $5, $6, $7, $8, $9,
             now() - interval '1 year', 'active', now())`,
    [
      newId(),
      newId(),
      hospitalId,
      testKey,
      band.unit,
      band.low,
      band.high,
      band.criticalLow,
      band.criticalHigh,
    ],
  );
}

async function seedCodedRange(
  hospitalId: string,
  testKey: string,
  textNormal: string,
  critical: readonly string[],
): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO lab.lab_reference_ranges
       (id, record_key, hospital_id, version, test_key, parameter_key, sex,
        age_min_days, age_max_days, text_normal, critical_coded_values,
        effective_from, status, updated_at)
     VALUES ($1, $2, $3, 1, $4, NULL, 'any', 0, 43800, $5, $6::text[],
             now() - interval '1 year', 'active', now())`,
    [newId(), newId(), hospitalId, testKey, textNormal, critical],
  );
}

async function seedRejectionReason(hospitalId: string, recordKey: string): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO lab.lab_rejection_reasons
       (id, record_key, hospital_id, version, code, label, nabl_category,
        requires_recollection, recollection_chargeable, notify_patient, notify_ordering_doctor,
        sort_order, effective_from, status, updated_at)
     VALUES ($1, $2, $3, 1, 'HAEM', 'Haemolysed specimen', 'pre_analytical',
             true, false, true, true, 1, now() - interval '1 year', 'active', now())`,
    [newId(), recordKey, hospitalId],
  );
}

/**
 * The QC estate for the Westgard scenarios: one analyzer, one control lot, a
 * target for creatinine on it, and a rule set in which 1-3s rejects and 1-2s —
 * as `EN-031 §5` and the database both insist — only ever warns.
 */
async function seedQcEstate(hospitalId: string, branchId: string): Promise<void> {
  const pool = pg.pool('migrator');

  await pool.query(
    `INSERT INTO integration.lab_instruments
       (id, hospital_id, branch_id, code, name, make, model, serial, discipline, driver_key,
        protocol, transport, status, updated_at)
     VALUES ($1, $2, $3, 'ANZ-1', 'Chemistry analyzer 1', 'Acme', 'CX-9', 'CX9-000117',
             'biochemistry'::mdm."LabDiscipline", 'acme-cx9',
             'hl7_v2'::integration."LabIfProtocol", 'tcp_server'::integration."LabIfTransport",
             'live'::integration."LabInstrumentStatus", now())`,
    [A.instrument, hospitalId, branchId],
  );

  await pool.query(
    `INSERT INTO lab.labq_qc_materials
       (id, hospital_id, branch_id, manufacturer, product, lot_no, level, expiry_date, status, updated_at)
     VALUES ($1, $2, $3, 'Acme', 'Chem Control', 'LOT-2026-A', 'l1'::lab."LabQcLevel",
             (CURRENT_DATE + 180), 'active', now())`,
    [A.qcMaterial, hospitalId, branchId],
  );

  await pool.query(
    `INSERT INTO lab.labq_qc_targets
       (id, hospital_id, qc_material_id, test_key, parameter_key, instrument_id, unit,
        source, mean, sd, n_runs, approved_by, approved_at, effective_from, updated_at)
     VALUES ($1, $2, $3, $4, NULL, $5, 'umol/L', 'lab_derived', 88, 4,
             24, $6, now() - interval '30 days', now() - interval '30 days', now())`,
    [newId(), hospitalId, A.qcMaterial, A.creatinine, A.instrument, director.userId],
  );

  for (const [rule, action] of [
    ['r_1_3s', 'reject'],
    ['r_1_2s', 'warning'],
    ['r_2_2s', 'reject'],
  ] as const) {
    await pool.query(
      `INSERT INTO lab.labq_westgard_config
         (id, hospital_id, branch_id, test_key, parameter_key, instrument_id, rule_code, action,
          enabled, effective_from, updated_at)
       VALUES ($1, $2, NULL, $3, NULL, $4, $5::lab."LabWestgardRule", $6::lab."LabWestgardAction",
               true, now() - interval '30 days', now())`,
      [newId(), hospitalId, A.creatinine, A.instrument, rule, action],
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// harness
// ─────────────────────────────────────────────────────────────────────────────

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
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly token: string;
  readonly reason?: string;
  readonly idempotencyKey?: string;
  readonly payload?: Record<string, unknown>;
}

async function call(options: CallOptions) {
  const headers: Record<string, string> = { authorization: `Bearer ${options.token}` };
  if (options.reason !== undefined) headers['x-reason'] = options.reason;
  // Routes marked `@Idempotent()` refuse a POST with no key. A fresh key per
  // call keeps each one a distinct submission; a test about replay passes the
  // same key twice deliberately.
  if (options.method === 'POST') headers['idempotency-key'] = options.idempotencyKey ?? newId();
  return app.inject({
    method: options.method,
    url: options.url,
    headers,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

async function auditRowsForTrace(traceId: unknown): Promise<Array<Record<string, unknown>>> {
  const result = await pg.pool('migrator').query(
    `SELECT id, actor_user_id, entity, action::text AS action, row_id, patient_id,
            reason_text, before, after, data_class::text AS data_class
       FROM core.audit_log WHERE trace_id = $1 ORDER BY recorded_at, id`,
    [String(traceId)],
  );
  return result.rows as Array<Record<string, unknown>>;
}

async function outboxRowsForTrace(traceId: unknown): Promise<Array<Record<string, unknown>>> {
  const result = await pg.pool('migrator').query(
    `SELECT id, event_type, aggregate, aggregate_id, payload, contains_phi, retention_days
       FROM core.outbox_events WHERE trace_id = $1 ORDER BY event_type`,
    [String(traceId)],
  );
  return result.rows as Array<Record<string, unknown>>;
}

/**
 * The application as it ships, plus this module.
 *
 * The root imports **only** `AppModule`. The lab controllers and providers are
 * declared here only while `AppModule` does not declare them itself: once they
 * are spread into it, declaring them a second time would mount every route twice
 * and Fastify would refuse with `FST_ERR_DUPLICATED_ROUTE` before a single test
 * ran. The check is on `AppModule`'s own metadata, so this file needs no edit
 * either way.
 */
const appControllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as unknown[];
const alreadyWired = appControllers.includes(LAB_CONTROLLERS[0]);

@Module({
  imports: [AppModule],
  controllers: alreadyWired ? [] : LAB_CONTROLLERS,
  providers: alreadyWired ? [] : LAB_PROVIDERS,
})
class LabTestModule {}

// ─────────────────────────────────────────────────────────────────────────────
// order-to-result helpers
// ─────────────────────────────────────────────────────────────────────────────

interface OrderShape {
  readonly id: string;
  readonly accession_no: string;
  readonly tests: { id: string; test_key: string; status: string; is_chargeable: boolean }[];
  readonly samples: { id: string; barcode: string; status: string }[];
}

async function createOrder(testKeys: readonly string[], patientId = patientA): Promise<OrderShape> {
  const res = await call({
    method: 'POST',
    url: '/api/v1/lab/orders',
    token: orderer.token,
    payload: {
      patientId,
      source: 'walkin',
      priority: 'routine',
      tests: testKeys.map((testKey) => ({ testKey })),
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<OrderShape>();
}

/** Label → collect (two scans) → receive → accession. The whole pre-analytical path. */
async function toAccessioned(order: OrderShape): Promise<OrderShape> {
  const labels = await call({
    method: 'POST',
    url: `/api/v1/lab/orders/${order.id}/labels`,
    token: phleb.token,
    payload: {},
  });
  expect(labels.statusCode, labels.body).toBe(201);
  const issued = labels.json<{ labels: { barcode: string }[] }>().labels;

  for (const barcode of new Set(issued.map((l) => l.barcode))) {
    const collected = await call({
      method: 'POST',
      url: `/api/v1/lab/samples/${encodeURIComponent(barcode)}/collect`,
      token: phleb.token,
      payload: {
        patientScanVerified: true,
        containerScanVerified: true,
        collectionSite: 'opd_collection_room',
      },
    });
    expect(collected.statusCode, collected.body).toBe(201);

    const received = await call({
      method: 'POST',
      url: `/api/v1/lab/samples/${encodeURIComponent(barcode)}/receive`,
      token: phleb.token,
      payload: { conditionOnReceipt: 'satisfactory' },
    });
    expect(received.statusCode, received.body).toBe(201);

    const accessioned = await call({
      method: 'POST',
      url: `/api/v1/lab/samples/${encodeURIComponent(barcode)}/accession`,
      token: phleb.token,
      payload: {},
    });
    expect(accessioned.statusCode, accessioned.body).toBe(201);
  }

  const reread = await call({ method: 'GET', url: `/api/v1/lab/orders/${order.id}`, token: orderer.token });
  return reread.json<OrderShape>();
}

async function enterResult(
  orderTestId: string,
  entry: Record<string, unknown>,
): Promise<{ id: string; current_flag: string | null; current_status: string }> {
  const res = await call({
    method: 'POST',
    url: '/api/v1/lab/results',
    token: tech.token,
    payload: { results: [{ orderTestId, ...entry }] },
  });
  expect(res.statusCode, res.body).toBe(201);
  const results = res.json<{
    results: { id: string; current_flag: string | null; current_status: string }[];
  }>().results;
  const first = results[0];
  if (first === undefined) throw new Error('no result written');
  return first;
}

// ─────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'LAB' });
  await syncPermissionCatalogue();

  for (const [hospitalId, branchId] of [
    [tenants.hospitalA, tenants.branchA],
    [tenants.hospitalB, tenants.branchB],
  ] as const) {
    await defineSeries(hospitalId, branchId, 'LAB_ACC', '{BR}/LAB/{SEQ:6}');
    await defineSeries(hospitalId, branchId, 'SAMPLE', '{BR}/SMP/{SEQ:6}');
  }

  await seedActor(tenants.hospitalA, tenants.branchA, orderer, ORDERER_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, phleb, PHLEB_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, tech, TECH_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, senior, SENIOR_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, pathologist, PATHOLOGIST_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, director, DIRECTOR_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, clerk, CLERK_KEYS);
  await seedActor(tenants.hospitalB, tenants.branchB, ordererB, [...ORDERER_KEYS, 'lab.result.read']);

  await seedCatalogue(tenants.hospitalA, {
    specimen: A.specimen,
    container: A.container,
    tests: [
      {
        key: A.potassium,
        code: 'K',
        name: 'Potassium, serum',
        resultType: 'numeric',
        unit: 'mmol/L',
        isPanel: false,
        isSensitive: false,
        absurdLow: 0.5,
        absurdHigh: 12,
      },
      {
        key: A.sodium,
        code: 'NA',
        name: 'Sodium, serum',
        resultType: 'numeric',
        unit: 'mmol/L',
        isPanel: false,
        isSensitive: false,
        absurdLow: 80,
        absurdHigh: 200,
      },
      {
        key: A.creatinine,
        code: 'CREA',
        name: 'Creatinine, serum',
        resultType: 'numeric',
        unit: 'umol/L',
        isPanel: false,
        isSensitive: false,
        absurdLow: 5,
        absurdHigh: 3000,
      },
      {
        key: A.hiv,
        code: 'HIV',
        name: 'HIV 1 and 2 antibody screen',
        resultType: 'qualitative',
        unit: null,
        isPanel: false,
        isSensitive: true,
        absurdLow: null,
        absurdHigh: null,
      },
      {
        key: A.panel,
        code: 'RFT',
        name: 'Renal function test',
        resultType: 'numeric',
        unit: null,
        isPanel: true,
        isSensitive: false,
        absurdLow: null,
        absurdHigh: null,
      },
    ],
    panel: { key: A.panel, code: 'RFT', members: [A.sodium, A.creatinine] },
  });

  await seedCatalogue(tenants.hospitalB, {
    specimen: B.specimen,
    container: B.container,
    tests: [
      {
        key: B.potassium,
        code: 'K',
        name: 'Potassium, serum',
        resultType: 'numeric',
        unit: 'mmol/L',
        isPanel: false,
        isSensitive: false,
        absurdLow: 0.5,
        absurdHigh: 12,
      },
    ],
  });

  // The seeded adult bands: normal inside, panic outside. `OP-007`'s vitals
  // ranges were once seeded with the abnormal numbers in these columns; the
  // orientation is asserted by every expectation below.
  await seedNumericRange(tenants.hospitalA, A.potassium, {
    low: 3.5,
    high: 5.1,
    criticalLow: 2.5,
    criticalHigh: 6.0,
    unit: 'mmol/L',
  });
  await seedNumericRange(tenants.hospitalA, A.sodium, {
    low: 136,
    high: 145,
    criticalLow: 120,
    criticalHigh: 160,
    unit: 'mmol/L',
  });
  await seedNumericRange(tenants.hospitalA, A.creatinine, {
    low: 60,
    high: 110,
    criticalLow: 30,
    criticalHigh: 600,
    unit: 'umol/L',
  });
  await seedCodedRange(tenants.hospitalA, A.hiv, 'Non-reactive', ['Reactive']);
  await seedNumericRange(tenants.hospitalB, B.potassium, {
    low: 3.5,
    high: 5.1,
    criticalLow: 2.5,
    criticalHigh: 6.0,
    unit: 'mmol/L',
  });

  await seedRejectionReason(tenants.hospitalA, A.rejectHaemolysed);
  await seedQcEstate(tenants.hospitalA, tenants.branchA);

  await seedPatient(patientA, tenants.hospitalA, tenants.branchA, 'LABA00001');
  await seedPatient(patientB, tenants.hospitalB, tenants.branchB, 'LABB00001');

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(LabTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  orderer.token = await login(tenants.hospitalA, orderer.username);
  phleb.token = await login(tenants.hospitalA, phleb.username);
  tech.token = await login(tenants.hospitalA, tech.username);
  senior.token = await login(tenants.hospitalA, senior.username);
  pathologist.token = await login(tenants.hospitalA, pathologist.username);
  director.token = await login(tenants.hospitalA, director.username);
  clerk.token = await login(tenants.hospitalA, clerk.username);
  ordererB.token = await login(tenants.hospitalB, ordererB.username);
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('permission gating and tenant isolation', () => {
  it('refuses an order from a role without lab.order.create, and accepts it with', async () => {
    const denied = await call({
      method: 'POST',
      url: '/api/v1/lab/orders',
      token: clerk.token,
      payload: { patientId: patientA, source: 'walkin', tests: [{ testKey: A.potassium }] },
    });
    expect(denied.statusCode, denied.body).toBe(403);

    const allowed = await createOrder([A.potassium]);
    expect(allowed.accession_no).toMatch(/LAB/);
  });

  it('returns 404 — not 403 — for another hospital’s order', async () => {
    const mine = await createOrder([A.potassium]);

    const cross = await call({
      method: 'GET',
      url: `/api/v1/lab/orders/${mine.id}`,
      token: ordererB.token,
    });
    // A 403 would confirm the record exists in some other hospital. docs/09 §3.1
    // requires a cross-tenant miss to be indistinguishable from a genuine one,
    // and no query in this module carries a hospital_id predicate — so RLS is
    // what is holding this.
    expect(cross.statusCode, cross.body).toBe(404);
  });

  it('returns 404 for another hospital’s specimen scanned by barcode', async () => {
    const mine = await toAccessioned(await createOrder([A.potassium]));
    const barcode = mine.samples[0]?.barcode ?? '';
    expect(barcode).not.toBe('');

    const cross = await call({
      method: 'GET',
      url: `/api/v1/lab/samples/${encodeURIComponent(barcode)}`,
      token: ordererB.token,
    });
    expect(cross.statusCode, cross.body).toBe(404);
  });

  it('will not let a role without lab.result.enter write a result', async () => {
    const order = await toAccessioned(await createOrder([A.potassium]));
    const line = order.tests[0];
    expect(line).toBeDefined();

    const denied = await call({
      method: 'POST',
      url: '/api/v1/lab/results',
      token: phleb.token,
      payload: { results: [{ orderTestId: line?.id, valueNumeric: 4.2 }] },
    });
    expect(denied.statusCode, denied.body).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a panel expands, and the order-to-accession path', () => {
  it('expands a panel into its members and gives each line its own identity', async () => {
    const order = await createOrder([A.panel]);
    expect(order.tests).toHaveLength(2);
    expect(order.tests.map((t) => t.test_key).sort()).toEqual([A.sodium, A.creatinine].sort());
  });

  it('prints one label per container and refuses a reprint with no reason', async () => {
    const order = await createOrder([A.potassium, A.sodium]);
    const labels = await call({
      method: 'POST',
      url: `/api/v1/lab/orders/${order.id}/labels`,
      token: phleb.token,
      payload: {},
    });
    expect(labels.statusCode, labels.body).toBe(201);
    // Both tests draw serum into the gold-top tube, so there is one container.
    const issued = labels.json<{ labels: { barcode: string; cap_colour: string | null }[] }>().labels;
    expect(issued).toHaveLength(1);
    expect(issued[0]?.cap_colour).toBe('gold');

    const bareReprint = await call({
      method: 'POST',
      url: `/api/v1/lab/orders/${order.id}/labels`,
      token: phleb.token,
      payload: {},
    });
    expect(bareReprint.statusCode, bareReprint.body).toBe(400);

    const reprint = await call({
      method: 'POST',
      url: `/api/v1/lab/orders/${order.id}/labels`,
      token: phleb.token,
      payload: { reprintReason: 'Label smudged in the tube rack' },
    });
    expect(reprint.statusCode, reprint.body).toBe(201);
    expect(reprint.json<{ labels: { is_reprint: boolean }[] }>().labels[0]?.is_reprint).toBe(true);
  });

  it('refuses a collection with neither two scans nor a named override', async () => {
    const order = await createOrder([A.potassium]);
    const labels = await call({
      method: 'POST',
      url: `/api/v1/lab/orders/${order.id}/labels`,
      token: phleb.token,
      payload: {},
    });
    const barcode = labels.json<{ labels: { barcode: string }[] }>().labels[0]?.barcode ?? '';

    const bare = await call({
      method: 'POST',
      url: `/api/v1/lab/samples/${encodeURIComponent(barcode)}/collect`,
      token: phleb.token,
      payload: { patientScanVerified: true, containerScanVerified: false },
    });
    expect(bare.statusCode, bare.body).toBe(400);

    // The printer-failure override is the only third answer, and it is audited.
    const overridden = await call({
      method: 'POST',
      url: `/api/v1/lab/samples/${encodeURIComponent(barcode)}/collect`,
      token: phleb.token,
      payload: {
        patientScanVerified: false,
        containerScanVerified: false,
        identityOverrideReason: 'Label printer down; identity confirmed verbally against the wristband',
      },
    });
    expect(overridden.statusCode, overridden.body).toBe(201);
    expect(overridden.json<{ identity_override_reason: string | null }>().identity_override_reason).toContain(
      'printer down',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('one audit row and one outbox event per mutation, in one transaction', () => {
  it('records the order, its audit row and its registered event under one trace', async () => {
    const res = await call({
      method: 'POST',
      url: '/api/v1/lab/orders',
      token: orderer.token,
      payload: { patientId: patientA, source: 'walkin', tests: [{ testKey: A.potassium }] },
    });
    expect(res.statusCode, res.body).toBe(201);
    const order = res.json<OrderShape>();
    const trace = res.headers['x-trace-id'];

    const audit = (await auditRowsForTrace(trace)).filter((r) => r['entity'] === 'lab.lab_orders');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.['row_id']).toBe(order.id);
    expect(audit[0]?.['patient_id']).toBe(patientA);
    expect(audit[0]?.['data_class']).toBe('phi');

    const events = (await outboxRowsForTrace(trace)).filter((e) => e['event_type'] === 'lab.order.created');
    expect(events).toHaveLength(1);
    expect(events[0]?.['contains_phi']).toBe(true);
    expect((events[0]?.['payload'] as { accessionNo: string }).accessionNo).toBe(order.accession_no);
  });

  it('records the rejection, its audit row and lab.sample.rejected under one trace', async () => {
    const order = await toAccessioned(await createOrder([A.potassium]));
    const barcode = order.samples[0]?.barcode ?? '';

    const rejected = await call({
      method: 'POST',
      url: `/api/v1/lab/samples/${encodeURIComponent(barcode)}/reject`,
      token: phleb.token,
      reason: 'Gross haemolysis on receipt',
      payload: { rejectionReasonKey: A.rejectHaemolysed, note: 'Visible haemolysis' },
    });
    expect(rejected.statusCode, rejected.body).toBe(201);
    const trace = rejected.headers['x-trace-id'];

    const audit = (await auditRowsForTrace(trace)).filter((r) => r['entity'] === 'lab.lab_samples');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.['reason_text']).toBe('Visible haemolysis');

    const events = (await outboxRowsForTrace(trace)).filter((e) => e['event_type'] === 'lab.sample.rejected');
    expect(events).toHaveLength(1);
    expect((events[0]?.['payload'] as { reasonCode: string }).reasonCode).toBe('HAEM');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the critical value: released immediately, authorised only on evidence (D-10)', () => {
  let order: OrderShape;
  let resultId: string;
  let alertId: string;

  it('stores a critical potassium and raises its alert with no ceremony at all', async () => {
    order = await toAccessioned(await createOrder([A.potassium]));
    const line = order.tests[0];
    expect(line).toBeDefined();

    const result = await enterResult(line?.id ?? '', { valueNumeric: 7.2, unit: 'mmol/L' });
    resultId = result.id;

    // Nothing was withheld: the value is stored, flagged and readable, and
    // nobody has telephoned anybody yet.
    expect(result.current_flag).toBe('critical_high');
    expect(result.current_status).toBe('unverified');

    const read = await call({ method: 'GET', url: `/api/v1/lab/results/${resultId}`, token: tech.token });
    expect(read.statusCode, read.body).toBe(200);
    const view = read.json<{ value_numeric: number; ever_critical: boolean; ref_critical_high: number }>();
    expect(view.value_numeric).toBe(7.2);
    expect(view.ever_critical).toBe(true);
    expect(view.ref_critical_high).toBe(6);

    // The alert exists because a database trigger wrote it in the same
    // transaction as the value — not because a service remembered to.
    const open = await call({
      method: 'GET',
      url: '/api/v1/lab/critical-values?open=true',
      token: tech.token,
    });
    expect(open.statusCode, open.body).toBe(200);
    const alerts = open.json<{
      items: { id: string; result_id: string; status: string; value_display: string }[];
    }>().items;
    const mine = alerts.find((a) => a.result_id === resultId);
    expect(mine).toBeDefined();
    expect(mine?.status).toBe('open');
    alertId = mine?.id ?? '';
  });

  it('announces lab.result.critical on entry, before any authorisation', async () => {
    const fresh = await toAccessioned(await createOrder([A.potassium]));
    const line = fresh.tests[0];
    const res = await call({
      method: 'POST',
      url: '/api/v1/lab/results',
      token: tech.token,
      payload: { results: [{ orderTestId: line?.id, valueNumeric: 2.0, unit: 'mmol/L' }] },
    });
    expect(res.statusCode, res.body).toBe(201);

    const events = (await outboxRowsForTrace(res.headers['x-trace-id'])).map((e) => e['event_type']);
    expect(events).toContain('lab.result.entered');
    expect(events).toContain('lab.result.critical');
  });

  it('refuses authorisation while the communication is undocumented', async () => {
    const verified = await call({
      method: 'POST',
      url: '/api/v1/lab/results/verify',
      token: senior.token,
      payload: { resultIds: [resultId] },
    });
    expect(verified.statusCode, verified.body).toBe(201);

    const refused = await call({
      method: 'POST',
      url: '/api/v1/lab/results/authorise',
      token: pathologist.token,
      payload: { resultIds: [resultId] },
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json<{ type: string }>().type).toContain('clinical-hard-stop');

    // And the refusal touched nothing: the value is still exactly where it was.
    const still = await call({ method: 'GET', url: `/api/v1/lab/results/${resultId}`, token: tech.token });
    expect(still.json<{ current_status: string; value_numeric: number }>().current_status).toBe('verified');
    expect(still.json<{ value_numeric: number }>().value_numeric).toBe(7.2);
  });

  it('refuses a call-back that records neither a read-back nor an escalation', async () => {
    const neither = await call({
      method: 'POST',
      url: `/api/v1/lab/critical-values/${alertId}/notify`,
      token: tech.token,
      payload: { outcome: 'read_back_confirmed', method: 'phone' },
    });
    // The discriminated union refuses it at the door; the CHECK on
    // `lab_critical_value_callbacks` refuses it again if anything gets past.
    expect(neither.statusCode, neither.body).toBe(400);
  });

  it('accepts authorisation once the read-back is on file', async () => {
    const notified = await call({
      method: 'POST',
      url: `/api/v1/lab/critical-values/${alertId}/notify`,
      token: tech.token,
      payload: {
        outcome: 'read_back_confirmed',
        method: 'phone',
        notifiedToName: 'Dr Anita Rao',
        notifiedToRole: 'ward_registrar',
        readBackValue: '7.2 mmol/L',
      },
    });
    expect(notified.statusCode, notified.body).toBe(201);
    const alert = notified.json<{ status: string; callbacks: { read_back_confirmed: boolean }[] }>();
    expect(alert.status).toBe('communicated');
    expect(alert.callbacks[0]?.read_back_confirmed).toBe(true);

    const events = (await outboxRowsForTrace(notified.headers['x-trace-id'])).map((e) => e['event_type']);
    expect(events).toContain('lab.critical.acknowledged');

    const authorised = await call({
      method: 'POST',
      url: '/api/v1/lab/results/authorise',
      token: pathologist.token,
      payload: { resultIds: [resultId] },
    });
    expect(authorised.statusCode, authorised.body).toBe(201);
    expect(authorised.json<{ results: { current_status: string }[] }>().results[0]?.current_status).toBe(
      'authorised',
    );
  });

  it('accepts the escalation arm too — an unreachable clinician is a tracked exception, not a bypass', async () => {
    const order2 = await toAccessioned(await createOrder([A.potassium]));
    const line = order2.tests[0];
    const result = await enterResult(line?.id ?? '', { valueNumeric: 2.1, unit: 'mmol/L' });

    await call({
      method: 'POST',
      url: '/api/v1/lab/results/verify',
      token: senior.token,
      payload: { resultIds: [result.id] },
    });

    const alerts = await call({
      method: 'GET',
      url: `/api/v1/lab/critical-values?open=true&patientId=${patientA}`,
      token: pathologist.token,
    });
    const alert = alerts
      .json<{ items: { id: string; result_id: string }[] }>()
      .items.find((a) => a.result_id === result.id);
    expect(alert).toBeDefined();

    const escalated = await call({
      method: 'POST',
      url: `/api/v1/lab/critical-values/${alert?.id}/notify`,
      token: pathologist.token,
      payload: {
        outcome: 'clinician_unreachable_escalated',
        method: 'phone',
        escalatedToLevel: 2,
        escalatedToRole: 'medical_superintendent',
        remarks: 'Three attempts on the ward line and the mobile, no answer',
      },
    });
    expect(escalated.statusCode, escalated.body).toBe(201);
    expect(escalated.json<{ status: string }>().status).toBe('escalated');

    const authorised = await call({
      method: 'POST',
      url: '/api/v1/lab/results/authorise',
      token: pathologist.token,
      payload: { resultIds: [result.id] },
    });
    expect(authorised.statusCode, authorised.body).toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the QC release gate — never_evaluated is not passed (exit gate 4)', () => {
  it('refuses to verify an analyzer result whose analyte has never had a control run', async () => {
    const order = await toAccessioned(await createOrder([A.sodium]));
    const line = order.tests[0];

    const result = await enterResult(line?.id ?? '', {
      valueNumeric: 140,
      unit: 'mmol/L',
      instrumentId: A.instrument,
    });

    // The value is stored — it always is — but it lands held rather than queued.
    expect(result.current_status).toBe('qc_hold');

    const refused = await call({
      method: 'POST',
      url: '/api/v1/lab/results/verify',
      token: senior.token,
      payload: { resultIds: [result.id] },
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json<{ detail: string }>().detail).toMatch(/quality control does not permit/i);
  });

  it('reports never_evaluated as not releasable on the QC dashboard', async () => {
    const state = await call({
      method: 'GET',
      url: `/api/v1/lab/qc/state?instrumentId=${A.instrument}&testKey=${A.sodium}`,
      token: tech.token,
    });
    expect(state.statusCode, state.body).toBe(200);
    // There is no row at all for sodium on this instrument, and absence means
    // exactly what an explicit `never_evaluated` means.
    expect(state.json<{ items: unknown[] }>().items).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a Westgard violation blocks the run, and only a Director gets past it', () => {
  let goodRunId: string;
  let heldResultId: string;

  it('records an in-control run and lets a result through', async () => {
    const run = await call({
      method: 'POST',
      url: '/api/v1/lab/qc/runs',
      token: tech.token,
      payload: {
        instrumentId: A.instrument,
        testKey: A.creatinine,
        qcMaterialId: A.qcMaterial,
        level: 'l1',
        value: 88,
        unit: 'umol/L',
      },
    });
    expect(run.statusCode, run.body).toBe(201);
    const view = run.json<LabQcRunBody>();
    expect(view.status).toBe('in_control');
    expect(view.state).toBe('in_control');
    expect(view.permits_release).toBe(true);
    goodRunId = view.id;

    const order = await toAccessioned(await createOrder([A.creatinine]));
    const result = await enterResult(order.tests[0]?.id ?? '', {
      valueNumeric: 85,
      unit: 'umol/L',
      instrumentId: A.instrument,
    });
    expect(result.current_status).toBe('unverified');

    const verified = await call({
      method: 'POST',
      url: '/api/v1/lab/results/verify',
      token: senior.token,
      payload: { resultIds: [result.id] },
    });
    expect(verified.statusCode, verified.body).toBe(201);
  });

  it('rejects the run on a 1-3s violation and locks the analyte out', async () => {
    const run = await call({
      method: 'POST',
      url: '/api/v1/lab/qc/runs',
      token: tech.token,
      payload: {
        instrumentId: A.instrument,
        testKey: A.creatinine,
        qcMaterialId: A.qcMaterial,
        level: 'l1',
        // mean 88, sd 4 → z = +3.5
        value: 102,
        unit: 'umol/L',
      },
    });
    expect(run.statusCode, run.body).toBe(201);
    const view = run.json<LabQcRunBody>();
    expect(view.violated_rules).toContain('r_1_3s');
    expect(view.has_rejection).toBe(true);
    expect(view.state).toBe('out_of_control');
    expect(view.permits_release).toBe(false);

    const events = (await outboxRowsForTrace(run.headers['x-trace-id'])).map((e) => e['event_type']);
    expect(events).toContain('lab.qc.violation');
    expect(events).toContain('labq.qc.out_of_control');
  });

  it('refuses to release a result for the locked-out analyte', async () => {
    const order = await toAccessioned(await createOrder([A.creatinine]));
    const result = await enterResult(order.tests[0]?.id ?? '', {
      valueNumeric: 92,
      unit: 'umol/L',
      instrumentId: A.instrument,
    });
    expect(result.current_status).toBe('qc_hold');
    heldResultId = result.id;

    const refused = await call({
      method: 'POST',
      url: '/api/v1/lab/results/verify',
      token: senior.token,
      payload: { resultIds: [heldResultId] },
    });
    expect(refused.statusCode, refused.body).toBe(422);
  });

  it('will not let a bench technician authorise the release', async () => {
    // `labq.qc.release_override` is Lab Director only. A technician holding
    // `labq.qc.action` can record the root cause and cannot open the gate.
    const denied = await call({
      method: 'POST',
      url: '/api/v1/lab/qc/actions',
      token: tech.token,
      reason: 'Reagent lot changed mid-run',
      payload: {
        instrumentId: A.instrument,
        testKey: A.creatinine,
        qcRunId: goodRunId,
        causeCode: 'REAGENT_LOT',
        actionCode: 'RECALIBRATE',
        patientImpact: 'released_with_authorisation',
        affectedResultCount: 1,
        authorisationReason: 'Clinically urgent, results corroborated by a repeat on the backup analyzer',
      },
    });
    expect(denied.statusCode, denied.body).toBe(403);
  });

  it('accepts release only under the Director’s recorded authorisation, named on the result', async () => {
    const action = await call({
      method: 'POST',
      url: '/api/v1/lab/qc/actions',
      token: director.token,
      reason: 'Clinically urgent renal panel; repeat on backup analyzer agrees within 4 %',
      payload: {
        instrumentId: A.instrument,
        testKey: A.creatinine,
        qcRunId: goodRunId,
        causeCode: 'REAGENT_LOT',
        actionCode: 'RECALIBRATE',
        patientImpact: 'released_with_authorisation',
        affectedResultCount: 1,
        authorisationReason: 'Clinically urgent; corroborated by a repeat on the backup analyzer',
      },
    });
    expect(action.statusCode, action.body).toBe(201);
    const actionId = action.json<{ actionId: string }>().actionId;

    const events = (await outboxRowsForTrace(action.headers['x-trace-id'])).map((e) => e['event_type']);
    expect(events).toContain('labq.qc.released_with_authorisation');

    // The same request that was refused, now naming the authorisation. Not a
    // retry: a different request, carrying evidence that did not exist before.
    const released = await call({
      method: 'POST',
      url: '/api/v1/lab/results/verify',
      token: senior.token,
      payload: { resultIds: [heldResultId], qcOverrideActionId: actionId },
    });
    expect(released.statusCode, released.body).toBe(201);
    expect(released.json<{ results: { current_status: string }[] }>().results[0]?.current_status).toBe(
      'verified',
    );
  });

  it('lifts the lockout only against a passing control and a documented action', async () => {
    const lockout = await pg
      .pool('migrator')
      .query(
        `SELECT id FROM lab.labq_qc_lockouts WHERE test_key = $1 AND unlocked_at IS NULL ORDER BY locked_at DESC LIMIT 1`,
        [A.creatinine],
      );
    const lockoutId = lockout.rows[0]?.id as string | undefined;
    expect(lockoutId).toBeDefined();

    const action = await call({
      method: 'POST',
      url: '/api/v1/lab/qc/actions',
      token: tech.token,
      reason: 'New calibrator lot loaded and verified',
      payload: {
        instrumentId: A.instrument,
        testKey: A.creatinine,
        lockoutId,
        causeCode: 'CALIBRATION_DRIFT',
        actionCode: 'RECALIBRATE',
        patientImpact: 'retest_selected',
        affectedResultCount: 1,
      },
    });
    expect(action.statusCode, action.body).toBe(201);
    const correctiveActionId = action.json<{ actionId: string }>().actionId;

    // A lockout lifted against the run that failed is a lockout lifted by
    // clicking, so the failing run is refused here.
    const failingRun = await pg
      .pool('migrator')
      .query(
        `SELECT id FROM lab.labq_qc_runs WHERE test_key = $1 AND status = 'out_of_control' ORDER BY run_at DESC LIMIT 1`,
        [A.creatinine],
      );
    const badRunId = failingRun.rows[0]?.id as string;

    const refused = await call({
      method: 'POST',
      url: `/api/v1/lab/qc/lockouts/${lockoutId}/unlock`,
      token: tech.token,
      reason: 'Recalibrated and repeated the control',
      payload: {
        reason: 'Recalibrated and repeated the control',
        unlockQcRunId: badRunId,
        correctiveActionId,
      },
    });
    expect(refused.statusCode, refused.body).toBe(422);

    const repeat = await call({
      method: 'POST',
      url: '/api/v1/lab/qc/runs',
      token: tech.token,
      payload: {
        instrumentId: A.instrument,
        testKey: A.creatinine,
        qcMaterialId: A.qcMaterial,
        level: 'l1',
        value: 88.4,
        unit: 'umol/L',
      },
    });
    expect(repeat.statusCode, repeat.body).toBe(201);
    const repeatId = repeat.json<LabQcRunBody>().id;

    const unlocked = await call({
      method: 'POST',
      url: `/api/v1/lab/qc/lockouts/${lockoutId}/unlock`,
      token: tech.token,
      reason: 'Recalibrated; control repeated and in control',
      payload: {
        reason: 'Recalibrated; control repeated and in control',
        unlockQcRunId: repeatId,
        correctiveActionId,
      },
    });
    expect(unlocked.statusCode, unlocked.body).toBe(201);
    expect(unlocked.json<{ state: string }>().state).toBe('in_control');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a rejected specimen, and the recollection that traces back to it', () => {
  it('rejects with a coded reason, refuses a result, and links the replacement', async () => {
    const order = await toAccessioned(await createOrder([A.potassium]));
    const rejectedSampleId = order.samples[0]?.id ?? '';
    const barcode = order.samples[0]?.barcode ?? '';
    const originalLineId = order.tests[0]?.id ?? '';

    const rejected = await call({
      method: 'POST',
      url: `/api/v1/lab/samples/${encodeURIComponent(barcode)}/reject`,
      token: phleb.token,
      reason: 'Gross haemolysis on receipt',
      payload: { rejectionReasonKey: A.rejectHaemolysed, note: 'Visible haemolysis, potassium unusable' },
    });
    expect(rejected.statusCode, rejected.body).toBe(201);
    const view = rejected.json<{ status: string; rejection_reason_code: string | null }>();
    expect(view.status).toBe('rejected');
    // Never free text: OP-004 §3.2.3 makes the rejection rate a NABL indicator.
    expect(view.rejection_reason_code).toBe('HAEM');

    // A rejected specimen can never carry a result.
    const refused = await call({
      method: 'POST',
      url: '/api/v1/lab/results',
      token: tech.token,
      payload: { results: [{ orderTestId: originalLineId, valueNumeric: 4.2, unit: 'mmol/L' }] },
    });
    expect(refused.statusCode, refused.body).toBe(422);

    // The recollection is on the same order, names the specimen it replaces,
    // and is free by CHECK.
    const reread = await call({
      method: 'GET',
      url: `/api/v1/lab/orders/${order.id}`,
      token: orderer.token,
    });
    const after = reread.json<{
      tests: {
        id: string;
        status: string;
        is_chargeable: boolean;
        recollection_of_order_test_id: string | null;
      }[];
      samples: { id: string; status: string; recollection_of_sample_id: string | null }[];
    }>();

    const original = after.tests.find((t) => t.id === originalLineId);
    expect(original?.status).toBe('recollection_requested');

    const replacementLine = after.tests.find((t) => t.recollection_of_order_test_id === originalLineId);
    expect(replacementLine).toBeDefined();
    expect(replacementLine?.is_chargeable).toBe(false);

    const replacementSample = after.samples.find((s) => s.recollection_of_sample_id === rejectedSampleId);
    expect(replacementSample).toBeDefined();
    expect(replacementSample?.status).toBe('pending');
  });

  it('refuses a rejection with a reason this laboratory does not use', async () => {
    const order = await toAccessioned(await createOrder([A.potassium]));
    const barcode = order.samples[0]?.barcode ?? '';

    const refused = await call({
      method: 'POST',
      url: `/api/v1/lab/samples/${encodeURIComponent(barcode)}/reject`,
      token: phleb.token,
      reason: 'Looked wrong',
      payload: { rejectionReasonKey: newId() },
    });
    expect(refused.statusCode, refused.body).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('results are append-only, hash-chained and amendable', () => {
  it('amends into a new version, keeps the original, and the chain still verifies', async () => {
    const order = await toAccessioned(await createOrder([A.potassium]));
    const result = await enterResult(order.tests[0]?.id ?? '', { valueNumeric: 4.2, unit: 'mmol/L' });

    await call({
      method: 'POST',
      url: '/api/v1/lab/results/verify',
      token: senior.token,
      payload: { resultIds: [result.id] },
    });
    const authorised = await call({
      method: 'POST',
      url: '/api/v1/lab/results/authorise',
      token: pathologist.token,
      payload: { resultIds: [result.id] },
    });
    expect(authorised.statusCode, authorised.body).toBe(201);

    const amended = await call({
      method: 'POST',
      url: `/api/v1/lab/results/${result.id}/amend`,
      token: pathologist.token,
      reason: 'Re-run on a fresh aliquot after a dilution error was found',
      payload: {
        reason: 'Re-run on a fresh aliquot after a dilution error was found',
        valueNumeric: 4.9,
        unit: 'mmol/L',
      },
    });
    expect(amended.statusCode, amended.body).toBe(201);
    const head = amended.json<{ current_version: number; value_numeric: number; amendment_reason: string }>();
    expect(head.current_version).toBe(2);
    expect(head.value_numeric).toBe(4.9);
    expect(head.amendment_reason).toMatch(/dilution error/);

    const events = (await outboxRowsForTrace(amended.headers['x-trace-id'])).map((e) => e['event_type']);
    expect(events).toContain('lab.result.amended');

    // Version 1 is still there, marked amended, with its original value.
    const versions = await pg.pool('migrator').query(
      `SELECT version, status::text AS status, value_numeric::text AS value_numeric,
                superseded_by_version
           FROM lab.lab_result_versions WHERE result_id = $1 ORDER BY version`,
      [result.id],
    );
    expect(versions.rows).toHaveLength(2);
    expect(versions.rows[0]?.value_numeric).toBe('4.200000');
    expect(versions.rows[0]?.status).toBe('amended');
    expect(versions.rows[0]?.superseded_by_version).toBe(2);

    // And the chain the database re-derives from scratch still holds.
    const chain = await call({
      method: 'GET',
      url: `/api/v1/lab/results/${result.id}/chain`,
      token: pathologist.token,
    });
    expect(chain.statusCode, chain.body).toBe(200);
    const links = chain.json<{ links: { version: number; hash_matches: boolean; link_matches: boolean }[] }>()
      .links;
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.hash_matches).toBe(true);
      expect(link.link_matches).toBe(true);
    }
  });

  it('refuses a verifier who entered the result — segregation of duty', async () => {
    const order = await toAccessioned(await createOrder([A.potassium]));
    const line = order.tests[0];

    const entered = await call({
      method: 'POST',
      url: '/api/v1/lab/results',
      token: senior.token,
      payload: { results: [{ orderTestId: line?.id, valueNumeric: 4.4, unit: 'mmol/L' }] },
    });
    expect(entered.statusCode, entered.body).toBe(201);
    const resultId = entered.json<{ results: { id: string }[] }>().results[0]?.id ?? '';

    const refused = await call({
      method: 'POST',
      url: '/api/v1/lab/results/verify',
      token: senior.token,
      payload: { resultIds: [resultId] },
    });
    expect(refused.statusCode, refused.body).toBe(403);
  });

  it('refuses an absurd value at entry rather than flagging it critical', async () => {
    const order = await toAccessioned(await createOrder([A.potassium]));
    const refused = await call({
      method: 'POST',
      url: '/api/v1/lab/results',
      token: tech.token,
      payload: { results: [{ orderTestId: order.tests[0]?.id, valueNumeric: 72, unit: 'mmol/L' }] },
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.body).toMatch(/physically possible/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('confidential analytes', () => {
  it('needs lab.result.sensitive.read, and that key alone', async () => {
    const order = await toAccessioned(await createOrder([A.hiv]));
    const result = await enterResult(order.tests[0]?.id ?? '', {
      resultType: 'qualitative',
      valueCoded: 'Non-reactive',
    });

    const denied = await call({
      method: 'GET',
      url: `/api/v1/lab/results/${result.id}`,
      token: tech.token,
    });
    expect(denied.statusCode, denied.body).toBe(403);

    // The pathologist holds the key, and it carries a mandatory reason.
    const noReason = await call({
      method: 'GET',
      url: `/api/v1/lab/results/${result.id}`,
      token: pathologist.token,
    });
    expect(noReason.statusCode, noReason.body).toBe(403);

    const allowed = await call({
      method: 'GET',
      url: `/api/v1/lab/results/${result.id}`,
      token: pathologist.token,
      reason: 'Reviewing the serology before counselling the patient',
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json<{ value_coded: string }>().value_coded).toBe('Non-reactive');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the report', () => {
  it('is issued from authorised lines and leaves the order open over a live critical', async () => {
    const order = await toAccessioned(await createOrder([A.potassium]));
    const result = await enterResult(order.tests[0]?.id ?? '', { valueNumeric: 6.9, unit: 'mmol/L' });

    const tooEarly = await call({
      method: 'POST',
      url: `/api/v1/lab/reports/${order.id}/generate`,
      token: pathologist.token,
      payload: { type: 'final' },
    });
    expect(tooEarly.statusCode, tooEarly.body).toBe(422);

    await call({
      method: 'POST',
      url: '/api/v1/lab/results/verify',
      token: senior.token,
      payload: { resultIds: [result.id] },
    });

    const alerts = await call({
      method: 'GET',
      url: `/api/v1/lab/critical-values?open=true&patientId=${patientA}`,
      token: pathologist.token,
    });
    const alert = alerts
      .json<{ items: { id: string; result_id: string }[] }>()
      .items.find((a) => a.result_id === result.id);

    await call({
      method: 'POST',
      url: `/api/v1/lab/critical-values/${alert?.id}/notify`,
      token: pathologist.token,
      payload: {
        outcome: 'read_back_confirmed',
        method: 'phone',
        notifiedToName: 'Dr Anita Rao',
        readBackValue: '6.9 mmol/L',
      },
    });
    await call({
      method: 'POST',
      url: '/api/v1/lab/results/authorise',
      token: pathologist.token,
      payload: { resultIds: [result.id] },
    });

    const report = await call({
      method: 'POST',
      url: `/api/v1/lab/reports/${order.id}/generate`,
      token: pathologist.token,
      payload: { type: 'final' },
    });
    expect(report.statusCode, report.body).toBe(201);
    const view = report.json<{ report_no: string; current_version: number; verify_token: string | null }>();
    expect(view.current_version).toBe(1);
    expect(view.verify_token).toBeTruthy();
    expect(view.report_no).toContain(order.accession_no);

    // The alert is communicated but not yet acknowledged by the clinician, so
    // the order stays on the follow-up list even though the report is out.
    const status = await pg
      .pool('migrator')
      .query(`SELECT status::text AS status FROM lab.lab_orders WHERE id = $1`, [order.id]);
    expect(status.rows[0]?.status).toBe('partially_reported');

    await call({
      method: 'POST',
      url: `/api/v1/lab/critical-values/${alert?.id}/acknowledge`,
      token: pathologist.token,
      payload: { note: 'Seen; potassium-lowering treatment started' },
    });

    const second = await call({
      method: 'POST',
      url: `/api/v1/lab/reports/${order.id}/generate`,
      token: pathologist.token,
      payload: { type: 'final', amendmentReason: 'Reissued after the clinician acknowledged the critical' },
    });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json<{ current_version: number }>().current_version).toBe(2);

    const closed = await pg
      .pool('migrator')
      .query(`SELECT status::text AS status FROM lab.lab_orders WHERE id = $1`, [order.id]);
    expect(closed.rows[0]?.status).toBe('reported');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the bench worklist', () => {
  it('pages without overlap and meets its class-B budget on a real plan', async () => {
    // Its own pending work, so the test does not depend on what ran before it.
    for (let i = 0; i < 6; i += 1) await toAccessioned(await createOrder([A.potassium]));

    const first = await call({
      method: 'GET',
      url: '/api/v1/lab/worklists/bench?discipline=biochemistry&stage=pending&limit=5',
      token: tech.token,
    });
    expect(first.statusCode, first.body).toBe(200);
    const page1 = first.json<{ items: { id: string }[]; nextCursor: string | null }>();
    expect(page1.items.length).toBeGreaterThan(0);

    if (page1.nextCursor !== null) {
      const second = await call({
        method: 'GET',
        url: `/api/v1/lab/worklists/bench?discipline=biochemistry&stage=pending&limit=5&cursor=${encodeURIComponent(page1.nextCursor)}`,
        token: tech.token,
      });
      const page2 = second.json<{ items: { id: string }[] }>();
      const overlap = page2.items.filter((i) => page1.items.some((j) => j.id === i.id));
      expect(overlap).toHaveLength(0);
    }

    // Measured as `hms_app` with a complete tenant context. As the schema owner
    // RLS is bypassed by ownership, so a plan taken as `hms_migrator` is a plan
    // for a query the application never runs.
    const client = await pg.pool('app').connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.hospital_id', $1, true)`, [tenants.hospitalA]);
      await client.query(`SELECT set_config('app.branch_ids', $1, true)`, [`{${tenants.branchA}}`]);
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [tech.userId]);
      await client.query(`SELECT set_config('app.scope', 'branch', true)`);

      const explained = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS)
         SELECT ot.id, ot.order_id, o.accession_no, o.patient_id, ot.test_code, ot.test_name,
                ot.discipline::text, ot.priority::text, ot.status::text, ot.sample_id,
                s.sample_no, s.barcode, ot.tat_due_at, s.received_at,
                COALESCE(ot.tat_due_at, 'infinity'::timestamptz) AS cursor_key
           FROM lab.lab_order_tests ot
           JOIN lab.lab_orders o ON o.id = ot.order_id
           LEFT JOIN lab.lab_samples s ON s.id = ot.sample_id
          WHERE ot.discipline = 'biochemistry'::mdm."LabDiscipline"
            AND ot.status IN ('pending', 'collected', 'received', 'in_progress')
          ORDER BY ot.tat_due_at, ot.id
          LIMIT 26`,
      );
      const plan = explained.rows.map((r) => r['QUERY PLAN']).join('\n');
      const executionMs = Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1] ?? '0');
      // `docs/07 §2.1` class B is 150 ms p95 for the whole request; the query
      // itself must be a small fraction of that, and this fixture is tiny — so
      // the assertion is a smoke alarm for a plan that has gone quadratic, not a
      // benchmark. The plan text itself is what the report quotes.
      expect(executionMs).toBeLessThan(150);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

interface LabQcRunBody {
  readonly id: string;
  readonly status: string;
  readonly state: string;
  readonly permits_release: boolean;
  readonly violated_rules: string[];
  readonly has_rejection: boolean;
}
