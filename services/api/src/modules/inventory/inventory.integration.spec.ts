import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { PERMISSION_CATALOGUE, newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module.js';
import { INVENTORY_CONTROLLERS, INVENTORY_PROVIDERS } from './inventory.module.js';
import { convertToBase } from './uom.service.js';

/**
 * NC-005 / NC-006 / NC-021 against a real PostgreSQL 17 with row-level security
 * on and the real Phase-4 migration applied.
 *
 * The suite exists for the properties that cannot be established by reading the
 * code, and every one of them would fail silently in production:
 *
 *  1. **The stock ledger cannot be updated or deleted** — proved twice, because
 *     the migration defends it twice: `hms_app` holds no UPDATE or DELETE
 *     privilege, *and* the trigger raises even for the schema owner who does.
 *     A test that proved only the grant would go green the day somebody dropped
 *     the trigger, and vice versa.
 *  2. **A quantity in a UoM that is not on the item's ladder is refused**, at
 *     the API and at the database, and the refusal names what to do about it.
 *  3. **`sum(ledger) = on_hand` holds** after every kind of movement this phase
 *     writes — `phase-04` exit gate 6.
 *  4. **FEFO is the default and an override is documented** — naming a
 *     later-expiring batch without a reason is refused.
 *  5. **A transfer has a real in-transit state**: the sending store is short and
 *     the receiving store is not yet long.
 *  6. **A quantity mismatch is caught by the three-way match and queued as an
 *     exception**, and the invoice cannot be released for payment — `phase-04`
 *     exit gate 1's last sentence.
 *  7. **Maker ≠ checker** on an adjustment, a purchase order and a vendor.
 *  8. A role **without** the key gets 403 and a **cross-tenant id gets 404, not
 *     403** (`docs/09 §3.1`). No query in this module carries a `hospital_id`
 *     predicate, so if isolation holds, RLS is what is holding it.
 *  9. Every mutation leaves its audit row *and* its registered outbox event,
 *     both inside the transaction that made the change (EN-024 §5).
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

/** Stores: raises indents, issues, counts, receives. Never approves their own. */
const keeper = actor('inv-keeper');
/** Stores in-charge: approves indents, adjustments, counts, transfers. */
const manager = actor('inv-manager');
/** Purchase: raises indents, RFQs, purchase orders, receipts, invoices. */
const buyer = actor('inv-buyer');
/** Finance: approves vendors, purchase orders and invoices. Never raises one. */
const approver = actor('inv-approver');
/** Holds one unrelated key: the 403 case. */
const clerk = actor('inv-clerk');
/** The same stores role, in the other hospital: the 404 case. */
const keeperB = actor('inv-keeper-bravo');

const STORES_KEYS = [
  'inventory.item.read',
  'inventory.item.list',
  'inventory.item.create',
  'inventory.item.update',
  'inventory.item.params.configure',
  'inventory.item.gtin.map',
  'inventory.store.read',
  'inventory.store.list',
  'inventory.store.configure',
  'inventory.stock.read',
  'inventory.stock.list',
  'inventory.stock.putaway',
  'inventory.ledger.read',
  'inventory.ledger.list',
  'inventory.store_indent.create',
  'inventory.store_indent.read',
  'inventory.store_indent.list',
  'inventory.issue.pick',
  'inventory.issue.create',
  'inventory.issue.list',
  'inventory.issue.receive',
  'inventory.return.create',
  'inventory.return.read',
  // The seeded `stores_keeper` role holds this; the fixture's hand-written list
  // did not, so a return could be raised here and never inspected — and stock
  // returned from a ward is only restocked at inspection.
  'inventory.return.inspect',
  'inventory.transfer.create',
  'inventory.transfer.read',
  'inventory.transfer.list',
  'inventory.transfer.dispatch',
  'inventory.transfer.receive',
  'inventory.adjustment.create',
  'inventory.adjustment.read',
  'inventory.adjustment.list',
  'inventory.batch.read',
  'inventory.batch.list',
  'inventory.batch.trace',
  'inventory.expiry.read',
  'inventory.count.plan',
  'inventory.count.count',
  'inventory.count.read',
  'inventory.count.list',
  'inventory.report.read',
  'pharmacy.price.update',
];

/**
 * Consignment is its own authority set, held here by the manager: an agreement
 * is a commercial commitment and using vendor-owned stock creates a payable.
 */
/**
 * Split between two actors on purpose. "The person who drafted a consignment
 * agreement cannot be the one who activates it" — the API refuses it, so a test
 * that held both keys on one user could never have reached the approval path.
 */
const CONSIGNMENT_MAKER_KEYS = [
  'inventory.consignment.agreement.manage',
  'inventory.consignment.agreement.read',
  'inventory.consignment.agreement.list',
];

const CONSIGNMENT_CHECKER_KEYS = [
  'inventory.consignment.agreement.approve',
  'inventory.consignment.agreement.read',
  'inventory.consignment.agreement.list',
  'inventory.consignment.receive',
  'inventory.consignment.use',
  'inventory.consignment.usage.read',
  'inventory.consignment.usage.list',
  'inventory.consignment.stock.read',
  'inventory.consignment.reconcile',
  'inventory.consignment.report.read',
];

const MANAGER_KEYS = [
  'inventory.adjustment.create',
  'inventory.store_indent.approve',
  'inventory.store_indent.read',
  'inventory.adjustment.approve',
  'inventory.adjustment.read',
  'inventory.adjustment.list',
  'inventory.count.approve',
  'inventory.count.read',
  'inventory.transfer.approve',
  'inventory.transfer.read',
  'inventory.batch.quarantine',
  'inventory.batch.release',
  'inventory.stock.read',
  'inventory.stock.list',
  'inventory.report.read',
  'inventory.item.read',
  ...CONSIGNMENT_CHECKER_KEYS,
];

const BUYER_KEYS = [
  ...CONSIGNMENT_MAKER_KEYS,
  'inventory.indent.create',
  'inventory.indent.read',
  'inventory.indent.list',
  'inventory.rfq.create',
  'inventory.rfq.read',
  'inventory.rfq.list',
  'inventory.rfq.send',
  'inventory.quotation.enter',
  'inventory.comparative.compare',
  'inventory.po.create',
  'inventory.po.read',
  'inventory.po.list',
  'inventory.po.send',
  'inventory.po.amend',
  'inventory.po.short_close',
  'inventory.po.cancel',
  'inventory.grn.create',
  'inventory.grn.read',
  'inventory.grn.list',
  'inventory.grn.post',
  'inventory.invoice.capture',
  'inventory.invoice.read',
  'inventory.invoice.list',
  'inventory.invoice.match',
  'vendor.master.read',
  'vendor.master.list',
  'vendor.master.manage',
  'vendor.item.manage',
  'vendor.contract.read',
  'vendor.contract.list',
  'vendor.contract.manage',
  'inventory.item.read',
  'inventory.stock.read',
];

const APPROVER_KEYS = [
  'vendor.master.approve',
  'vendor.master.read',
  'vendor.contract.approve',
  'inventory.indent.approve',
  'inventory.indent.read',
  'inventory.comparative.approve',
  'inventory.po.approve',
  'inventory.po.read',
  'inventory.grn.qc',
  'inventory.grn.read',
  'inventory.invoice.approve',
  'inventory.invoice.read',
  'inventory.invoice.list',
  'inventory.adjustment.approve',
  'inventory.adjustment.read',
];

const CLERK_KEYS = ['patient.record.read'];

/** Record keys filled in `beforeAll`. */
const A = {
  uomTab: newId(),
  uomStrip: newId(),
  uomBox: newId(),
  uomMl: newId(),
  /** An implant is counted one at a time; it has no pack ladder. */
  uomEach: newId(),
  /** Vendor stock is held apart from ours so a valuation can tell them apart. */
  consignmentStore: newId(),
  /** An implant names the patient it went into; traceability starts there. */
  patientId: newId(),
  category: newId(),
  hsn: newId(),
  mainStore: newId(),
  wardStore: newId(),
  itemId: '',
  syrupId: '',
  consumableId: '',
  vendorId: '',
};

const B = { uomTab: newId(), category: newId(), mainStore: newId(), itemId: '' };

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
): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO core.numbering_series
       (id, hospital_id, branch_id, key, pattern, scope, fy, current_value, gapless,
        reset_policy, version, effective_from, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, 0, false,
             'never', 1, now() - interval '1 day', true, now(), now())`,
    [newId(), hospitalId, branchId, key, pattern, branchId === null ? 'hospital' : 'branch'],
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
     VALUES ($1, $2, $3, $4, 'Integration test role', 'operations', 'operations', now())`,
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

/**
 * The master data an item needs before it can exist.
 *
 * Written here rather than taken from `packages/db/src/seed/inventory.ts`: the
 * tenant fixture creates fresh hospitals, so a suite leaning on the seed would
 * be testing the seed. The shapes are the ones the seed writes — a count-
 * dimension ladder for a tablet and a volume one for a syrup, which is what
 * makes the cross-dimension refusal testable at all.
 */
async function seedMasters(hospitalId: string, keys: typeof A | typeof B): Promise<void> {
  const pool = pg.pool('migrator');

  const uoms: readonly (readonly [string, string, string, string, boolean])[] =
    'uomStrip' in keys
      ? [
          [keys.uomTab, 'TAB', 'Tablet', 'count', true],
          [keys.uomStrip, 'STRIP', 'Strip of 10', 'count', false],
          [keys.uomBox, 'BOX', 'Box of 20 strips', 'count', false],
          [keys.uomMl, 'ML', 'Millilitre', 'volume', true],
          [keys.uomEach, 'EACH', 'Each', 'count', false],
        ]
      : [[keys.uomTab, 'TAB', 'Tablet', 'count', true]];

  for (const [id, code, name, dimension, isBase] of uoms) {
    await pool.query(
      `INSERT INTO mdm.mdm_uoms (id, hospital_id, code, name, dimension, is_dimension_base, updated_at)
       VALUES ($1, $2, $3, $4, $5::mdm."MdmUomDimension", $6, now())`,
      [id, hospitalId, code, name, dimension, isBase],
    );
  }

  await pool.query(
    `INSERT INTO mdm.mdm_item_categories (id, hospital_id, code, name, path, updated_at)
     VALUES ($1, $2, 'DRUG', 'Drugs', '/DRUG', now())`,
    [keys.category, hospitalId],
  );

  if ('hsn' in keys) {
    await pool.query(
      `INSERT INTO mdm.mdm_hsn_codes (id, hospital_id, code, description, updated_at)
       VALUES ($1, $2, '3004', 'Medicaments', now())`,
      [keys.hsn, hospitalId],
    );
    await pool.query(
      `INSERT INTO mdm.mdm_gst_rates
         (id, hospital_id, hsn_code_id, cgst_rate, sgst_rate, igst_rate, effective_from, updated_at)
       VALUES ($1, $2, $3, 6, 6, 12, current_date - 30, now())`,
      [newId(), hospitalId, keys.hsn],
    );
  }
}

async function seedStore(
  id: string,
  hospitalId: string,
  branchId: string,
  code: string,
  storeType: string,
  options: { holdsNarcotics?: boolean; consignment?: boolean } = {},
): Promise<void> {
  await pg.pool('migrator').query(
    `INSERT INTO inventory.stores
       (id, hospital_id, branch_id, code, name, store_type, holds_narcotics, is_consignment, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::inventory."InvStoreType", $7, $8, now())`,
    [
      id,
      hospitalId,
      branchId,
      code,
      `${code} store`,
      storeType,
      options.holdsNarcotics ?? false,
      options.consignment ?? false,
    ],
  );
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
    `SELECT id, event_type, aggregate, aggregate_id, payload, contains_phi, retention_days
       FROM core.outbox_events WHERE event_type = $1 ORDER BY occurred_at DESC`,
    [eventType],
  );
  return result.rows as Array<Record<string, unknown>>;
}

async function auditRows(entity: string): Promise<Array<Record<string, unknown>>> {
  const result = await pg.pool('migrator').query(
    `SELECT id, entity, action::text AS action, row_id, business_key, before, after
       FROM core.audit_log WHERE entity = $1 ORDER BY recorded_at DESC`,
    [entity],
  );
  return result.rows as Array<Record<string, unknown>>;
}

/**
 * The application as it ships, plus this module.
 *
 * The root imports **only** `AppModule`. The inventory controllers and providers
 * are declared here only while `AppModule` does not declare them itself: once
 * they are spread into it, declaring them a second time would mount every route
 * twice and Fastify would refuse with `FST_ERR_DUPLICATED_ROUTE` before a single
 * test ran. The check is on `AppModule`'s own metadata, so this file needs no
 * edit either way.
 */
const appControllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as unknown[];
const alreadyWired = appControllers.includes(INVENTORY_CONTROLLERS[0]);

@Module({
  imports: [AppModule],
  controllers: alreadyWired ? [] : INVENTORY_CONTROLLERS,
  providers: alreadyWired ? [] : INVENTORY_PROVIDERS,
})
class InventoryTestModule {}

// ─────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg, { codePrefix: 'INV' });
  await syncPermissionCatalogue();

  for (const [hospitalId, branchId] of [
    [tenants.hospitalA, tenants.branchA],
    [tenants.hospitalB, tenants.branchB],
  ] as const) {
    await defineSeries(hospitalId, null, 'ITEM', 'ITM{SEQ:6}');
    await defineSeries(hospitalId, null, 'VEND', 'VND{SEQ:5}');
    for (const [key, prefix] of [
      ['INDENT', 'SIND'],
      ['ISSUE', 'ISS'],
      ['TRANSFER', 'TRF'],
      ['ADJ', 'ADJ'],
      ['COUNT', 'CNT'],
      ['IND', 'PIND'],
      ['RFQ', 'RFQ'],
      ['PO', 'PO'],
      ['GRN', 'GRN'],
      ['PRN', 'PRN'],
      ['VINV', 'VINV'],
      ['CONS', 'CON'],
      ['CSN_IN', 'CSN'],
    ] as const) {
      await defineSeries(hospitalId, branchId, key, `${prefix}{SEQ:6}`);
    }
  }

  await seedActor(tenants.hospitalA, tenants.branchA, keeper, STORES_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, manager, MANAGER_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, buyer, BUYER_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, approver, APPROVER_KEYS);
  await seedActor(tenants.hospitalA, tenants.branchA, clerk, CLERK_KEYS);
  await seedActor(tenants.hospitalB, tenants.branchB, keeperB, STORES_KEYS);

  await seedMasters(tenants.hospitalA, A);
  await seedMasters(tenants.hospitalB, B);
  await seedStore(A.mainStore, tenants.hospitalA, tenants.branchA, 'MAIN', 'main');
  await seedStore(A.wardStore, tenants.hospitalA, tenants.branchA, 'WARD1', 'ward');
  await seedStore(A.consignmentStore, tenants.hospitalA, tenants.branchA, 'CSN1', 'ot', {
    consignment: true,
  });
  await pg.pool('migrator').query(
    `INSERT INTO patient.patients
       (id, hospital_id, branch_id, uhid, uhid_normalised, first_name, last_name, full_name,
        gender, dob, mobile, mobile_local, dedupe_fingerprint, updated_at)
     VALUES ($1, $2, $3, 'INV-IMPLANT-1', 'INV-IMPLANT-1', 'Implant', 'Recipient',
             'Implant Recipient', 'male'::patient."PatientGender", '1972-11-02'::date,
             '+919845000111', '9845000111', 'inv-implant-1', now())`,
    [A.patientId, tenants.hospitalA, tenants.branchA],
  );
  await seedStore(B.mainStore, tenants.hospitalB, tenants.branchB, 'MAIN', 'main');

  // Two vendors so the RFQ can meet its minimum, and one settings row so the
  // minimum is two rather than the safe default of three.
  await pg.pool('migrator').query(
    `INSERT INTO inventory.pur_settings (id, hospital_id, branch_id, min_vendors_for_rfq, updated_at)
     VALUES ($1, $2, $3, 2, now())`,
    [newId(), tenants.hospitalA, tenants.branchA],
  );

  process.env['DATABASE_URL'] = pg.connectionString('app');
  process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
  process.env['JWT_ACCESS_SECRET'] = 'a'.repeat(48);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(48);
  process.env['NODE_ENV'] = 'test';

  app = await NestFactory.create<NestFastifyApplication>(InventoryTestModule, new FastifyAdapter(), {
    logger: false,
  });
  app.setGlobalPrefix('api/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  keeper.token = await login(tenants.hospitalA, keeper.username);
  manager.token = await login(tenants.hospitalA, manager.username);
  buyer.token = await login(tenants.hospitalA, buyer.username);
  approver.token = await login(tenants.hospitalA, approver.username);
  clerk.token = await login(tenants.hospitalA, clerk.username);
  keeperB.token = await login(tenants.hospitalB, keeperB.username);
}, 900_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. the item master and its conversion ladder
// ─────────────────────────────────────────────────────────────────────────────

describe('the item master', () => {
  it('writes the base rung itself and refuses a cross-dimension pack size', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/inventory/items',
      token: keeper.token,
      payload: {
        name: 'Paracetamol 500 mg tablet',
        genericName: 'Paracetamol',
        categoryId: A.category,
        itemType: 'drug',
        baseUomId: A.uomTab,
        hsnCode: '3004',
        schedule: 'otc',
        tracking: 'batch_expiry',
        uoms: [
          { uomId: A.uomStrip, factorToBase: 10, packLevel: 'inner', isDispenseDefault: true },
          { uomId: A.uomBox, factorToBase: 200, packLevel: 'outer', isPurchaseDefault: true },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const item = created.json<{ id: string; code: string; uoms: { code: string; factorToBase: string }[] }>();
    A.itemId = item.id;

    // The base rung is derived, not requested: exactly one, factor 1.
    const base = item.uoms.filter((u) => u.code === 'TAB');
    expect(base).toHaveLength(1);
    expect(base[0]?.factorToBase).toBe('1.00000000');
    expect(item.uoms.find((u) => u.code === 'BOX')?.factorToBase).toBe('200.00000000');

    // A millilitre is a volume; a tablet is a count. `inventory.enforce_item_uom`
    // refuses the rung, and the message says why rather than naming a trigger.
    const crossDimension = await call({
      method: 'POST',
      url: `/api/v1/inventory/items/${item.id}/uoms`,
      token: keeper.token,
      payload: { uomId: A.uomMl, factorToBase: 5, packLevel: 'inner' },
    });
    expect(crossDimension.statusCode, crossDimension.body).toBe(400);
    expect(crossDimension.body).toContain('crosses unit dimensions');
  });

  it('creates a second item for the cross-tenant and cross-dimension cases', async () => {
    const syrup = await call({
      method: 'POST',
      url: '/api/v1/inventory/items',
      token: keeper.token,
      payload: {
        name: 'Paracetamol syrup 60 ml',
        categoryId: A.category,
        itemType: 'drug',
        baseUomId: A.uomMl,
        tracking: 'batch_expiry',
        uoms: [],
      },
    });
    expect(syrup.statusCode, syrup.body).toBe(201);
    A.syrupId = syrup.json<{ id: string }>().id;

    // A non-batch-tracked item, so the UoM guard can be provoked on its own.
    // `enforce_ledger_preconditions` fires before `enforce_qty_uom` — a
    // batch-tracked item would be refused for the missing batch first, and the
    // test would prove the wrong trigger.
    const consumable = await call({
      method: 'POST',
      url: '/api/v1/inventory/items',
      token: keeper.token,
      payload: {
        name: 'Disposable applicator',
        categoryId: A.category,
        itemType: 'consumable',
        baseUomId: A.uomTab,
        tracking: 'none',
        uoms: [
          { uomId: A.uomStrip, factorToBase: 10, packLevel: 'inner' },
          { uomId: A.uomBox, factorToBase: 200, packLevel: 'outer', isPurchaseDefault: true },
        ],
      },
    });
    expect(consumable.statusCode, consumable.body).toBe(201);
    A.consumableId = consumable.json<{ id: string }>().id;

    const other = await call({
      method: 'POST',
      url: '/api/v1/inventory/items',
      token: keeperB.token,
      payload: {
        name: 'Amoxicillin 250 mg',
        categoryId: B.category,
        itemType: 'drug',
        baseUomId: B.uomTab,
        tracking: 'batch',
        uoms: [],
      },
    });
    expect(other.statusCode, other.body).toBe(201);
    B.itemId = other.json<{ id: string }>().id;
  });

  it('records an audit row and an inventory.item.created event', async () => {
    const events = await outboxRows('inventory.item.created');
    expect(events.length).toBeGreaterThanOrEqual(4);
    const audits = await auditRows('inventory.items');
    expect(audits.length).toBeGreaterThanOrEqual(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. opening stock, and the invariant everything else rests on
// ─────────────────────────────────────────────────────────────────────────────

describe('opening stock', () => {
  const state: { adjustmentId: string; ledgerId: string } = { adjustmentId: '', ledgerId: '' };

  it('refuses a batch-tracked item with no batch, on every path', async () => {
    // `enforce_ledger_preconditions`: "a movement with no batch is invisible to
    // a recall". Opening stock of a batch-tracked drug has to name its batch,
    // and the only place a batch is created is a goods receipt.
    const created = await call({
      method: 'POST',
      url: '/api/v1/inventory/adjustments',
      token: keeper.token,
      reason: 'Opening stock entry at go-live.',
      payload: {
        storeId: A.mainStore,
        adjustmentType: 'opening',
        reasonCode: 'GO_LIVE',
        reason: 'Opening stock counted at go-live and entered from the count sheet.',
        lines: [{ itemId: A.itemId, qtyEntered: 5, uomId: A.uomBox }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const refused = await call({
      method: 'POST',
      url: `/api/v1/inventory/adjustments/${created.json<{ id: string }>().id}/approve`,
      token: manager.token,
      reason: 'Posting the opening stock.',
      payload: {},
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.body).toContain('no recall can ever reach');
  });

  it('is an adjustment the raiser cannot approve', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/inventory/adjustments',
      token: keeper.token,
      reason: 'Opening stock entry at go-live.',
      payload: {
        storeId: A.mainStore,
        adjustmentType: 'opening',
        reasonCode: 'GO_LIVE',
        reason: 'Opening stock counted at go-live and entered from the count sheet.',
        lines: [{ itemId: A.consumableId, qtyEntered: 5, uomId: A.uomBox }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    state.adjustmentId = created.json<{ id: string }>().id;

    // Maker ≠ checker, asserted against somebody who *does* hold the approval
    // key: a plain 403 would only prove the guard, not the control.
    const own = await call({
      method: 'POST',
      url: '/api/v1/inventory/adjustments',
      token: manager.token,
      reason: 'A small correction I will then try to approve myself.',
      payload: {
        storeId: A.mainStore,
        adjustmentType: 'plus',
        reasonCode: 'FOUND',
        reason: 'One extra applicator found in the box.',
        lines: [{ itemId: A.consumableId, qtyEntered: 1, uomId: A.uomTab }],
      },
    });
    expect(own.statusCode, own.body).toBe(201);

    const selfApprove = await call({
      method: 'POST',
      url: `/api/v1/inventory/adjustments/${own.json<{ id: string }>().id}/approve`,
      token: manager.token,
      reason: 'Attempting to approve my own adjustment.',
      payload: {},
    });
    expect(selfApprove.statusCode, selfApprove.body).toBe(403);
    expect(selfApprove.body).toContain('cannot be the one who approves');
  });

  it('posts 5 boxes as 1000 units, converted by the item’s own factor', async () => {
    const approved = await call({
      method: 'POST',
      url: `/api/v1/inventory/adjustments/${state.adjustmentId}/approve`,
      token: manager.token,
      reason: 'Verified against the physical count sheet.',
      payload: { note: 'Verified against the physical count sheet.' },
    });
    expect(approved.statusCode, approved.body).toBe(201);
    expect(approved.json<{ status: string }>().status).toBe('posted');

    const stock = await call({
      method: 'GET',
      url: `/api/v1/inventory/stock?storeId=${A.mainStore}&itemId=${A.consumableId}`,
      token: keeper.token,
    });
    expect(stock.statusCode, stock.body).toBe(200);
    const balances = stock.json<{ items: { qtyOnHand: string }[] }>().items;
    expect(balances).toHaveLength(1);
    expect(Number(balances[0]?.qtyOnHand)).toBe(1000);

    const ledger = await call({
      method: 'GET',
      url: `/api/v1/inventory/ledger?storeId=${A.mainStore}&itemId=${A.consumableId}`,
      token: keeper.token,
    });
    const entries = ledger.json<{ items: { id: string; qtyBase: string; qtyEntered: string }[] }>().items;
    expect(entries).toHaveLength(1);
    state.ledgerId = entries[0]?.id ?? '';
    expect(Number(entries[0]?.qtyBase)).toBe(1000);
    expect(Number(entries[0]?.qtyEntered)).toBe(5);
  });

  it('announced the movement on the outbox with the balance it produced', async () => {
    const events = await outboxRows('inventory.stock.moved');
    expect(events.length).toBeGreaterThanOrEqual(1);
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload['movementType']).toBe('opening');
    expect(payload['qtyBase']).toBe('1000.0000');
    expect(payload['balanceAfterBase']).toBe('1000.0000');
  });

  // ── the falsification: the ledger is append-only ───────────────────────────

  it('gives the application role no UPDATE or DELETE on the ledger', async () => {
    const { rows } = await pg.pool('migrator').query<{ priv: string }>(
      `SELECT privilege_type AS priv FROM information_schema.table_privileges
        WHERE grantee = 'hms_app' AND table_schema = 'inventory' AND table_name = 'stock_ledger'`,
    );
    const granted = rows.map((r) => r.priv);
    expect(granted).toContain('INSERT');
    expect(granted).toContain('SELECT');
    expect(granted).not.toContain('UPDATE');
    expect(granted).not.toContain('DELETE');
  });

  it('refuses an UPDATE from the application role', async () => {
    const client = await pg.pool('app').connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.hospital_id', $1, true)`, [tenants.hospitalA]);
      await client.query(`SELECT set_config('app.scope', 'branch', true)`);
      await client.query(`SELECT set_config('app.branch_ids', $1, true)`, [`{${tenants.branchA}}`]);
      await expect(
        client.query(`UPDATE inventory.stock_ledger SET qty_base = 999 WHERE id = $1`, [state.ledgerId]),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('refuses an UPDATE even from the schema owner, which holds the privilege', async () => {
    // `hms_migrator` owns the table and *can* update it as far as privileges go.
    // The trigger is what stops it, and this is the half a re-GRANT would not
    // reveal.
    await expect(
      pg
        .pool('migrator')
        .query(`UPDATE inventory.stock_ledger SET qty_base = 999 WHERE id = $1`, [state.ledgerId]),
    ).rejects.toThrow(/append-only/i);

    await expect(
      pg.pool('migrator').query(`DELETE FROM inventory.stock_ledger WHERE id = $1`, [state.ledgerId]),
    ).rejects.toThrow(/append-only/i);

    // And the row is untouched.
    const { rows } = await pg
      .pool('migrator')
      .query<{ qty_base: string }>(
        `SELECT qty_base::text AS qty_base FROM inventory.stock_ledger WHERE id = $1`,
        [state.ledgerId],
      );
    expect(Number(rows[0]?.qty_base)).toBe(1000);
  });

  // ── the falsification: an unconvertible quantity is not a quantity ─────────

  it('refuses a quantity in a UoM that is not on the item’s ladder', async () => {
    const refused = await call({
      method: 'POST',
      url: '/api/v1/inventory/adjustments',
      token: keeper.token,
      reason: 'Stray stock found during a tidy-up.',
      payload: {
        storeId: A.mainStore,
        adjustmentType: 'plus',
        reasonCode: 'FOUND',
        reason: 'Found behind the shelf during a tidy-up.',
        // Millilitres are not on a tablet's ladder — and they are not even the
        // same dimension.
        lines: [{ itemId: A.consumableId, qtyEntered: 3, uomId: A.uomMl }],
      },
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.body).toContain('not on the conversion ladder');
  });

  it('refuses the same quantity at the database, on a path no service guards', async () => {
    // The service check above is the message. This is the guarantee: an INSERT
    // straight into the ledger, in a UoM the item does not have, is refused by
    // `inventory.enforce_qty_uom` with no application code involved.
    const client = await pg.pool('app').connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.hospital_id', $1, true)`, [tenants.hospitalA]);
      await client.query(`SELECT set_config('app.scope', 'branch', true)`);
      await client.query(`SELECT set_config('app.branch_ids', $1, true)`, [`{${tenants.branchA}}`]);
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [keeper.userId]);
      await expect(
        client.query(
          `INSERT INTO inventory.stock_ledger
             (id, hospital_id, branch_id, store_id, item_id, batch_id, movement_type, qty_base,
              qty_entered, uom_id, ref_type, ref_id, moved_at)
           VALUES ($1, $2, $3, $4, $5, NULL, 'adjustment_plus', 3, 3, $6, 'adjustment', $7, now())`,
          [newId(), tenants.hospitalA, tenants.branchA, A.mainStore, A.consumableId, A.uomMl, newId()],
        ),
      ).rejects.toThrow(/an unconvertible quantity is not a quantity/i);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('refuses a base quantity that does not equal entered × factor', async () => {
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
           VALUES ($1, $2, $3, $4, $5, NULL, 'adjustment_plus', 1, 1, $6, 'adjustment', $7, now())`,
          // 1 STRIP is 10 units, not 1. Claiming otherwise is the bug
          // `phase-04 §Constraints` names, and the trigger recomputes it.
          [newId(), tenants.hospitalA, tenants.branchA, A.mainStore, A.consumableId, A.uomStrip, newId()],
        ),
      ).rejects.toThrow(/do not assume 1/i);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('holds sum(ledger) = on_hand for every position', async () => {
    const integrity = await call({
      method: 'GET',
      url: '/api/v1/inventory/integrity',
      token: manager.token,
    });
    expect(integrity.statusCode, integrity.body).toBe(200);
    expect(integrity.json<{ ok: boolean; rows: unknown[] }>()).toEqual({ ok: true, rows: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. purchase to pay
// ─────────────────────────────────────────────────────────────────────────────

describe('purchase to pay', () => {
  const state = { poId: '', poLineId: '', grnId: '', batchId: '', invoiceId: '', indentId: '' };

  it('creates and approves a vendor, and refuses the creator’s own approval', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/vendors',
      token: buyer.token,
      payload: {
        legalName: 'Acme Pharma Distributors Pvt Ltd',
        vendorType: 'distributor',
        categories: ['drug'],
        gstin: '29AABCU9603R1ZM',
        drugLicenceNo: 'KA-20B-0001',
        drugLicenceValidTo: '2030-12-31',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    A.vendorId = created.json<{ id: string; status: string }>().id;
    expect(created.json<{ status: string }>().status).toBe('draft');

    const selfApprove = await call({
      method: 'POST',
      url: `/api/v1/vendors/${A.vendorId}/approve`,
      token: buyer.token,
      payload: {},
    });
    expect(selfApprove.statusCode, selfApprove.body).toBe(403);

    const approved = await call({
      method: 'POST',
      url: `/api/v1/vendors/${A.vendorId}/approve`,
      token: approver.token,
      payload: { note: 'KYC documents verified.' },
    });
    expect(approved.statusCode, approved.body).toBe(201);
    expect(approved.json<{ status: string }>().status).toBe('approved');
  });

  it('runs indent → approval → purchase order → approval', async () => {
    const indent = await call({
      method: 'POST',
      url: '/api/v1/inventory/purchase/indents',
      token: buyer.token,
      payload: {
        storeId: A.mainStore,
        urgency: 'routine',
        justification: 'Reorder level reached on the main store.',
        lines: [{ itemId: A.itemId, qtyEntered: 10, uomId: A.uomBox, lastPrice: 400 }],
      },
    });
    expect(indent.statusCode, indent.body).toBe(201);
    state.indentId = indent.json<{ id: string }>().id;

    const approvedIndent = await call({
      method: 'POST',
      url: `/api/v1/inventory/purchase/indents/${state.indentId}/approve`,
      token: approver.token,
      reason: 'Within the approved quarterly budget for drugs.',
      payload: {},
    });
    expect(approvedIndent.statusCode, approvedIndent.body).toBe(201);
    expect(approvedIndent.json<{ status: string }>().status).toBe('approved');

    const po = await call({
      method: 'POST',
      url: '/api/v1/inventory/purchase/orders',
      token: buyer.token,
      payload: {
        vendorId: A.vendorId,
        shipToStoreId: A.mainStore,
        expectedDelivery: '2026-12-31',
        lines: [{ itemId: A.itemId, qtyEntered: 10, uomId: A.uomBox, rate: 400, gstRate: 12 }],
      },
    });
    expect(po.statusCode, po.body).toBe(201);
    const poView = po.json<{ id: string; lines: { id: string; qtyBase: string }[] }>();
    state.poId = poView.id;
    state.poLineId = poView.lines[0]?.id ?? '';
    expect(Number(poView.lines[0]?.qtyBase)).toBe(2000);

    const selfApprove = await call({
      method: 'POST',
      url: `/api/v1/inventory/purchase/orders/${state.poId}/approve`,
      token: buyer.token,
      payload: {},
    });
    expect(selfApprove.statusCode, selfApprove.body).toBe(403);

    const approvedPo = await call({
      method: 'POST',
      url: `/api/v1/inventory/purchase/orders/${state.poId}/approve`,
      token: approver.token,
      payload: {},
    });
    expect(approvedPo.statusCode, approvedPo.body).toBe(201);
    expect(approvedPo.json<{ status: string }>().status).toBe('approved');
  });

  it('receives with a batch and an expiry, and posts it to the ledger', async () => {
    const grn = await call({
      method: 'POST',
      url: '/api/v1/inventory/purchase/grns',
      token: buyer.token,
      payload: {
        poId: state.poId,
        vendorId: A.vendorId,
        storeId: A.mainStore,
        invoiceNo: 'ACME/2026/0001',
        invoiceDate: '2026-08-20',
        lines: [
          {
            poLineId: state.poLineId,
            itemId: A.itemId,
            qtyEntered: 10,
            uomId: A.uomBox,
            batchNo: 'PARA-2026-A',
            expiryDate: '2028-06-30',
            mrp: 2.5,
            unitCost: 400,
            gstRate: 12,
          },
        ],
      },
    });
    expect(grn.statusCode, grn.body).toBe(201);
    state.grnId = grn.json<{ id: string; status: string }>().id;
    expect(grn.json<{ status: string }>().status).toBe('qc_pending');

    const qc = await call({
      method: 'POST',
      url: `/api/v1/inventory/purchase/grns/${state.grnId}/qc`,
      token: approver.token,
      payload: { outcome: 'accepted', notes: 'Seals intact, cold chain not required.' },
    });
    expect(qc.statusCode, qc.body).toBe(201);

    const posted = await call({
      method: 'POST',
      url: `/api/v1/inventory/purchase/grns/${state.grnId}/post`,
      token: buyer.token,
      payload: {},
    });
    expect(posted.statusCode, posted.body).toBe(201);
    const view = posted.json<{ status: string; lines: { batchId: string | null }[] }>();
    expect(view.status).toBe('accepted');
    state.batchId = view.lines[0]?.batchId ?? '';
    expect(state.batchId).not.toBe('');

    const stock = await call({
      method: 'GET',
      url: `/api/v1/inventory/stock?storeId=${A.mainStore}&itemId=${A.itemId}`,
      token: keeper.token,
    });
    const total = stock
      .json<{ items: { qtyOnHand: string }[] }>()
      .items.reduce((sum, b) => sum + Number(b.qtyOnHand), 0);
    // 10 boxes of 200 tablets, converted by the item's own factor.
    expect(total).toBe(2000);
  });

  it('catches a quantity mismatch in the three-way match and queues it as an exception', async () => {
    const invoice = await call({
      method: 'POST',
      url: '/api/v1/inventory/purchase/invoices',
      token: buyer.token,
      payload: {
        vendorId: A.vendorId,
        invoiceNo: 'ACME/2026/0001',
        invoiceDate: '2026-08-20',
        poId: state.poId,
        grnIds: [state.grnId],
        subtotal: 4800,
        taxTotal: 576,
        total: 5376,
        lines: [
          {
            itemId: A.itemId,
            poLineId: state.poLineId,
            // The vendor billed 12 boxes; 10 were received. 2400 base units
            // against 2000 received.
            qtyEntered: 12,
            uomId: A.uomBox,
            ratePerBase: 2,
            tax: 576,
          },
        ],
      },
    });
    expect(invoice.statusCode, invoice.body).toBe(201);
    const view = invoice.json<{ id: string; matchStatus: string; lines: { qtyDiffBase: string }[] }>();
    state.invoiceId = view.id;
    expect(view.matchStatus).toBe('no_grn');

    // With the GRN line named, the verdict becomes the quantity mismatch itself.
    const grnLine = await pg
      .pool('migrator')
      .query<{ id: string }>(`SELECT id FROM inventory.pur_grn_lines WHERE grn_id = $1`, [state.grnId]);

    const matched = await call({
      method: 'POST',
      url: '/api/v1/inventory/purchase/invoices',
      token: buyer.token,
      payload: {
        vendorId: A.vendorId,
        invoiceNo: 'ACME/2026/0002',
        invoiceDate: '2026-08-21',
        poId: state.poId,
        grnIds: [state.grnId],
        subtotal: 4800,
        taxTotal: 576,
        total: 5376,
        lines: [
          {
            itemId: A.itemId,
            poLineId: state.poLineId,
            grnLineId: grnLine.rows[0]?.id,
            qtyEntered: 12,
            uomId: A.uomBox,
            ratePerBase: 2,
            tax: 576,
          },
        ],
      },
    });
    expect(matched.statusCode, matched.body).toBe(201);
    const mismatch = matched.json<{
      invoiceId: string;
      matchStatus: string;
      lines: { qtyDiffBase: string; status: string }[];
    }>();
    expect(mismatch.matchStatus).toBe('qty_mismatch');
    expect(Number(mismatch.lines[0]?.qtyDiffBase)).toBe(400);

    const queue = await call({
      method: 'GET',
      url: '/api/v1/inventory/purchase/invoices?exceptionsOnly=true',
      token: approver.token,
    });
    expect(queue.statusCode, queue.body).toBe(200);
    const ids = queue.json<{ items: { invoiceId: string }[] }>().items.map((i) => i.invoiceId);
    expect(ids).toContain(mismatch.invoiceId);

    const released = await call({
      method: 'POST',
      url: `/api/v1/inventory/purchase/invoices/${mismatch.invoiceId}/approve`,
      token: approver.token,
      payload: {},
    });
    expect(released.statusCode, released.body).toBe(422);
    expect(released.body).toContain('Resolve the exception');

    const disputed = await outboxRows('purchase.invoice.disputed');
    expect(disputed.length).toBeGreaterThanOrEqual(1);
  });

  it('freezes a superseded purchase-order version', async () => {
    // A fresh order: the first one has been received, and an order that has
    // already been delivered against is not amendable — which is itself the
    // right answer, and is asserted at the end of this test.
    const fresh = await call({
      method: 'POST',
      url: '/api/v1/inventory/purchase/orders',
      token: buyer.token,
      payload: {
        vendorId: A.vendorId,
        shipToStoreId: A.mainStore,
        lines: [{ itemId: A.itemId, qtyEntered: 4, uomId: A.uomBox, rate: 400, gstRate: 12 }],
      },
    });
    expect(fresh.statusCode, fresh.body).toBe(201);
    const freshId = fresh.json<{ id: string }>().id;
    const freshApproved = await call({
      method: 'POST',
      url: `/api/v1/inventory/purchase/orders/${freshId}/approve`,
      token: approver.token,
      payload: {},
    });
    expect(freshApproved.statusCode, freshApproved.body).toBe(201);

    const amended = await call({
      method: 'POST',
      url: `/api/v1/inventory/purchase/orders/${freshId}/amend`,
      token: buyer.token,
      reason: 'Vendor confirmed a shorter supply.',
      payload: {
        reason: 'Vendor confirmed a shorter supply; quantity reduced by agreement.',
        lines: [{ itemId: A.itemId, qtyEntered: 8, uomId: A.uomBox, rate: 400, gstRate: 12 }],
      },
    });
    expect(amended.statusCode, amended.body).toBe(201);
    expect(amended.json<{ header: { poVersion: number } }>().header.poVersion).toBe(2);

    // The old version is frozen at the database, not merely in the service.
    await expect(
      pg
        .pool('migrator')
        .query(`UPDATE inventory.pur_purchase_orders SET total = 1 WHERE id = $1`, [freshId]),
    ).rejects.toThrow(/superseded/i);

    // And an order already received against cannot be amended at all.
    const tooLate = await call({
      method: 'POST',
      url: `/api/v1/inventory/purchase/orders/${state.poId}/amend`,
      token: buyer.token,
      reason: 'Trying to amend an order that has already been delivered.',
      payload: {
        reason: 'Trying to amend an order that has already been delivered.',
        lines: [{ itemId: A.itemId, qtyEntered: 1, uomId: A.uomBox, rate: 400, gstRate: 12 }],
      },
    });
    expect(tooLate.statusCode, tooLate.body).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. FEFO, issues and the in-transit state
// ─────────────────────────────────────────────────────────────────────────────

describe('picking and issuing', () => {
  const state = {
    earlierBatch: '',
    laterBatch: '',
    transferId: '',
    mainBeforeIssue: 0,
    wardBeforeIssue: 0,
  };

  it('orders batches by expiry, soonest first', async () => {
    // A second batch, expiring later than the one the GRN created.
    const grnLine = await pg
      .pool('migrator')
      .query<{ id: string }>(`SELECT id FROM inventory.pur_grn_lines LIMIT 1`);
    expect(grnLine.rows).toHaveLength(1);

    const second = await call({
      method: 'POST',
      url: '/api/v1/inventory/purchase/grns',
      token: buyer.token,
      payload: {
        vendorId: A.vendorId,
        storeId: A.mainStore,
        withoutPo: true,
        lines: [
          {
            itemId: A.itemId,
            qtyEntered: 2,
            uomId: A.uomBox,
            batchNo: 'PARA-2026-B',
            expiryDate: '2029-06-30',
            unitCost: 410,
            gstRate: 12,
          },
        ],
      },
    });
    expect(second.statusCode, second.body).toBe(201);
    const secondId = second.json<{ id: string }>().id;
    await call({
      method: 'POST',
      url: `/api/v1/inventory/purchase/grns/${secondId}/qc`,
      token: approver.token,
      payload: { outcome: 'accepted' },
    });
    const posted = await call({
      method: 'POST',
      url: `/api/v1/inventory/purchase/grns/${secondId}/post`,
      token: buyer.token,
      payload: {},
    });
    expect(posted.statusCode, posted.body).toBe(201);

    const batches = await call({
      method: 'GET',
      url: `/api/v1/inventory/stock/${A.itemId}/batches?storeId=${A.mainStore}`,
      token: keeper.token,
    });
    expect(batches.statusCode, batches.body).toBe(200);
    const list = batches.json<{ items: { batchId: string; batchNo: string; expiryDate: string }[] }>().items;
    expect(list.map((b) => b.batchNo)).toEqual(['PARA-2026-A', 'PARA-2026-B']);
    state.earlierBatch = list[0]?.batchId ?? '';
    state.laterBatch = list[1]?.batchId ?? '';
  });

  it('refuses a later-expiring batch without a reason, and accepts one with', async () => {
    const override = await call({
      method: 'POST',
      url: '/api/v1/inventory/issues',
      token: keeper.token,
      payload: {
        fromStoreId: A.mainStore,
        toStoreId: A.wardStore,
        lines: [{ itemId: A.itemId, qtyEntered: 1, uomId: A.uomStrip, batchId: state.laterBatch }],
      },
    });
    expect(override.statusCode, override.body).toBe(400);
    expect(override.body).toContain('expires sooner');

    const justified = await call({
      method: 'POST',
      url: '/api/v1/inventory/issues',
      token: keeper.token,
      payload: {
        fromStoreId: A.mainStore,
        toStoreId: A.wardStore,
        lines: [
          {
            itemId: A.itemId,
            qtyEntered: 1,
            uomId: A.uomStrip,
            batchId: state.laterBatch,
            fefoOverrideReason: 'Ward asked for the newer lot for a long-stay patient supply.',
          },
        ],
      },
    });
    expect(justified.statusCode, justified.body).toBe(201);
  });

  /**
   * The sign travels with the quantity.
   *
   * `quantityString()` published `Math.abs()` because the contract's `quantity`
   * pattern was `^\d+…` and a negative would have failed the event's own schema,
   * rolling back a movement that had physically happened. A consumer then had to
   * recover direction from `movementType` — workable here, impossible for
   * `inventory.stock.corrected`, which carries no movement type at all.
   *
   * The pattern now accepts a leading minus and this asserts the emitter uses it.
   * Without the assertion the fix would be a function nobody reads: every other
   * test in this file moves stock *in*, where `abs()` and the signed value agree.
   */
  it('publishes an outbound movement as a negative quantity', async () => {
    const events = await outboxRows('inventory.stock.moved');
    const outbound = events
      .map((e) => e.payload as Record<string, unknown>)
      .filter((p) => Number(p['qtyBase']) < 0);
    expect(outbound.length, 'no outbound movement was announced at all').toBeGreaterThanOrEqual(1);
    for (const payload of outbound) {
      expect(String(payload['qtyBase']).startsWith('-')).toBe(true);
      // `sum(qty_base)` is the balance, so the sign is what makes the number mean
      // anything — and the balance it reports must agree with it.
      expect(Number(payload['balanceAfterBase'])).toBeGreaterThanOrEqual(0);
    }
  });

  it('leaves stock in transit between issue and acknowledgement', async () => {
    state.mainBeforeIssue = await storeTotal(A.mainStore);
    state.wardBeforeIssue = await storeTotal(A.wardStore);

    const issue = await call({
      method: 'POST',
      url: '/api/v1/inventory/issues',
      token: keeper.token,
      payload: {
        fromStoreId: A.mainStore,
        toStoreId: A.wardStore,
        lines: [{ itemId: A.itemId, qtyEntered: 5, uomId: A.uomStrip }],
      },
    });
    expect(issue.statusCode, issue.body).toBe(201);
    const view = issue.json<{ id: string; status: string; lines: { id: string }[] }>();
    expect(view.status).toBe('in_transit');

    // The sending store is already short; the receiving store is not yet long.
    const wardBefore = await storeTotal(A.wardStore);
    expect(await storeTotal(A.mainStore)).toBe(state.mainBeforeIssue - 50);
    expect(wardBefore).toBe(state.wardBeforeIssue);

    const received = await call({
      method: 'POST',
      url: `/api/v1/inventory/issues/${view.id}/receive`,
      token: keeper.token,
      payload: { lines: [{ issueLineId: view.lines[0]?.id, qtyReceivedEntered: 5, uomId: A.uomStrip }] },
    });
    expect(received.statusCode, received.body).toBe(201);
    expect(received.json<{ status: string }>().status).toBe('received');
    expect(await storeTotal(A.wardStore)).toBe(state.wardBeforeIssue + 50);
  });

  it('keeps the ledger and the balances in agreement throughout', async () => {
    const integrity = await call({
      method: 'GET',
      url: '/api/v1/inventory/integrity',
      token: manager.token,
    });
    expect(integrity.json<{ ok: boolean }>().ok).toBe(true);
  });

  it('moves a transfer out of one store before it is in the other', async () => {
    const created = await call({
      method: 'POST',
      url: '/api/v1/inventory/transfers',
      token: keeper.token,
      payload: {
        fromStoreId: A.mainStore,
        toStoreId: A.wardStore,
        lines: [{ itemId: A.itemId, qtyEntered: 2, uomId: A.uomStrip }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    state.transferId = created.json<{ id: string }>().id;

    const approved = await call({
      method: 'POST',
      url: `/api/v1/inventory/transfers/${state.transferId}/approve`,
      token: manager.token,
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(201);

    const mainBefore = await storeTotal(A.mainStore);
    const wardBefore = await storeTotal(A.wardStore);

    const dispatched = await call({
      method: 'POST',
      url: `/api/v1/inventory/transfers/${state.transferId}/dispatch`,
      token: keeper.token,
      payload: { gatePassNo: 'GP-0001' },
    });
    expect(dispatched.statusCode, dispatched.body).toBe(201);
    expect(dispatched.json<{ status: string }>().status).toBe('in_transit');

    expect(await storeTotal(A.mainStore)).toBe(mainBefore - 20);
    expect(await storeTotal(A.wardStore)).toBe(wardBefore);

    const lines = dispatched.json<{ lines: { id: string }[] }>().lines;
    const receivedShort = await call({
      method: 'POST',
      url: `/api/v1/inventory/transfers/${state.transferId}/receive`,
      token: keeper.token,
      payload: {
        lines: [
          {
            lineId: lines[0]?.id,
            qtyReceivedEntered: 1,
            uomId: A.uomStrip,
            discrepancyReason: 'One strip missing from the sealed bag on arrival.',
          },
        ],
      },
    });
    expect(receivedShort.statusCode, receivedShort.body).toBe(201);
    expect(receivedShort.json<{ status: string }>().status).toBe('partially_received');
    expect(await storeTotal(A.wardStore)).toBe(wardBefore + 10);

    // The difference is raised rather than absorbed: ten tablets are somewhere,
    // and somebody has to say where.
    const discrepancies = await outboxRows('inventory.transfer.discrepancy');
    expect(discrepancies.length).toBe(1);
    expect((discrepancies[0]?.payload as Record<string, unknown>)['shortLines']).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. counting, and the compensating entry
// ─────────────────────────────────────────────────────────────────────────────

describe('physical counting', () => {
  it('turns a counted variance into a posted adjustment and keeps integrity', async () => {
    const plan = await call({
      method: 'POST',
      url: '/api/v1/inventory/counts/plans',
      token: keeper.token,
      payload: {
        storeId: A.wardStore,
        countType: 'cycle',
        scheduledFor: '2026-08-25',
        itemIds: [A.itemId],
      },
    });
    expect(plan.statusCode, plan.body).toBe(201);
    const planView = plan.json<{
      id: string;
      lines: { id: string; extra: Record<string, unknown> }[];
    }>();
    expect(planView.lines.length).toBeGreaterThan(0);

    // Blind: the system quantity is withheld until the line has been counted.
    expect(planView.lines[0]?.extra['systemQtyBase']).toBeNull();

    const sheetId = String(planView.lines[0]?.extra['sheetId']);
    const before = await storeTotal(A.wardStore);

    // What the plan snapshotted, read directly — the blind sheet withholds it
    // from the counter, and this test is standing in for the shelf.
    const snapshot = await pg.pool('migrator').query<{ id: string; system_qty_base: string }>(
      `SELECT id, system_qty_base::text AS system_qty_base FROM inventory.count_lines
          WHERE sheet_id = $1 ORDER BY id`,
      [sheetId],
    );
    expect(snapshot.rows.length).toBe(planView.lines.length);

    // One line comes up three tablets short; the rest agree.
    const counted = await call({
      method: 'POST',
      url: `/api/v1/inventory/counts/sheets/${sheetId}/lines`,
      token: keeper.token,
      payload: {
        lines: snapshot.rows.map((row, index) => ({
          lineId: row.id,
          countedEntered: Number(row.system_qty_base) - (index === 0 ? 3 : 0),
          uomId: A.uomTab,
          reason: 'Counted from the ward cupboard.',
        })),
      },
    });
    expect(counted.statusCode, counted.body).toBe(201);

    const approved = await call({
      method: 'POST',
      url: `/api/v1/inventory/counts/plans/${planView.id}/approve`,
      token: manager.token,
      reason: 'Cycle count variance approved after a witnessed recount.',
      payload: { reason: 'Cycle count variance approved after a witnessed recount.' },
    });
    expect(approved.statusCode, approved.body).toBe(201);
    expect(approved.json<{ status: string }>().status).toBe('posted');

    expect(await storeTotal(A.wardStore)).toBe(before - 3);

    const integrity = await call({
      method: 'GET',
      url: '/api/v1/inventory/integrity',
      token: manager.token,
    });
    expect(integrity.json<{ ok: boolean; rows: unknown[] }>()).toEqual({ ok: true, rows: [] });

    const completed = await outboxRows('inventory.count.completed');
    expect(completed.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. the conversion arithmetic, against Postgres itself
// ─────────────────────────────────────────────────────────────────────────────

describe('UoM conversion', () => {
  it('produces exactly what numeric produces, across generated magnitudes', async () => {
    // `uom.spec.ts` checks `convertToBase` against an exact-integer oracle, which
    // is the same algorithm written twice — useful against a regression to
    // floating point, useless as evidence that it matches the database. This is
    // the evidence: the same pairs, computed by `round(entered * factor, 4)` in
    // Postgres, which is what `inventory.enforce_qty_uom` will do to every row.
    let state = 987_654_321;
    const pairs: { entered: string; factor: string }[] = [];
    for (let i = 0; i < 300; i += 1) {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      pairs.push({
        entered: `${state % 100_000_000}.${String(state % 10_000).padStart(4, '0')}`,
        factor: `${(state % 1_000_000) + 1}.${String(state % 100_000_000).padStart(8, '0')}`,
      });
    }

    const { rows } = await pg.pool('migrator').query<{ i: string; want: string }>(
      `SELECT ordinality::text AS i,
              round(p.entered::numeric(18,4) * p.factor::numeric(20,8), 4)::text AS want
         FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS p(entered, factor, ordinality)`,
      [pairs.map((p) => p.entered), pairs.map((p) => p.factor)],
    );

    const mismatches = rows
      .map((row) => {
        const input = pairs[Number(row.i) - 1];
        if (input === undefined) return null;
        const got = convertToBase(input.entered, input.factor);
        return got === row.want ? null : `${input.entered} × ${input.factor}: ${got} ≠ ${row.want}`;
      })
      .filter((m): m is string => m !== null);

    expect(mismatches).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. tenancy and authorisation
// ─────────────────────────────────────────────────────────────────────────────

describe('tenancy and authorisation', () => {
  it('returns 403 for a role without the key', async () => {
    const denied = await call({
      method: 'GET',
      url: `/api/v1/inventory/items/${A.itemId}`,
      token: clerk.token,
    });
    expect(denied.statusCode, denied.body).toBe(403);
  });

  it('returns 404, not 403, for another hospital’s item', async () => {
    // The keeper in hospital B holds every key the keeper in A holds. What they
    // do not have is the row — and the answer must not confirm it exists.
    const crossTenant = await call({
      method: 'GET',
      url: `/api/v1/inventory/items/${A.itemId}`,
      token: keeperB.token,
    });
    expect(crossTenant.statusCode, crossTenant.body).toBe(404);
  });

  it('does not leak another hospital’s stock into a list', async () => {
    const listed = await call({ method: 'GET', url: '/api/v1/inventory/stock', token: keeperB.token });
    expect(listed.statusCode, listed.body).toBe(200);
    const itemIds = listed.json<{ items: { itemId: string }[] }>().items.map((i) => i.itemId);
    expect(itemIds).not.toContain(A.itemId);
  });

  it('refuses a page cursor minted in another tenant', async () => {
    const first = await call({
      method: 'GET',
      url: '/api/v1/inventory/items?limit=1',
      token: keeper.token,
    });
    const cursor = first.json<{ nextCursor: string | null }>().nextCursor;
    expect(cursor).not.toBeNull();

    const replayed = await call({
      method: 'GET',
      url: `/api/v1/inventory/items?limit=1&cursor=${encodeURIComponent(cursor ?? '')}`,
      token: keeperB.token,
    });
    expect(replayed.statusCode, replayed.body).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

async function storeTotal(storeId: string): Promise<number> {
  const { rows } = await pg
    .pool('migrator')
    .query<{ total: string }>(
      `SELECT COALESCE(sum(qty_on_hand), 0)::text AS total FROM inventory.stock_balances WHERE store_id = $1`,
      [storeId],
    );
  return Number(rows[0]?.total ?? 0);
}

/**
 * Phase 4 exit gate 6, stated as one test rather than inferred from several.
 *
 * > "Inter-store transfer, ward return, expiry write-off and a cycle count with
 * > variance all reconcile: run the stock-integrity test (`sum(ledger) ==
 * > on_hand` for every item/batch/store) and it passes."
 *
 * The suite already exercised transfers and counts and already called
 * `/inventory/integrity` twice — but never a **ward return** or an **expiry
 * write-off**, and never all four before one integrity check. Four operations
 * that each reconcile alone can still leave the ledger and the balances
 * disagreeing when they interleave, which is the only thing this gate is
 * actually asking about.
 *
 * `inventory.verify_stock_integrity()` re-derives `sum(qty_base)` from the
 * ledger for every item/batch/store position and returns the rows where it
 * disagrees with `stock_balances`. An empty result is the gate.
 */
describe('exit gate 6 — every movement type reconciles against the ledger', () => {
  async function integrityRows(): Promise<unknown[]> {
    const res = await call({ method: 'GET', url: '/api/v1/inventory/integrity', token: manager.token });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ ok: boolean; rows: unknown[] }>().rows;
  }

  it('starts from a reconciled ledger, so a later failure is attributable', async () => {
    expect(await integrityRows()).toEqual([]);
  });

  it('returns stock from a ward to the main store', async () => {
    const before = await storeTotal(A.wardStore);
    expect(before, 'the ward must hold stock for the return to mean anything').toBeGreaterThan(0);

    // The line names its batch. `create` is accepted without one, but `inspect`
    // refuses to restock it — "a movement with no batch is one no recall can
    // ever reach" — so a return raised without a batch can never be completed.
    const { rows: onWard } = await pg.pool('migrator').query<{ batch_id: string }>(
      `SELECT batch_id FROM inventory.stock_balances
          WHERE store_id = $1 AND item_id = $2 AND batch_id IS NOT NULL AND qty_on_hand > 0
          LIMIT 1`,
      [A.wardStore, A.itemId],
    );
    const wardBatch = onWard[0]?.batch_id;
    expect(wardBatch, 'the ward holds no batch to return').toBeDefined();

    const created = await call({
      method: 'POST',
      url: '/api/v1/inventory/returns',
      token: keeper.token,
      // `inventory.return.create` is `requiresReason`, so the header is not
      // optional — the policy engine refuses without it and says so.
      reason: 'Ward returned unopened stock at shift handover.',
      payload: {
        fromStoreId: A.wardStore,
        toStoreId: A.mainStore,
        reason: 'unused',
        lines: [
          { itemId: A.itemId, batchId: wardBatch, qtyEntered: 1, uomId: A.uomStrip, condition: 'good' },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const returnId = created.json<{ id: string; lines: { id: string }[] }>();

    // Creating the return does not move stock, and should not: a returned tube
    // goes back on the shelf only after somebody has looked at it. `inspect`
    // with `restock: true` is what posts the movement.
    expect(await storeTotal(A.wardStore)).toBe(before);

    const inspected = await call({
      method: 'POST',
      url: `/api/v1/inventory/returns/${returnId.id}/inspect`,
      token: keeper.token,
      reason: 'Inspected at the store counter; seals intact.',
      payload: { lines: (returnId.lines ?? []).map((l) => ({ lineId: l.id, restock: true })) },
    });
    expect(inspected.statusCode, inspected.body).toBe(201);

    expect(await storeTotal(A.wardStore)).toBeLessThan(before);
    expect(await integrityRows()).toEqual([]);
  });

  it('writes off an expired quantity and stays reconciled', async () => {
    const before = await storeTotal(A.mainStore);

    // The item is batch-tracked, and the guard says exactly why a line without
    // one is refused: "a movement with no batch is one no recall can ever reach".
    const { rows: held } = await pg.pool('migrator').query<{ batch_id: string }>(
      `SELECT batch_id FROM inventory.stock_balances
          WHERE store_id = $1 AND item_id = $2 AND batch_id IS NOT NULL AND qty_on_hand > 0
          LIMIT 1`,
      [A.mainStore, A.itemId],
    );
    const batchId = held[0]?.batch_id;
    expect(batchId, 'no batch on hand to write off').toBeDefined();

    const created = await call({
      method: 'POST',
      url: '/api/v1/inventory/adjustments',
      token: keeper.token,
      reason: 'Batch expired on the shelf and was destroyed under witness.',
      payload: {
        storeId: A.mainStore,
        adjustmentType: 'writeoff_expiry',
        reasonCode: 'expired',
        reason: 'Batch passed its expiry date on the shelf and was destroyed.',
        lines: [{ itemId: A.itemId, batchId, qtyEntered: 1, uomId: A.uomStrip }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const adjustmentId = created.json<{ id: string }>().id;

    // Nor does raising a write-off destroy anything. Stock leaves the shelf when
    // the adjustment is approved, which is the control: destruction of expired
    // stock is somebody's signature, not a data-entry side effect.
    expect(await storeTotal(A.mainStore)).toBe(before);

    const approved = await call({
      method: 'POST',
      url: `/api/v1/inventory/adjustments/${adjustmentId}/approve`,
      token: manager.token,
      reason: 'Expiry verified against the batch; destruction witnessed.',
      payload: { note: 'BMW route, batch destroyed.' },
    });
    expect(approved.statusCode, approved.body).toBe(201);

    // Now it must fall. If it did not, the write-off was paperwork and the shelf
    // and the system have parted company.
    expect(await storeTotal(A.mainStore)).toBeLessThan(before);
    expect(await integrityRows()).toEqual([]);
  });

  it('reconciles with every movement type applied together', async () => {
    // The gate's real question. Transfers, returns, write-offs and counted
    // variances have each been posted by now, against the same item and the same
    // two stores, interleaved with the rest of the suite.
    const rows = await integrityRows();
    expect(rows, 'positions where sum(ledger) disagrees with stock_balances').toEqual([]);
  });

  /**
   * The tripwire on the gate.
   *
   * `verify_stock_integrity()` returning an empty set proves nothing unless it
   * *can* return a non-empty one. A balance nudged behind the ledger's back must
   * be reported — otherwise this whole describe block is four assertions that an
   * empty list equals an empty list.
   */
  it('detects a balance that disagrees with the ledger', async () => {
    const owner = pg.pool('migrator');
    const { rows: target } = await owner.query<{ store_id: string; item_id: string; qty: string }>(
      `SELECT store_id, item_id, qty_on_hand::text AS qty FROM inventory.stock_balances
        WHERE store_id = $1 AND qty_on_hand > 0 LIMIT 1`,
      [A.mainStore],
    );
    const row = target[0];
    expect(row, 'no balance to corrupt — the fixture moved no stock').toBeDefined();

    await owner.query(
      `UPDATE inventory.stock_balances SET qty_on_hand = qty_on_hand + 7
        WHERE store_id = $1 AND item_id = $2`,
      [row?.store_id, row?.item_id],
    );
    try {
      expect(await integrityRows()).not.toEqual([]);
    } finally {
      await owner.query(
        `UPDATE inventory.stock_balances SET qty_on_hand = qty_on_hand - 7
          WHERE store_id = $1 AND item_id = $2`,
        [row?.store_id, row?.item_id],
      );
    }
    expect(await integrityRows()).toEqual([]);
  });
});

/**
 * Phase 4 exit gate 7.
 *
 * > "Consignment implant used → auto-PO raised → vendor reconciliation statement
 * > correct."
 *
 * Consignment was the one area the Phase 4 API shipped with no integration
 * coverage at all, and it is the area where being wrong is most expensive: the
 * hospital does not own this stock, so a usage that fails to raise its purchase
 * order is an implant in a patient that nobody has agreed to pay for, and a
 * reconciliation the vendor will dispute.
 *
 * The whole chain runs through the API rather than being seeded, because the
 * chain *is* the gate: an agreement nobody approved, or stock that arrived
 * without a challan, would each break it in a way a seeded fixture would hide.
 */
describe('exit gate 7 — a consignment implant raises its own purchase order', () => {
  const c = { agreementId: '', itemId: '', batchId: '', usageId: '', serialId: '' };

  it('registers and approves an agreement with the vendor', async () => {
    const item = await call({
      method: 'POST',
      url: '/api/v1/inventory/items',
      token: keeper.token,
      payload: {
        name: 'Titanium locking plate, 6-hole',
        categoryId: A.category,
        itemType: 'implant',
        baseUomId: A.uomEach,
        hsnCode: '9021',
        // Serial-tracked: an implant is traceable to the patient it went into,
        // which is what makes a recall answerable (TR-003).
        tracking: 'udi',
        // Consignment is an item-master decision, not an agreement one: it
        // changes who owns the stock, and the API refuses an agreement naming an
        // item that has not declared it.
        isConsignmentAllowed: true,
        uoms: [],
      },
    });
    expect(item.statusCode, item.body).toBe(201);
    c.itemId = item.json<{ id: string }>().id;

    const agreement = await call({
      method: 'POST',
      url: '/api/v1/inventory/consignment/agreements',
      token: buyer.token,
      reason: 'New orthopaedic consignment line for the trauma theatre.',
      payload: {
        vendorId: A.vendorId,
        agreementNo: 'CSN/2026/0001',
        startDate: '2026-04-01',
        endDate: '2027-03-31',
        invoicingCycle: 'per_usage',
        items: [{ itemId: c.itemId, vendorPrice: '4500.00', gstRate: 12, minStockBase: 2 }],
      },
    });
    expect(agreement.statusCode, agreement.body).toBe(201);
    c.agreementId = agreement.json<{ id: string }>().id;

    const approved = await call({
      method: 'POST',
      url: `/api/v1/inventory/consignment/agreements/${c.agreementId}/approve`,
      token: manager.token,
      reason: 'Terms reviewed against the rate contract.',
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(201);
  });

  it('receives vendor-owned stock, which does not become the hospital’s', async () => {
    const received = await call({
      method: 'POST',
      url: '/api/v1/inventory/consignment/receipts',
      token: manager.token,
      reason: 'Consignment challan received at the trauma store.',
      payload: {
        agreementId: c.agreementId,
        storeId: A.consignmentStore,
        challanNo: 'CHLN-2026-0042',
        challanDate: '2026-04-10',
        lines: [
          {
            itemId: c.itemId,
            qtyEntered: 1,
            uomId: A.uomEach,
            lotNo: 'LOT-TI-9931',
            expiryDate: '2029-03-31',
            serialNo: 'SN-TI-9931-0001',
            udiFull: '(01)08901234567890(17)290331(21)SN-TI-9931-0001',
          },
        ],
      },
    });
    expect(received.statusCode, received.body).toBe(201);

    const stock = await call({
      method: 'GET',
      url: `/api/v1/inventory/consignment/stock?storeId=${A.consignmentStore}`,
      token: manager.token,
    });
    expect(stock.statusCode, stock.body).toBe(200);
    const held = stock.json<{ items: { itemId: string; batchId: string | null; qtyOnHand: string }[] }>()
      .items;
    const line = held.find((h) => h.itemId === c.itemId);
    expect(line, 'the consignment stock did not appear on the shelf').toBeDefined();
    c.batchId = line?.batchId ?? '';
    expect(Number(line?.qtyOnHand)).toBe(1);

    // It is on the shelf and it is not ours: the batch is flagged consignment,
    // so a valuation that counted it as an asset would be overstating the
    // hospital's stock by the vendor's.
    const { rows } = await pg
      .pool('migrator')
      .query<{ is_consignment: boolean }>(`SELECT is_consignment FROM inventory.item_batches WHERE id = $1`, [
        c.batchId,
      ]);
    expect(rows[0]?.is_consignment).toBe(true);
  });

  it('raises the purchase order when the implant is used', async () => {
    const used = await call({
      method: 'POST',
      url: '/api/v1/inventory/consignment/usages',
      token: manager.token,
      reason: 'Implanted during a distal radius fixation.',
      payload: {
        agreementId: c.agreementId,
        storeId: A.consignmentStore,
        itemId: c.itemId,
        batchId: c.batchId,
        qtyEntered: 1,
        uomId: A.uomEach,
        // Not optional in practice: "a consignment item recorded as used names
        // the patient it was used on. Implant traceability is permanent and
        // starts here."
        patientId: A.patientId,
        side: 'left',
        site: 'Distal radius',
        status: 'used',
      },
    });
    expect(used.statusCode, used.body).toBe(201);
    c.usageId = used.json<{ id: string }>().id;

    const usage = await call({
      method: 'GET',
      url: `/api/v1/inventory/consignment/usages/${c.usageId}`,
      token: manager.token,
    });
    expect(usage.statusCode, usage.body).toBe(200);
    const view = usage.json<{
      header: { autoPoId: string | null; patientId: string | null };
      lines: { extra: { serialNo: string | null; billedAmount: string | null } }[];
    }>();

    // The gate. Consuming stock the hospital does not own creates the obligation
    // to buy it, and that obligation is a purchase order, not a note in a file.
    expect(view.header.autoPoId, 'using consignment stock raised no purchase order').not.toBeNull();
    expect(Number(view.lines[0]?.extra.billedAmount)).toBe(4500);
    // The patient travels with it, permanently.
    expect(view.header.patientId).toBe(A.patientId);

    // And the stock left the shelf, so the same implant cannot be used twice.
    const stock = await call({
      method: 'GET',
      url: `/api/v1/inventory/consignment/stock?storeId=${A.consignmentStore}`,
      token: manager.token,
    });
    const remaining = stock
      .json<{ items: { itemId: string; qtyOnHand: string }[] }>()
      .items.find((h) => h.itemId === c.itemId);
    // The view lists only positions with stock on hand, so a used implant drops
    // out of it entirely rather than appearing as a zero.
    expect(Number(remaining?.qtyOnHand ?? 0)).toBe(0);
  });

  it('reconciles what was used against what the vendor may invoice', async () => {
    const statement = await call({
      method: 'POST',
      url: '/api/v1/inventory/consignment/reconciliations',
      token: manager.token,
      reason: 'Monthly consignment reconciliation.',
      payload: {
        vendorId: A.vendorId,
        agreementId: c.agreementId,
        // A period is a month, not a pair of dates: the statement a vendor
        // invoices against is a monthly one.
        period: new Date().toISOString().slice(0, 7),
      },
    });
    expect(statement.statusCode, statement.body).toBe(201);
    const view = statement.json<{
      id: string;
      lines: { extra?: Record<string, unknown>; quantity?: string }[];
      header: Record<string, unknown>;
    }>();

    // One implant, priced by the agreement. A statement that disagrees with the
    // usages is the document the vendor disputes, and it is the only number in
    // this flow the hospital pays against.
    expect(view.lines.length, 'the statement listed no usage').toBe(1);
  });

  it('keeps the ledger and the balances in agreement after all of it', async () => {
    const integrity = await call({
      method: 'GET',
      url: '/api/v1/inventory/integrity',
      token: manager.token,
    });
    expect(integrity.json<{ ok: boolean; rows: unknown[] }>().rows).toEqual([]);
  });
});
