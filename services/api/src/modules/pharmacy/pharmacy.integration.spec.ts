import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module.js';
import { INVENTORY_CONTROLLERS, INVENTORY_PROVIDERS } from '../inventory/inventory.module.js';
import { PHARMACY_CONTROLLERS, PHARMACY_PROVIDERS } from './pharmacy.module.js';

/**
 * OP-003 and EN-029 against a real PostgreSQL 17, with the real Phase-4
 * migration and the real Phase-2 CDSS engine.
 *
 * The suite exists for the four properties `phase-04` says a pharmacy counter
 * must have, and each is asserted by **breaking** it:
 *
 *  1. **Never dispense without a successful batch validation.** An expired
 *     batch is refused at the counter, and the same movement is refused at the
 *     database on a path no service guards.
 *  2. **A Schedule H drug cannot be sold over the counter** — refused by the
 *     service with the rule cited, and by `pharmacy.enforce_dispense_line` when
 *     the service is bypassed entirely.
 *  3. **A narcotic needs two pharmacists**, and the second is a credential
 *     rather than an identifier: the same person, a wrong password and a
 *     pharmacist without the authority are all refused, and the statutory
 *     register refuses a single-signature row even by direct insert.
 *  4. **The CDSS re-check at the counter is not skippable.** A documented
 *     high-criticality allergy blocks completion with no request shape that
 *     turns it off; only a recorded reason gets past it, and the reason is
 *     stored.
 *
 * Plus: the register is append-only, a custody variance cannot be filed without
 * an incident and cannot be closed by typing, a day close is refused over one,
 * and a recall quarantines the batch before anybody produces a patient list.
 */

let pg: TestPostgres;
let app: NestFastifyApplication;
let tenants: TenantFixture;

const PASSWORD = 'Correct-Horse-Battery-9!';
const SECOND_PASSWORD = 'Second-Pharmacist-Pass-7!';

interface Actor {
  readonly userId: string;
  readonly roleId: string;
  readonly username: string;
  readonly password: string;
  token: string;
}

const actor = (username: string, password = PASSWORD): Actor => ({
  userId: newId(),
  roleId: newId(),
  username,
  password,
  token: '',
});

/** The dispensing pharmacist. Holds the NDPS grants; cannot use them alone. */
const pharmacist = actor('ph-pharmacist');
/** The second pharmacist. Holds the same NDPS grants and their own password. */
const second = actor('ph-second', SECOND_PASSWORD);
/** A pharmacist who may dispense but holds no controlled-drug authority. */
const junior = actor('ph-junior');
/** Stores: approves the adjustment that closes a narcotic variance. */
const manager = actor('ph-manager');
/** The prescriber, for a substitution decision. */
const doctor = actor('ph-doctor');
/** One unrelated key: the 403 case. */
const clerk = actor('ph-clerk');
/** The same pharmacy role, in the other hospital: the 404 case. */
const pharmacistB = actor('ph-pharmacist-bravo');

const PHARMACIST_KEYS = [
  'pharmacy.queue.read',
  'pharmacy.queue.list',
  'pharmacy.queue.manage',
  'pharmacy.dispense.create',
  'pharmacy.dispense.complete',
  'pharmacy.dispense.read',
  'pharmacy.dispense.list',
  'pharmacy.dispense.cancel',
  'pharmacy.substitution.request',
  'pharmacy.substitution.read',
  'pharmacy.label.print',
  'pharmacy.return.create',
  'pharmacy.stock.read',
  'pharmacy.stock.list',
  'pharmacy.expiry.read',
  'pharmacy.expiry.manage',
  'pharmacy.recall.read',
  'pharmacy.recall.manage',
  'pharmacy.recall.trace',
  'pharmacy.narcotic.read',
  'pharmacy.narcotic.list',
  'pharmacy.narcotic.prepare',
  'inventory.adjustment.approve',
  'inventory.adjustment.read',
  // Granted, never decorated: `permission.decorator.ts` refuses these on a
  // route, and `PharmacyCoSignService` asserts them with the co-signer attached.
  'pharmacy.narcotic.dispense',
  'pharmacy.narcotic.issue',
  'pharmacy.narcotic.custody',
  'pharmacy.narcotic.destroy',
  'pharmacy.day_close.read',
  'pharmacy.day_close.list',
  'pharmacy.day_close.complete',
  'pharmacy.intervention.record',
  'pharmacy.coldchain.record',
  'inventory.item.read',
  'inventory.batch.read',
  'inventory.batch.list',
  'inventory.stock.read',
];

const JUNIOR_KEYS = [
  'pharmacy.dispense.create',
  'pharmacy.dispense.complete',
  'pharmacy.dispense.read',
  'pharmacy.narcotic.prepare',
  'inventory.item.read',
];

const SECOND_KEYS = [...PHARMACIST_KEYS];

const MANAGER_KEYS = [
  'inventory.adjustment.create',
  'inventory.adjustment.approve',
  'inventory.adjustment.read',
  'inventory.item.read',
  'inventory.stock.read',
  'pharmacy.return.approve',
  'pharmacy.return.read',
];

const DOCTOR_KEYS = ['rx.substitution.approve', 'pharmacy.substitution.read'];
const CLERK_KEYS = ['patient.record.read'];

const A = {
  uomTab: newId(),
  uomStrip: newId(),
  uomMl: newId(),
  category: newId(),
  store: newId(),
  pharmacyStore: newId(),
  paraDrug: newId(),
  amoxDrug: newId(),
  morphDrug: newId(),
  paraItem: newId(),
  amoxItem: newId(),
  morphItem: newId(),
  paraBatch: newId(),
  paraExpiredBatch: newId(),
  amoxBatch: newId(),
  morphBatch: newId(),
  patient: newId(),
  allergicPatient: newId(),
  prescription: newId(),
  prescriptionItem: newId(),
  allergicRx: newId(),
  allergicRxItem: newId(),
  narcoticRx: newId(),
  narcoticRxItem: newId(),
};

const B = { uomTab: newId(), category: newId(), store: newId(), pharmacyStore: newId(), item: newId() };

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
  branchId: string | null,
  key: string,
  pattern: string,
  gapless = false,
): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO core.numbering_series
       (id, hospital_id, branch_id, key, pattern, scope, fy, current_value, gapless,
        reset_policy, version, effective_from, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, 0, $7,
             'never', 1, now() - interval '1 day', true, now(), now())`,
    [newId(), hospitalId, branchId, key, pattern, branchId === null ? 'hospital' : 'branch', gapless],
  );
}

async function seedActor(
  hospitalId: string,
  branchId: string,
  who: Actor,
  permissionKeys: readonly string[],
): Promise<void> {
  const pool = pg.pool('migrator');
  const hash = await argon2.hash(who.password, {
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

/** The drug master the CDSS engine reads. Same rows the prescriber wrote against. */
async function seedDrug(
  recordKey: string,
  hospitalId: string,
  code: string,
  genericName: string,
  schedule: string,
  atc: string,
): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO mdm.mdm_drugs
       (id, record_key, hospital_id, version, code, generic_name, molecules, atc_code, form, route,
        strength_text, schedule, effective_from, status, updated_at)
     VALUES ($1, $2, $3, 1, $4, $5::varchar, ARRAY[$5::text]::text[], $6, 'tablet'::mdm."MdmDoseForm",
             'oral'::mdm."MdmDrugRoute", '500 mg', $7::mdm."MdmDrugSchedule",
             now() - interval '1 year', 'active'::mdm."MdmRecordStatus", now())`,
    [newId(), recordKey, hospitalId, code, genericName, atc, schedule],
  );
}

async function seedItem(
  id: string,
  hospitalId: string,
  code: string,
  name: string,
  schedule: string,
  options: { drugKey?: string; narcotic?: boolean; genericName?: string } = {},
): Promise<void> {
  // One transaction: `trg_items_default_uoms` is DEFERRABLE INITIALLY DEFERRED,
  // so it fires at COMMIT. Separate statements would commit the item before its
  // ladder exists and the default dispense UoM would be refused.
  const client = await pg.pool('migrator').connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO inventory.items
         (id, hospital_id, code, name, generic_name, drug_key, category_id, item_type, base_uom_id,
          dispense_uom_id, hsn_code, schedule, is_narcotic, tracking, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'drug'::inventory."InvItemType", $8,
               $8, '3004', $9::mdm."MdmDrugSchedule", $10,
               'batch_expiry'::inventory."InvTracking", 'active'::inventory."InvMasterStatus", now())`,
      [
        id,
        hospitalId,
        code,
        name,
        options.genericName ?? name,
        options.drugKey ?? null,
        A.category,
        A.uomTab,
        schedule,
        options.narcotic ?? false,
      ],
    );
    await client.query(
      `INSERT INTO inventory.item_uoms
         (id, hospital_id, item_id, uom_id, pack_level, factor_to_base, is_base, is_dispense_default,
          updated_at)
       VALUES ($1, $2, $3, $4, 'base'::mdm."MdmPackLevel", 1, true, true, now())`,
      [newId(), hospitalId, id, A.uomTab],
    );
    await client.query(
      `INSERT INTO inventory.item_uoms
         (id, hospital_id, item_id, uom_id, pack_level, factor_to_base, is_base, updated_at)
       VALUES ($1, $2, $3, $4, 'inner'::mdm."MdmPackLevel", 10, false, now())`,
      [newId(), hospitalId, id, A.uomStrip],
    );
    await client.query(
      `INSERT INTO inventory.item_prices
         (id, hospital_id, item_id, price_kind, unit_price, effective_from, updated_at)
       VALUES ($1, $2, $3, 'sale', 2.50, current_date, now())`,
      [newId(), hospitalId, id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedBatch(
  id: string,
  hospitalId: string,
  itemId: string,
  batchNo: string,
  expiry: string,
): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO inventory.item_batches
       (id, hospital_id, item_id, batch_no, expiry_date, mrp, unit_cost, status, received_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::date, 2.50, 1.80,
             'active'::inventory."InvBatchStatus", now() - interval '30 days', now())`,
    [id, hospitalId, itemId, batchNo, expiry],
  );
}

/** Opening stock, written as the schema owner so the fixture needs no API call. */
async function seedOpening(
  hospitalId: string,
  branchId: string,
  storeId: string,
  itemId: string,
  batchId: string,
  qty: number,
): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO inventory.stock_ledger
       (id, hospital_id, branch_id, store_id, item_id, batch_id, movement_type, qty_base, qty_entered,
        uom_id, unit_cost, ref_type, ref_id, moved_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'opening', $7, $7, $8, 1.80, 'opening', $9, now())`,
    [newId(), hospitalId, branchId, storeId, itemId, batchId, qty, A.uomTab, newId()],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// harness
// ─────────────────────────────────────────────────────────────────────────────

async function login(hospitalId: string, who: Actor): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { hospitalId, identifier: who.username, password: who.password },
  });
  const body = res.json<{ accessToken?: string }>();
  if (typeof body.accessToken !== 'string') {
    throw new Error(`login failed for ${who.username}: ${res.statusCode} ${res.body}`);
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
  if (options.method === 'POST' || options.method === 'PUT') {
    headers['idempotency-key'] = options.idempotencyKey ?? newId();
  }
  return app.inject({
    method: options.method,
    url: options.url,
    headers,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

async function outboxRows(eventType: string): Promise<Array<Record<string, unknown>>> {
  const result = await pg.pool('migrator').query(
    `SELECT id, event_type, aggregate_id, payload, contains_phi, retention_days
       FROM core.outbox_events WHERE event_type = $1 ORDER BY occurred_at DESC`,
    [eventType],
  );
  return result.rows as Array<Record<string, unknown>>;
}

async function balance(storeId: string, batchId: string): Promise<number> {
  const { rows } = await pg.pool('migrator').query<{ qty: string }>(
    `SELECT COALESCE(sum(qty_on_hand), 0)::text AS qty FROM inventory.stock_balances
        WHERE store_id = $1 AND batch_id = $2`,
    [storeId, batchId],
  );
  return Number(rows[0]?.qty ?? 0);
}

/**
 * The application as it ships, plus both Phase-4 modules.
 *
 * Pharmacy depends on `modules/inventory` for the ledger, so both are declared
 * — and both are skipped once `AppModule` declares them itself, or Fastify
 * would refuse with `FST_ERR_DUPLICATED_ROUTE` before a single test ran.
 */
const appControllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as unknown[];
const pharmacyWired = appControllers.includes(PHARMACY_CONTROLLERS[0]);
const inventoryWired = appControllers.includes(INVENTORY_CONTROLLERS[0]);

@Module({
  imports: [AppModule],
  controllers: [
    ...(pharmacyWired ? [] : PHARMACY_CONTROLLERS),
    ...(inventoryWired ? [] : INVENTORY_CONTROLLERS),
  ],
  providers: [...(pharmacyWired ? [] : PHARMACY_PROVIDERS), ...(inventoryWired ? [] : INVENTORY_PROVIDERS)],
})
class PharmacyTestModule {}

// ─────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'PHR' });
  await syncPermissionCatalogue();
  const pool = pg.pool('migrator');

  for (const [hospitalId, branchId] of [
    [tenants.hospitalA, tenants.branchA],
    [tenants.hospitalB, tenants.branchB],
  ] as const) {
    await defineSeries(hospitalId, null, 'ITEM', 'ITM{SEQ:6}');
    for (const [key, prefix] of [
      ['DISP', 'DSP'],
      ['PHRET', 'PHR'],
      ['ADJ', 'ADJ'],
      ['ISSUE', 'ISS'],
      ['CONS', 'CON'],
    ] as const) {
      await defineSeries(hospitalId, branchId, key, `${prefix}{SEQ:6}`);
    }
    // The controlled-drug serial is gapless: an inspector reads the sequence.
    await defineSeries(hospitalId, branchId, 'NARC_REG', 'NDPS{SEQ:5}', true);
  }

  await seedActor(tenants.hospitalA, tenants.branchA, pharmacist, PHARMACIST_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, second, SECOND_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, junior, JUNIOR_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, manager, MANAGER_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, doctor, DOCTOR_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, clerk, CLERK_KEYS);
  await seedActor(tenants.hospitalB, tenants.branchB, pharmacistB, PHARMACIST_KEYS);

  for (const [hospitalId, keys] of [
    [tenants.hospitalA, A],
    [tenants.hospitalB, B],
  ] as const) {
    await pool.query(
      `INSERT INTO mdm.mdm_uoms (id, hospital_id, code, name, dimension, is_dimension_base, updated_at)
       VALUES ($1, $2, 'TAB', 'Tablet', 'count'::mdm."MdmUomDimension", true, now())`,
      [keys.uomTab, hospitalId],
    );
    await pool.query(
      `INSERT INTO mdm.mdm_item_categories (id, hospital_id, code, name, path, updated_at)
       VALUES ($1, $2, 'DRUG', 'Drugs', '/DRUG', now())`,
      [keys.category, hospitalId],
    );
    await pool.query(
      `INSERT INTO mdm.mdm_hsn_codes (id, hospital_id, code, description, updated_at)
       VALUES ($1, $2, '3004', 'Medicaments', now())`,
      [newId(), hospitalId],
    );
  }
  await pool.query(
    `INSERT INTO mdm.mdm_uoms (id, hospital_id, code, name, dimension, updated_at)
     VALUES ($1, $2, 'STRIP', 'Strip of 10', 'count'::mdm."MdmUomDimension", now())`,
    [A.uomStrip, tenants.hospitalA],
  );
  await pool.query(
    `INSERT INTO mdm.mdm_uoms (id, hospital_id, code, name, dimension, is_dimension_base, updated_at)
     VALUES ($1, $2, 'ML', 'Millilitre', 'volume'::mdm."MdmUomDimension", true, now())`,
    [A.uomMl, tenants.hospitalA],
  );

  // A counter that holds narcotics, with a live drug licence and a live NDPS
  // recognition — both of which `pharmacy.enforce_dispense_line` checks.
  for (const [hospitalId, branchId, storeId, pharmacyStoreId] of [
    [tenants.hospitalA, tenants.branchA, A.store, A.pharmacyStore],
    [tenants.hospitalB, tenants.branchB, B.store, B.pharmacyStore],
  ] as const) {
    await pool.query(
      `INSERT INTO inventory.stores
         (id, hospital_id, branch_id, code, name, store_type, holds_narcotics, updated_at)
       VALUES ($1, $2, $3, 'PH1', 'Main pharmacy', 'pharmacy'::inventory."InvStoreType", true, now())`,
      [storeId, hospitalId, branchId],
    );
    await pool.query(
      `INSERT INTO pharmacy.pharmacy_stores
         (id, hospital_id, branch_id, store_id, code, name, pharmacy_type, licence_no,
          licence_valid_to, ndps_licence_no, ndps_licence_valid_to, updated_at)
       VALUES ($1, $2, $3, $4, 'PH1', 'Main pharmacy counter',
               'op_retail'::pharmacy."PhStoreType", 'KA-20-0001', current_date + 365,
               'NDPS-RMI-0001', current_date + 365, now())`,
      [pharmacyStoreId, hospitalId, branchId, storeId],
    );
  }

  await seedDrug(A.paraDrug, tenants.hospitalA, 'PARA', 'Paracetamol', 'otc', 'N02BE01');
  await seedDrug(A.amoxDrug, tenants.hospitalA, 'AMOX', 'Amoxicillin', 'h', 'J01CA04');
  await seedDrug(A.morphDrug, tenants.hospitalA, 'MORPH', 'Morphine', 'ndps_narcotic', 'N02AA01');

  await seedItem(A.paraItem, tenants.hospitalA, 'PARA500', 'Paracetamol 500 mg', 'otc', {
    drugKey: A.paraDrug,
    genericName: 'Paracetamol',
  });
  await seedItem(A.amoxItem, tenants.hospitalA, 'AMOX250', 'Amoxicillin 250 mg', 'h', {
    drugKey: A.amoxDrug,
    genericName: 'Amoxicillin',
  });
  await seedItem(A.morphItem, tenants.hospitalA, 'MORPH10', 'Morphine 10 mg', 'ndps_narcotic', {
    drugKey: A.morphDrug,
    narcotic: true,
    genericName: 'Morphine',
  });

  await seedBatch(A.paraBatch, tenants.hospitalA, A.paraItem, 'PARA-LIVE', '2029-12-31');
  await seedBatch(A.paraExpiredBatch, tenants.hospitalA, A.paraItem, 'PARA-DEAD', '2026-01-31');
  await seedBatch(A.amoxBatch, tenants.hospitalA, A.amoxItem, 'AMOX-LIVE', '2029-12-31');
  await seedBatch(A.morphBatch, tenants.hospitalA, A.morphItem, 'MORPH-LIVE', '2029-12-31');

  await seedOpening(tenants.hospitalA, tenants.branchA, A.store, A.paraItem, A.paraBatch, 500);
  await seedOpening(tenants.hospitalA, tenants.branchA, A.store, A.paraItem, A.paraExpiredBatch, 100);
  await seedOpening(tenants.hospitalA, tenants.branchA, A.store, A.amoxItem, A.amoxBatch, 200);
  await seedOpening(tenants.hospitalA, tenants.branchA, A.store, A.morphItem, A.morphBatch, 60);

  // EN-029 §3.5: a tenant with no active `local_formulary` release is a
  // *degraded* CDSS, and `CdssService` refuses to prescribe or dispense through
  // one. Seeding a minimal release is what makes the engine usable here — and
  // the 503 it returns without one is itself the correct behaviour.
  const kbRelease = newId();
  await pool.query(
    `INSERT INTO clinical.cdss_kb_releases
       (id, hospital_id, provider, release_version, status, loaded_at, updated_at)
     VALUES ($1, $2, 'local_formulary'::clinical."CdssKbProvider", '2026.08',
             'active'::clinical."CdssKbStatus", now(), now())`,
    [kbRelease, tenants.hospitalA],
  );
  await pool.query(
    `INSERT INTO clinical.cdss_kb_dose_rules
       (id, hospital_id, kb_release_id, drug_key_kind, drug_key, population, basis,
        min_dose, max_dose, unit, max_daily)
     VALUES ($1, $2, $3, 'atc', 'N02BE01', 'adult'::clinical."CdssPopulation",
             'flat'::clinical."CdssDoseBasis", 250, 1000, 'mg', 4000)`,
    [newId(), tenants.hospitalA, kbRelease],
  );

  // The register's own opening balance. Without it the first dispense would
  // take the page negative, which `pharmacy.compute_register_balance` refuses —
  // correctly: a register whose first entry is an issue has no provenance.
  await pool.query(
    `INSERT INTO pharmacy.controlled_drug_register
       (id, hospital_id, branch_id, store_id, register_type, serial_no, fy, item_id, batch_id,
        txn_type, uom_id, qty_in_base, qty_out_base, balance_after_base,
        first_auth_user_id, second_auth_user_id, remarks, entered_at)
     VALUES ($1, $2, $3, $4, 'ndps'::pharmacy."PhRegisterType", 'NDPS00000', '2026-27', $5, $6,
             'opening'::pharmacy."PhRegisterTxnType", $7, 60, 0, 0, $8, $9,
             'Opening balance at go-live, counted by two pharmacists.', now())`,
    [
      newId(),
      tenants.hospitalA,
      tenants.branchA,
      A.store,
      A.morphItem,
      A.morphBatch,
      A.uomTab,
      pharmacist.userId,
      second.userId,
    ],
  );

  await seedPatient(A.patient, tenants.hospitalA, tenants.branchA, 'PHRA00001');
  await seedPatient(A.allergicPatient, tenants.hospitalA, tenants.branchA, 'PHRA00002');

  // A documented, high-criticality allergy: `evaluateSafetyFloor` turns it into
  // a hard stop, which is what the counter must not be able to click past.
  await pool.query(
    `INSERT INTO patient.allergies
       (id, hospital_id, patient_id, category, substance_text, reaction, criticality, severity,
        status, verification, recorded_by, updated_at)
     VALUES ($1, $2, $3, 'drug'::patient."PatientAllergyCategory", 'Amoxicillin',
             ARRAY['anaphylaxis']::text[], 'high'::patient."PatientAllergyCriticality",
             'critical'::patient."PatientAlertSeverity", 'active'::patient."PatientAllergyStatus",
             'confirmed', $4, now())`,
    [newId(), tenants.hospitalA, A.allergicPatient, doctor.userId],
  );

  for (const [rxNo, rxId, itemId, patientId, drugKey, generic] of [
    ['RX-0001', A.prescription, A.prescriptionItem, A.patient, A.paraDrug, 'Paracetamol'],
    ['RX-0002', A.allergicRx, A.allergicRxItem, A.allergicPatient, A.amoxDrug, 'Amoxicillin'],
    ['RX-0003', A.narcoticRx, A.narcoticRxItem, A.patient, A.morphDrug, 'Morphine'],
  ] as const) {
    await pool.query(
      `INSERT INTO clinical.prescriptions
         (id, hospital_id, branch_id, patient_id, doctor_user_id, rx_no, status, signed_at, signed_by,
          sign_method, signer_registration_no, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'signed'::clinical."PrescriptionStatus", now(), $5,
               'system'::clinical."SignMethod", 'KMC-12345', now())`,
      [rxId, tenants.hospitalA, tenants.branchA, patientId, doctor.userId, rxNo],
    );
    await pool.query(
      `INSERT INTO clinical.prescription_items
         (id, hospital_id, prescription_id, line_no, drug_key, generic_name, quantity, quantity_unit,
          schedule_class, status, updated_at)
       VALUES ($1, $2, $3, 1, $4, $5, 10, 'tablet', 'h'::mdm."MdmDrugSchedule",
               'active'::clinical."RxLineStatus", now())`,
      [itemId, tenants.hospitalA, rxId, drugKey, generic],
    );
  }

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(PharmacyTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  pharmacist.token = await login(tenants.hospitalA, pharmacist);
  second.token = await login(tenants.hospitalA, second);
  junior.token = await login(tenants.hospitalA, junior);
  manager.token = await login(tenants.hospitalA, manager);
  doctor.token = await login(tenants.hospitalA, doctor);
  clerk.token = await login(tenants.hospitalA, clerk);
  pharmacistB.token = await login(tenants.hospitalB, pharmacistB);
}, 900_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. the queue and an ordinary dispense
// ─────────────────────────────────────────────────────────────────────────────

describe('the counter', () => {
  const state = { queueId: '', dispenseId: '' };

  it('queues a signed prescription and refuses an unsigned one', async () => {
    const queued = await call({
      method: 'POST',
      url: '/api/v1/pharmacy/queue',
      token: pharmacist.token,
      payload: { prescriptionId: A.prescription, pharmacyStoreId: A.pharmacyStore },
    });
    expect(queued.statusCode, queued.body).toBe(201);
    const view = queued.json<{ id: string; itemCount: number; status: string }>();
    state.queueId = view.id;
    expect(view.itemCount).toBe(1);
    expect(view.status).toBe('pending');

    const received = await outboxRows('pharmacy.rx.received');
    expect(received.length).toBe(1);
    expect(received[0]?.contains_phi).toBe(true);

    // A second call is the relay delivering twice, not a second queue entry.
    const again = await call({
      method: 'POST',
      url: '/api/v1/pharmacy/queue',
      token: pharmacist.token,
      payload: { prescriptionId: A.prescription, pharmacyStoreId: A.pharmacyStore },
    });
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json<{ id: string }>().id).toBe(state.queueId);
  });

  it('records how the patient’s identity was verified', async () => {
    const arrived = await call({
      method: 'POST',
      url: `/api/v1/pharmacy/queue/${state.queueId}/arrive`,
      token: pharmacist.token,
      payload: { identityMethod: 'uhid_scan' },
    });
    expect(arrived.statusCode, arrived.body).toBe(201);
    const view = arrived.json<{ status: string; identityVerified: boolean; identityMethod: string }>();
    expect(view.status).toBe('patient_arrived');
    expect(view.identityVerified).toBe(true);
    expect(view.identityMethod).toBe('uhid_scan');
  });

  it('dispenses from the first-expiring live batch and reduces exactly that batch', async () => {
    const before = await balance(A.store, A.paraBatch);

    const created = await call({
      method: 'POST',
      url: '/api/v1/pharmacy/dispenses',
      token: pharmacist.token,
      payload: {
        pharmacyStoreId: A.pharmacyStore,
        dispenseType: 'rx',
        prescriptionId: A.prescription,
        rxQueueId: state.queueId,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    state.dispenseId = created.json<{ id: string }>().id;

    const line = await call({
      method: 'POST',
      url: `/api/v1/pharmacy/dispenses/${state.dispenseId}/items`,
      token: pharmacist.token,
      payload: {
        itemId: A.paraItem,
        batchId: A.paraBatch,
        qtyEntered: 1,
        uomId: A.uomStrip,
        prescriptionItemId: A.prescriptionItem,
        qtyOrderedBase: 10,
      },
    });
    expect(line.statusCode, line.body).toBe(201);
    expect(line.json<{ items: { qtyBase: string }[] }>().items[0]?.qtyBase).toBe('10.0000');

    const completed = await call({
      method: 'POST',
      url: `/api/v1/pharmacy/dispenses/${state.dispenseId}/complete`,
      token: pharmacist.token,
      payload: { counselling: { counselled: true, language: 'en-IN' } },
    });
    expect(completed.statusCode, completed.body).toBe(201);
    expect(completed.json<{ status: string }>().status).toBe('dispensed');

    expect(await balance(A.store, A.paraBatch)).toBe(before - 10);
    // The expired batch is untouched: FEFO never offered it.
    expect(await balance(A.store, A.paraExpiredBatch)).toBe(100);

    const dispensed = await outboxRows('rx.dispensed');
    expect(dispensed.length).toBe(1);
    const payload = dispensed[0]?.payload as Record<string, unknown>;
    expect(payload['prescriptionId']).toBe(A.prescription);
    expect((payload['lines'] as { batchNo: string }[])[0]?.batchNo).toBe('PARA-LIVE');
    expect(dispensed[0]?.contains_phi).toBe(true);

    // The prescriber sees "dispensed", and the queue entry is closed.
    const { rows } = await pg
      .pool('migrator')
      .query<{ status: string }>(`SELECT status::text AS status FROM clinical.prescriptions WHERE id = $1`, [
        A.prescription,
      ]);
    expect(rows[0]?.status).toBe('dispensed');
  });

  it('refuses a second completion of the same dispense', async () => {
    const again = await call({
      method: 'POST',
      url: `/api/v1/pharmacy/dispenses/${state.dispenseId}/complete`,
      token: pharmacist.token,
      payload: {},
    });
    expect(again.statusCode, again.body).toBe(409);
  });

  it('prints a label in English and one Indian language', async () => {
    const labels = await call({
      method: 'POST',
      url: `/api/v1/pharmacy/dispenses/${state.dispenseId}/labels`,
      token: pharmacist.token,
      payload: { locales: ['en-IN', 'kn'] },
    });
    expect(labels.statusCode, labels.body).toBe(201);
    const printed = labels.json<{ labels: { locale: string; batchNo: string | null }[] }>().labels;
    expect(printed.map((l) => l.locale)).toEqual(['en-IN', 'kn']);
    expect(printed[0]?.batchNo).toBe('PARA-LIVE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. fail closed on the batch
// ─────────────────────────────────────────────────────────────────────────────

describe('an expired batch', () => {
  it('is refused at the counter, by name and by date', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/pharmacy/dispenses',
      token: pharmacist.token,
      payload: {
        pharmacyStoreId: A.pharmacyStore,
        dispenseType: 'otc',
        walkInName: 'Walk-in customer',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const dispenseId = created.json<{ id: string }>().id;

    const refused = await call({
      method: 'POST',
      url: `/api/v1/pharmacy/dispenses/${dispenseId}/items`,
      token: pharmacist.token,
      payload: { itemId: A.paraItem, batchId: A.paraExpiredBatch, qtyEntered: 1, uomId: A.uomTab },
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.body).toContain('expired on 2026-01-31');
  });

  it('is refused at the database, on a path no service guards', async () => {
    // The service check above is the message. This is the guarantee: a movement
    // straight into the ledger from an expired batch is refused by
    // `inventory.enforce_ledger_preconditions`, with no application code
    // involved at all.
    const client = await pg.pool('app').connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.hospital_id', $1, true)`, [tenants.hospitalA]);
      await client.query(`SELECT set_config('app.scope', 'branch', true)`);
      await client.query(`SELECT set_config('app.branch_ids', $1, true)`, [`{${tenants.branchA}}`]);
      await expect(
        client.query(
          `INSERT INTO inventory.stock_ledger
             (id, hospital_id, branch_id, store_id, item_id, batch_id, movement_type, qty_base,
              qty_entered, uom_id, ref_type, ref_id, moved_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'dispense', -5, -5, $7, 'dispense', $8, now())`,
          [
            newId(),
            tenants.hospitalA,
            tenants.branchA,
            A.store,
            A.paraItem,
            A.paraExpiredBatch,
            A.uomTab,
            newId(),
          ],
        ),
      ).rejects.toThrow(/expired on .* and cannot be dispensed or issued/i);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Schedule H over the counter
// ─────────────────────────────────────────────────────────────────────────────

describe('a scheduled drug', () => {
  it('cannot be sold over the counter, and the refusal cites the rule', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/pharmacy/dispenses',
      token: pharmacist.token,
      payload: { pharmacyStoreId: A.pharmacyStore, dispenseType: 'otc', walkInName: 'Walk-in customer' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const dispenseId = created.json<{ id: string }>().id;

    const refused = await call({
      method: 'POST',
      url: `/api/v1/pharmacy/dispenses/${dispenseId}/items`,
      token: pharmacist.token,
      payload: { itemId: A.amoxItem, batchId: A.amoxBatch, qtyEntered: 1, uomId: A.uomStrip },
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.body).toContain('Rule 65(9)(a)');
  });

  it('is refused by the database even when the service is bypassed', async () => {
    const client = await pg.pool('app').connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.hospital_id', $1, true)`, [tenants.hospitalA]);
      await client.query(`SELECT set_config('app.scope', 'branch', true)`);
      await client.query(`SELECT set_config('app.branch_ids', $1, true)`, [`{${tenants.branchA}}`]);

      const dispenseId = newId();
      await client.query(
        `INSERT INTO pharmacy.dispenses
           (id, hospital_id, branch_id, pharmacy_store_id, store_id, dispense_no, dispense_type,
            walk_in_name, status, pharmacist_user_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'otc'::pharmacy."PhDispenseType", 'Direct insert',
                 'draft'::pharmacy."PhDispenseStatus", $7, now())`,
        [
          dispenseId,
          tenants.hospitalA,
          tenants.branchA,
          A.pharmacyStore,
          A.store,
          `RAW-${dispenseId.slice(0, 8)}`,
          pharmacist.userId,
        ],
      );

      await expect(
        client.query(
          `INSERT INTO pharmacy.dispense_items
             (id, hospital_id, dispense_id, line_no, item_id, batch_id, uom_id, qty_entered, qty_base,
              status, updated_at)
           VALUES ($1, $2, $3, 1, $4, $5, $6, 10, 10,
                   'dispensed'::pharmacy."PhDispenseItemStatus", now())`,
          [newId(), tenants.hospitalA, dispenseId, A.amoxItem, A.amoxBatch, A.uomTab],
        ),
      ).rejects.toThrow(/cannot be sold over the counter/i);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. the CDSS re-check at the counter — EN-029
// ─────────────────────────────────────────────────────────────────────────────

describe('the pharmacist as the second safety net', () => {
  const state = { dispenseId: '', alertKey: '', itemLineId: '' };

  it('blocks completion on a documented allergy, with no way to turn the check off', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/pharmacy/dispenses',
      token: pharmacist.token,
      payload: {
        pharmacyStoreId: A.pharmacyStore,
        dispenseType: 'rx',
        prescriptionId: A.allergicRx,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    state.dispenseId = created.json<{ id: string }>().id;

    const line = await call({
      method: 'POST',
      url: `/api/v1/pharmacy/dispenses/${state.dispenseId}/items`,
      token: pharmacist.token,
      payload: {
        itemId: A.amoxItem,
        batchId: A.amoxBatch,
        qtyEntered: 1,
        uomId: A.uomStrip,
        prescriptionItemId: A.allergicRxItem,
        qtyOrderedBase: 10,
      },
    });
    expect(line.statusCode, line.body).toBe(201);
    state.itemLineId = line.json<{ items: { id: string }[] }>().items[0]?.id ?? '';

    // The check runs whether or not anybody asked for it. There is no field on
    // the request that skips it.
    const blocked = await call({
      method: 'POST',
      url: `/api/v1/pharmacy/dispenses/${state.dispenseId}/complete`,
      token: pharmacist.token,
      payload: {},
    });
    expect(blocked.statusCode, blocked.body).toBe(422);
    expect(blocked.body).toContain('Documented allergy to Amoxicillin');
    expect(blocked.body).toContain('second safety net');

    // Nothing moved.
    expect(await balance(A.store, A.amoxBatch)).toBe(200);
  });

  it('names the alert on the line so the counter can see what it is refusing', async () => {
    // The blocked completion rolled its own transaction back — including the
    // alert rows it wrote, which is correct: nothing about that attempt
    // happened. The counter's own check is what commits them.
    const checked = await call({
      method: 'POST',
      url: `/api/v1/pharmacy/dispenses/${state.dispenseId}/cdss-check`,
      token: pharmacist.token,
      payload: {},
    });
    expect(checked.statusCode, checked.body).toBe(201);

    const view = await call({
      method: 'GET',
      url: `/api/v1/pharmacy/dispenses/${state.dispenseId}`,
      token: pharmacist.token,
    });
    expect(view.statusCode, view.body).toBe(200);
    const alerts = view.json<{ items: { alerts: { key: string; interruption: string }[] }[] }>().items[0]
      ?.alerts;
    expect(alerts?.length).toBeGreaterThan(0);
    const hardStop = alerts?.find((a) => a.interruption === 'hard_stop');
    expect(hardStop).toBeDefined();
    state.alertKey = hardStop?.key ?? '';
  });

  it('lets the pharmacist through only with a recorded reason, which is stored', async () => {
    const completed = await call({
      method: 'POST',
      url: `/api/v1/pharmacy/dispenses/${state.dispenseId}/complete`,
      token: pharmacist.token,
      payload: {
        acknowledgements: [
          {
            dispenseItemId: state.itemLineId,
            alertKey: state.alertKey,
            reason:
              'Telephoned Dr Rao; the recorded reaction was a childhood rash, desensitisation documented in 2024. Proceeding under supervision.',
          },
        ],
      },
    });
    expect(completed.statusCode, completed.body).toBe(201);
    expect(completed.json<{ status: string }>().status).toBe('dispensed');
    expect(await balance(A.store, A.amoxBatch)).toBe(190);

    const { rows } = await pg
      .pool('migrator')
      .query<{ cdss_override_reason: string | null }>(
        `SELECT cdss_override_reason FROM pharmacy.dispense_items WHERE id = $1`,
        [state.itemLineId],
      );
    expect(rows[0]?.cdss_override_reason).toContain('Telephoned Dr Rao');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. NDPS dual authorisation — phase-04 exit gate 4
// ─────────────────────────────────────────────────────────────────────────────

describe('a controlled drug', () => {
  const state = { dispenseId: '', registerId: '' };

  it('cannot have a line added before a second pharmacist has signed', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/pharmacy/dispenses',
      token: pharmacist.token,
      payload: {
        pharmacyStoreId: A.pharmacyStore,
        dispenseType: 'rx',
        prescriptionId: A.narcoticRx,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    state.dispenseId = created.json<{ id: string }>().id;

    const refused = await call({
      method: 'POST',
      url: `/api/v1/pharmacy/dispenses/${state.dispenseId}/items`,
      token: pharmacist.token,
      payload: { itemId: A.morphItem, batchId: A.morphBatch, qtyEntered: 5, uomId: A.uomTab },
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.body).toContain('Two signatures from one person are one signature');
  });

  it('refuses the dispensing pharmacist as their own second signature', async () => {
    const sameUser = await call({
      method: 'POST',
      url: `/api/v1/pharmacy/dispenses/${state.dispenseId}/second-authoriser`,
      token: pharmacist.token,
      payload: {
        coSigner: { identifier: pharmacist.username, credentialKind: 'password', credential: PASSWORD },
      },
    });
    expect(sameUser.statusCode, sameUser.body).toBe(403);
    expect(sameUser.body).toContain('cannot be both');
  });

  it('refuses a wrong password, and says the same thing it says for an unknown user', async () => {
    const wrongPassword = await call({
      method: 'POST',
      url: `/api/v1/pharmacy/dispenses/${state.dispenseId}/second-authoriser`,
      token: pharmacist.token,
      payload: {
        coSigner: { identifier: second.username, credentialKind: 'password', credential: 'not-the-password' },
      },
    });
    expect(wrongPassword.statusCode, wrongPassword.body).toBe(403);

    const unknownUser = await call({
      method: 'POST',
      url: `/api/v1/pharmacy/dispenses/${state.dispenseId}/second-authoriser`,
      token: pharmacist.token,
      payload: {
        coSigner: { identifier: 'nobody-at-all', credentialKind: 'password', credential: PASSWORD },
      },
    });
    expect(unknownUser.statusCode).toBe(wrongPassword.statusCode);
    // A co-sign prompt that told them apart would be a staff-directory oracle
    // on a screen operated in front of a queue.
    expect(unknownUser.json<{ detail: string }>().detail).toBe(
      wrongPassword.json<{ detail: string }>().detail,
    );
  });

  it('refuses a second pharmacist who does not hold the authority', async () => {
    const notAuthorised = await call({
      method: 'POST',
      url: `/api/v1/pharmacy/dispenses/${state.dispenseId}/second-authoriser`,
      token: pharmacist.token,
      payload: {
        coSigner: { identifier: junior.username, credentialKind: 'password', credential: PASSWORD },
      },
    });
    expect(notAuthorised.statusCode, notAuthorised.body).toBe(403);
  });

  it('accepts a different, authorised pharmacist and then dispenses under two signatures', async () => {
    const signed = await call({
      method: 'POST',
      url: `/api/v1/pharmacy/dispenses/${state.dispenseId}/second-authoriser`,
      token: pharmacist.token,
      payload: {
        coSigner: { identifier: second.username, credentialKind: 'password', credential: SECOND_PASSWORD },
        note: 'Second pharmacist present at the safe.',
      },
    });
    expect(signed.statusCode, signed.body).toBe(201);
    expect(signed.json<{ secondAuthUserId: string | null }>().secondAuthUserId).toBe(second.userId);

    const line = await call({
      method: 'POST',
      url: `/api/v1/pharmacy/dispenses/${state.dispenseId}/items`,
      token: pharmacist.token,
      payload: { itemId: A.morphItem, batchId: A.morphBatch, qtyEntered: 5, uomId: A.uomTab },
    });
    expect(line.statusCode, line.body).toBe(201);

    const before = await balance(A.store, A.morphBatch);
    const completed = await call({
      method: 'POST',
      url: `/api/v1/pharmacy/dispenses/${state.dispenseId}/complete`,
      token: pharmacist.token,
      payload: {},
    });
    expect(completed.statusCode, completed.body).toBe(201);
    expect(await balance(A.store, A.morphBatch)).toBe(before - 5);
  });

  it('writes the NDPS register entry with both signatures and a derived balance', async () => {
    const register = await call({
      method: 'GET',
      url: `/api/v1/pharmacy/controlled-register?itemId=${A.morphItem}`,
      token: pharmacist.token,
    });
    expect(register.statusCode, register.body).toBe(200);
    const entries = register.json<{
      items: {
        id: string;
        registerType: string;
        txnType: string;
        qtyOutBase: string;
        balanceAfterBase: string;
        firstAuthUserId: string;
        secondAuthUserId: string | null;
        serialNo: string;
      }[];
    }>().items;
    // Newest first: the dispense, then the opening balance.
    expect(entries).toHaveLength(2);
    const entry = entries[0];
    state.registerId = entry?.id ?? '';
    expect(entry?.registerType).toBe('ndps');
    expect(entry?.txnType).toBe('dispense');
    expect(Number(entry?.qtyOutBase)).toBe(5);
    // Derived by the database from the previous row, never supplied.
    expect(Number(entry?.balanceAfterBase)).toBe(55);
    expect(entry?.firstAuthUserId).toBe(pharmacist.userId);
    expect(entry?.secondAuthUserId).toBe(second.userId);
    expect(entry?.serialNo).toMatch(/^NDPS\d{5}$/);

    const events = await outboxRows('pharmacy.narcotic.transaction');
    expect(events.length).toBe(1);
    expect(events[0]?.contains_phi).toBe(true);
    expect(events[0]?.retention_days).toBe(3650);
  });

  it('refuses a single-signature NDPS row even by direct insert', async () => {
    await expect(
      pg.pool('migrator').query(
        `INSERT INTO pharmacy.controlled_drug_register
           (id, hospital_id, branch_id, store_id, register_type, serial_no, fy, item_id, batch_id,
            txn_type, uom_id, qty_in_base, qty_out_base, balance_after_base,
            patient_id, prescriber_name, prescriber_reg_no, first_auth_user_id, second_auth_user_id,
            entered_at)
         VALUES ($1, $2, $3, $4, 'ndps', 'NDPS99999', '2026-27', $5, $6,
                 'receipt', $7, 1, 0, 0, $8, 'Dr Rao', 'KMC-12345', $9, $9, now())`,
        [
          newId(),
          tenants.hospitalA,
          tenants.branchA,
          A.store,
          A.morphItem,
          A.morphBatch,
          A.uomTab,
          A.patient,
          pharmacist.userId,
        ],
      ),
    ).rejects.toThrow(/controlled_drug_register_dual_auth/i);
  });

  it('is an append-only statutory register', async () => {
    const { rows } = await pg.pool('migrator').query<{ priv: string }>(
      `SELECT privilege_type AS priv FROM information_schema.table_privileges
        WHERE grantee = 'hms_app' AND table_schema = 'pharmacy'
          AND table_name = 'controlled_drug_register'`,
    );
    const granted = rows.map((r) => r.priv);
    expect(granted).toContain('INSERT');
    expect(granted).not.toContain('UPDATE');
    expect(granted).not.toContain('DELETE');

    await expect(
      pg
        .pool('migrator')
        .query(`UPDATE pharmacy.controlled_drug_register SET qty_out_base = 1 WHERE id = $1`, [
          state.registerId,
        ]),
    ).rejects.toThrow(/statutory register/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. the custody count, the variance, and the day close
// ─────────────────────────────────────────────────────────────────────────────

describe('the controlled-drug safe', () => {
  const state = { adjustmentId: '', checkId: '' };
  const businessDate = new Date().toISOString().slice(0, 10);

  it('cannot record a discrepancy without escalating it', async () => {
    const refused = await call({
      method: 'POST',
      url: '/api/v1/pharmacy/custody-checks',
      token: pharmacist.token,
      payload: {
        storeId: A.store,
        itemId: A.morphItem,
        batchId: A.morphBatch,
        shiftLabel: 'night',
        // The register says 55; the safe holds 50.
        physicalCountEntered: 50,
        uomId: A.uomTab,
        coSigner: { identifier: second.username, credentialKind: 'password', credential: SECOND_PASSWORD },
      },
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.body).toContain('the only way to record it is to escalate it');
  });

  it('refuses a count that cites an adjustment nobody has approved', async () => {
    const raised = await call({
      method: 'POST',
      url: '/api/v1/inventory/adjustments',
      token: manager.token,
      reason: 'Controlled-drug shortage found at the shift count.',
      payload: {
        storeId: A.store,
        adjustmentType: 'minus',
        reasonCode: 'SAFE_SHORTAGE',
        reason: 'Five morphine tablets unaccounted for at the shift count (INC-2026-0007).',
        lines: [{ itemId: A.morphItem, batchId: A.morphBatch, qtyEntered: 5, uomId: A.uomTab }],
      },
    });
    expect(raised.statusCode, raised.body).toBe(201);
    state.adjustmentId = raised.json<{ id: string }>().id;
    expect(raised.json<{ status: string }>().status).toBe('pending_approval');

    const tooEarly = await call({
      method: 'POST',
      url: '/api/v1/pharmacy/custody-checks',
      token: pharmacist.token,
      payload: {
        storeId: A.store,
        itemId: A.morphItem,
        batchId: A.morphBatch,
        shiftLabel: 'night',
        physicalCountEntered: 50,
        uomId: A.uomTab,
        incidentRef: 'INC-2026-0007',
        explanation: 'Five tablets short at the shift change; escalated to the pharmacy manager.',
        adjustmentId: state.adjustmentId,
        coSigner: { identifier: second.username, credentialKind: 'password', credential: SECOND_PASSWORD },
      },
    });
    expect(tooEarly.statusCode, tooEarly.body).toBe(422);
    expect(tooEarly.body).toContain('waiting for a second signature');
  });

  it('files the count once the adjustment is posted, and moves the register with the shelf', async () => {
    // The manager raised it, so somebody else posts it.
    const posted = await call({
      method: 'POST',
      url: `/api/v1/inventory/adjustments/${state.adjustmentId}/approve`,
      token: pharmacist.token,
      reason: 'Shortage confirmed at a witnessed recount under incident INC-2026-0007.',
      payload: {},
    });
    expect(posted.statusCode, posted.body).toBe(201);
    expect(posted.json<{ status: string }>().status).toBe('posted');
    expect(await balance(A.store, A.morphBatch)).toBe(50);

    const recorded = await call({
      method: 'POST',
      url: '/api/v1/pharmacy/custody-checks',
      token: pharmacist.token,
      payload: {
        storeId: A.store,
        itemId: A.morphItem,
        batchId: A.morphBatch,
        shiftLabel: 'night',
        physicalCountEntered: 50,
        uomId: A.uomTab,
        incidentRef: 'INC-2026-0007',
        explanation: 'Five tablets short at the shift change; escalated to the pharmacy manager.',
        adjustmentId: state.adjustmentId,
        coSigner: { identifier: second.username, credentialKind: 'password', credential: SECOND_PASSWORD },
      },
    });
    expect(recorded.statusCode, recorded.body).toBe(201);
    const view = recorded.json<{
      id: string;
      varianceBase: string;
      checkedBy1: string;
      checkedBy2: string;
    }>();
    state.checkId = view.id;
    expect(Number(view.varianceBase)).toBe(-5);
    expect(view.checkedBy1).toBe(pharmacist.userId);
    expect(view.checkedBy2).toBe(second.userId);

    const events = await outboxRows('pharmacy.custody.variance');
    expect(events.length).toBe(1);
    expect((events[0]?.payload as Record<string, unknown>)['incidentRef']).toBe('INC-2026-0007');

    // The statutory page now agrees with the shelf, signed by both counters.
    const register = await call({
      method: 'GET',
      url: `/api/v1/pharmacy/controlled-register?itemId=${A.morphItem}`,
      token: pharmacist.token,
    });
    const latest = register.json<{
      items: { txnType: string; balanceAfterBase: string; secondAuthUserId: string | null }[];
    }>().items[0];
    expect(latest?.txnType).toBe('adjustment');
    expect(Number(latest?.balanceAfterBase)).toBe(50);
    expect(latest?.secondAuthUserId).toBe(second.userId);
  });

  it('closes the day once nothing is outstanding', async () => {
    const closed = await call({
      method: 'POST',
      url: '/api/v1/pharmacy/day-close',
      token: pharmacist.token,
      payload: { pharmacyStoreId: A.pharmacyStore, businessDate, cashCounted: 0 },
    });
    expect(closed.statusCode, closed.body).toBe(201);
    const view = closed.json<{ status: string; narcoticChecksDone: boolean; dispenseCount: number }>();
    expect(view.status).toBe('closed');
    expect(view.narcoticChecksDone).toBe(true);
    expect(view.dispenseCount).toBeGreaterThan(0);
  });

  it('refuses a day close over a variance that was filed with no adjustment', async () => {
    // Written straight into the table, because the API refuses to create this
    // state — and it must, because `narcotic_custody_checks` has UPDATE revoked
    // and such a row can never acquire an adjustment afterwards. The database
    // gate is what stands if a future path ever writes one.
    await pg.pool('migrator').query(
      `INSERT INTO pharmacy.narcotic_custody_checks
         (id, hospital_id, store_id, item_id, batch_id, shift_label, uom_id,
          system_balance_base, physical_count_base, variance_base, checked_by_1, checked_by_2,
          incident_ref, explanation, checked_at)
       VALUES ($1, $2, $3, $4, $5, 'morning', $6, 50, 48, -2, $7, $8,
               'INC-2026-0009', 'Two tablets unaccounted for; adjustment not yet raised.', now())`,
      [
        newId(),
        tenants.hospitalA,
        A.store,
        A.morphItem,
        A.morphBatch,
        A.uomTab,
        pharmacist.userId,
        second.userId,
      ],
    );

    const refused = await call({
      method: 'POST',
      url: '/api/v1/pharmacy/day-close',
      token: pharmacist.token,
      payload: {
        pharmacyStoreId: A.pharmacyStore,
        businessDate,
        shiftLabel: 'morning',
        cashCounted: 0,
      },
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.body).toContain('unresolved narcotic variance');
  });
});

describe('the controlled-drug safe’s own movements', () => {
  it('takes a receipt into the safe under two signatures, and moves stock with it', async () => {
    const stockBefore = await balance(A.store, A.morphBatch);

    const received = await call({
      method: 'POST',
      url: '/api/v1/pharmacy/controlled-register',
      token: pharmacist.token,
      payload: {
        storeId: A.store,
        itemId: A.morphItem,
        batchId: A.morphBatch,
        txnType: 'receipt',
        qtyEntered: 10,
        uomId: A.uomTab,
        remarks: 'Ten tablets received into the safe from the main store.',
        coSigner: { identifier: second.username, credentialKind: 'password', credential: SECOND_PASSWORD },
      },
    });
    expect(received.statusCode, received.body).toBe(201);
    const entry = received.json<{
      txnType: string;
      qtyInBase: string;
      balanceAfterBase: string;
      secondAuthUserId: string | null;
    }>();
    expect(entry.txnType).toBe('receipt');
    expect(Number(entry.qtyInBase)).toBe(10);
    expect(Number(entry.balanceAfterBase)).toBe(60);
    expect(entry.secondAuthUserId).toBe(second.userId);

    // The register and the shelf move together, or the register is fiction.
    expect(await balance(A.store, A.morphBatch)).toBe(stockBefore + 10);
  });

  it('refuses a receipt with no second pharmacist', async () => {
    const refused = await call({
      method: 'POST',
      url: '/api/v1/pharmacy/controlled-register',
      token: pharmacist.token,
      payload: {
        storeId: A.store,
        itemId: A.morphItem,
        batchId: A.morphBatch,
        txnType: 'receipt',
        qtyEntered: 1,
        uomId: A.uomTab,
        coSigner: { identifier: pharmacist.username, credentialKind: 'password', credential: PASSWORD },
      },
    });
    expect(refused.statusCode, refused.body).toBe(403);
  });

  it('records a witnessed destruction, which needs a reason as well as a witness', async () => {
    const stockBefore = await balance(A.store, A.morphBatch);

    // `pharmacy.narcotic.destroy` is `requiresReason`: the policy engine refuses
    // it without an `x-reason` header, co-signer or not.
    const noReason = await call({
      method: 'POST',
      url: '/api/v1/pharmacy/controlled-destructions',
      token: pharmacist.token,
      payload: {
        storeId: A.store,
        itemId: A.morphItem,
        batchId: A.morphBatch,
        qtyEntered: 2,
        uomId: A.uomTab,
        reason: 'Two tablets dropped and contaminated during preparation.',
        coSigner: { identifier: second.username, credentialKind: 'password', credential: SECOND_PASSWORD },
      },
    });
    expect(noReason.statusCode, noReason.body).toBe(403);

    const destroyed = await call({
      method: 'POST',
      url: '/api/v1/pharmacy/controlled-destructions',
      token: pharmacist.token,
      reason: 'Two tablets dropped and contaminated during preparation; destroyed under witness.',
      payload: {
        storeId: A.store,
        itemId: A.morphItem,
        batchId: A.morphBatch,
        qtyEntered: 2,
        uomId: A.uomTab,
        reason: 'Two tablets dropped and contaminated during preparation.',
        bmwRecordRef: 'BMW-2026-0031',
        coSigner: { identifier: second.username, credentialKind: 'password', credential: SECOND_PASSWORD },
      },
    });
    expect(destroyed.statusCode, destroyed.body).toBe(201);
    const entry = destroyed.json<{ txnType: string; qtyOutBase: string; balanceAfterBase: string }>();
    expect(entry.txnType).toBe('destruction');
    expect(Number(entry.qtyOutBase)).toBe(2);
    expect(Number(entry.balanceAfterBase)).toBe(58);
    expect(await balance(A.store, A.morphBatch)).toBe(stockBefore - 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. recall — phase-04 exit gate 5
// ─────────────────────────────────────────────────────────────────────────────

describe('a recall', () => {
  const state = { recallId: '' };

  it('quarantines the batch before anybody produces a list', async () => {
    const raised = await call({
      method: 'POST',
      url: '/api/v1/pharmacy/recalls',
      token: pharmacist.token,
      payload: {
        source: 'cdsco',
        sourceRef: 'CDSCO/ALERT/2026/119',
        itemId: A.paraItem,
        batchNo: 'PARA-LIVE',
        recallClass: 'class_ii',
        reason: 'Dissolution failure reported in the manufacturer’s own stability testing.',
      },
    });
    expect(raised.statusCode, raised.body).toBe(201);
    state.recallId = raised.json<{ id: string }>().id;

    const { rows } = await pg
      .pool('migrator')
      .query<{ status: string }>(`SELECT status::text AS status FROM inventory.item_batches WHERE id = $1`, [
        A.paraBatch,
      ]);
    expect(rows[0]?.status).toBe('recalled');

    // And it can no longer reach a patient — the same gate as the expired batch.
    const created = await call({
      method: 'POST',
      url: '/api/v1/pharmacy/dispenses',
      token: pharmacist.token,
      payload: { pharmacyStoreId: A.pharmacyStore, dispenseType: 'otc', walkInName: 'Walk-in customer' },
    });
    const refused = await call({
      method: 'POST',
      url: `/api/v1/pharmacy/dispenses/${created.json<{ id: string }>().id}/items`,
      token: pharmacist.token,
      payload: { itemId: A.paraItem, batchId: A.paraBatch, qtyEntered: 1, uomId: A.uomTab },
    });
    expect(refused.statusCode, refused.body).toBe(422);
  });

  it('produces the list of patients who received the batch', async () => {
    const traced = await call({
      method: 'POST',
      url: `/api/v1/pharmacy/recalls/${state.recallId}/trace`,
      token: pharmacist.token,
      payload: {},
    });
    expect(traced.statusCode, traced.body).toBe(201);
    const view = traced.json<{
      recall: { patientsIdentified: number };
      patients: { patientId: string | null; qtyDispensedBase: string }[];
      quarantinedQtyBase: string;
    }>();
    expect(view.recall.patientsIdentified).toBe(1);
    expect(view.patients.map((p) => p.patientId)).toContain(A.patient);
    expect(Number(view.patients[0]?.qtyDispensedBase)).toBe(10);
    expect(Number(view.quarantinedQtyBase)).toBe(490);

    // The event carries counts, never the names: the list is PHI and is read
    // from the trace by somebody holding `pharmacy.recall.trace`.
    const events = await outboxRows('pharmacy.recall.traced');
    expect(events.length).toBe(1);
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload['dispensedPatientCount']).toBe(1);
    expect(Object.keys(payload)).not.toContain('patients');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. tenancy and authorisation
// ─────────────────────────────────────────────────────────────────────────────

describe('tenancy and authorisation', () => {
  it('returns 403 for a role without the key', async () => {
    const denied = await call({
      method: 'GET',
      url: '/api/v1/pharmacy/queue',
      token: clerk.token,
    });
    expect(denied.statusCode, denied.body).toBe(403);
  });

  it('returns 404, not 403, for another hospital’s dispense', async () => {
    const list = await call({
      method: 'GET',
      url: '/api/v1/pharmacy/dispenses',
      token: pharmacist.token,
    });
    const first = list.json<{ items: { id: string }[] }>().items[0];
    expect(first).toBeDefined();

    const crossTenant = await call({
      method: 'GET',
      url: `/api/v1/pharmacy/dispenses/${first?.id}`,
      token: pharmacistB.token,
    });
    expect(crossTenant.statusCode, crossTenant.body).toBe(404);
  });

  it('does not let another hospital read this one’s controlled register', async () => {
    const listed = await call({
      method: 'GET',
      url: '/api/v1/pharmacy/controlled-register',
      token: pharmacistB.token,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<{ items: unknown[] }>().items).toHaveLength(0);
  });
});
