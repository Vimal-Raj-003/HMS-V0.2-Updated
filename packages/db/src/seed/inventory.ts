import type { SeedContext } from './context.js';
import { DRUGS, drugKeyOf } from './clinical.js';
import { SEED_EPOCH, seedDate, seedId } from './ids.js';
import type { SeededBranch, SeededTenancy } from './tenancy.js';
import { jsonb, upsert, type SeedRow, type SeedValue, type UpsertOptions } from './upsert.js';

/**
 * Phase 4 — the supply-chain masters and the stock the pharmacy opens with.
 *
 * Three rules govern what is here rather than invented, and the third is the one
 * this file exists to obey.
 *
 *  1. **Nothing is shipped as product content.** An item master, a vendor list
 *     and a store hierarchy are things a hospital authors. These rows are seeded
 *     per hospital and are a demonstration, not a formulary — the real master
 *     arrives through EN-036 or is typed by the stores in-charge.
 *
 *  2. **The drug half is derived from the Phase-2 formulary, not re-typed.**
 *     `items.drug_key` points at `mdm_drugs.record_key`, so every drug item here
 *     is built from the same `DRUGS` list the prescriber writes against. A
 *     second, divergent drug list is exactly what `EN-027` exists to prevent —
 *     and an item whose schedule disagreed with the drug's would make the
 *     Schedule-H refusal at the counter fire on the wrong things.
 *
 *  3. **The database's preconditions are satisfied, not worked around.** Phase 4
 *     ships more write-time refusals than any phase before it, and every one of
 *     them says what it wants. The five that shape this file:
 *
 *       • `inventory.enforce_item_uom` — the conversion ladder must have exactly
 *         one base rung, that rung's factor must be 1, `is_base` must be true
 *         for exactly the item's own base UoM, and no rung may cross UoM
 *         dimensions. So a syrup's "bottle" is a *volume* UoM, not the count
 *         UoM a tablet box uses: 1 bottle = 60 ml is a conversion, 1 bottle =
 *         60 tablets is a data-entry error the trigger refuses.
 *       • `inventory.enforce_item_default_uoms` — the purchase, issue and
 *         dispense defaults must each be a rung of that item's own ladder.
 *       • `inventory.enforce_qty_uom` — `qty_base` is recomputed from
 *         `qty_entered` and the item's own factor. Every ledger row below is
 *         written in the item's base UoM so the two are equal by construction.
 *       • `inventory.enforce_ledger_preconditions` — a batch-tracked item may
 *         not move without a batch, and a controlled drug may not sit in a store
 *         that is not designated to hold narcotics.
 *       • `inventory.enforce_batch_expiry_present` — an expiry-tracked item's
 *         batch must carry an expiry, and it must be after the manufacture date.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 *
 * Every id is a `seedId` hash of what the row *is*, so a re-run conflicts on the
 * primary key and `upsert()` skips the write when nothing differs. Two columns
 * need more than that:
 *
 *   `item_prices.effective_from` is marked immutable. `inventory.refuse_
 *   retroactive_price` refuses an insert dated before today, so the value has to
 *   be "today" — which is a different value tomorrow. Marking it immutable means
 *   a re-run next month compares the other columns, finds them identical and
 *   writes nothing, instead of attempting an UPDATE the trigger would reject.
 *
 *   `stock_balances` is not written here at all. It is maintained solely by
 *   `inventory.apply_ledger_to_balance`, which fires on INSERT into
 *   `stock_ledger` — so a re-run that inserts no ledger rows also moves no
 *   balances, and `sum(ledger) = on_hand` stays true by construction rather than
 *   by this file remembering to keep it true.
 */
export async function seedSupplyChain(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  await ensurePartitions(ctx);
  const today = await currentDate(ctx);

  await seedUoms(ctx, tenancy);
  await seedTaxMasters(ctx);
  await seedItemCategories(ctx, tenancy);
  await seedManufacturers(ctx, tenancy);
  await seedCostCentres(ctx, tenancy);
  await seedVendors(ctx, tenancy);
  await seedStores(ctx, tenancy);
  await seedItems(ctx, tenancy, today);
  await seedItemStoreParams(ctx, tenancy);
  await seedConsignmentAgreements(ctx, tenancy);
  await seedOpeningStock(ctx, tenancy);
  await seedPurchaseSettings(ctx, tenancy);
}

/**
 * `inventory.stock_ledger` is partitioned monthly and the migration pre-makes
 * the months around *its own* run date. The seed's movements are dated from
 * `SEED_EPOCH`, so their months are asked for explicitly — the same thing
 * `activity.ts` and `patients.ts` do for their partitioned targets. Without
 * this the rows land in the default partition, which `docs/07 §6` says is an
 * alertable anomaly rather than a normal state.
 */
async function ensurePartitions(ctx: SeedContext): Promise<void> {
  for (const month of ['2026-01-01', '2026-02-01']) {
    await ctx.db.query('SELECT core.ensure_month_partition($1, $2, $3::date)', [
      'inventory',
      'stock_ledger',
      month,
    ]);
  }
}

/**
 * Today, as PostgreSQL sees it.
 *
 * `inventory.refuse_retroactive_price` compares `effective_from` against
 * `current_date` in the *database's* session time zone. Computing the date in
 * Node instead would put a clock and a time zone between the value and the check
 * — and the failure mode is a seed that works in Bengaluru and refuses in CI at
 * 20:00 UTC. One round trip removes the class of bug.
 */
async function currentDate(ctx: SeedContext): Promise<string> {
  const { rows } = await ctx.db.query<{ d: string }>('SELECT current_date::text AS d');
  const today = rows[0]?.d;
  if (today === undefined) throw new Error('SELECT current_date returned no row');
  return today;
}

// ── identifiers, shared with pharmacy.ts ────────────────────────────────────

export function uomId(hospitalCode: string, code: string): string {
  return seedId('mdm-uom', hospitalCode, code);
}
export function storeId(hospitalCode: string, code: string): string {
  return seedId('inv-store', hospitalCode, code);
}
export function itemId(hospitalCode: string, code: string): string {
  return seedId('inv-item', hospitalCode, code);
}
export function costCentreId(hospitalCode: string, code: string): string {
  return seedId('fin-cost-centre', hospitalCode, code);
}
export function vendorId(hospitalCode: string, code: string): string {
  return seedId('inv-vendor', hospitalCode, code);
}

/**
 * Several writes, one transaction.
 *
 * `inventory.enforce_item_default_uoms` is a `DEFERRABLE INITIALLY DEFERRED`
 * constraint trigger, and the migration says why in as many words: "Deferred to
 * statement end so an item and its ladder can be inserted in one transaction in
 * either order." An item names its purchase, issue and dispense UoMs, and each
 * has to be a rung of that item's ladder — but the ladder rows in turn need the
 * item to exist, because `enforce_item_uom` reads `items.base_uom_id` to check
 * the dimension. The cycle is only resolvable inside a transaction.
 *
 * `ctx.write()` goes through the `Pool`, where every statement is its own
 * transaction and takes whichever connection is free — so the deferral has
 * nothing to defer to and the items insert is checked, and refused, the instant
 * it lands. The first version of this file did exactly that, and the database
 * said so: "uom … is not on the conversion ladder of item PCM500."
 *
 * Results are pushed onto `ctx.results` by hand so the run's tally still counts
 * these tables; the pooled path would otherwise be the only thing that reports.
 */
async function writeTogether(
  ctx: SeedContext,
  writes: readonly (readonly [UpsertOptions, readonly SeedRow[]])[],
): Promise<void> {
  const client = await ctx.db.connect();
  try {
    await client.query('BEGIN');
    for (const [options, rows] of writes) {
      ctx.results.push(await upsert(client, options, rows));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** The columns every Phase-4 master row carries. Saves twenty repetitions of six lines. */
function row(id: string, hospitalId: string | null, columns: Record<string, SeedValue>): SeedRow {
  return {
    id,
    hospital_id: hospitalId,
    ...columns,
    created_at: SEED_EPOCH,
    created_by: null,
    updated_at: SEED_EPOCH,
    updated_by: null,
  };
}

// ── units of measure ────────────────────────────────────────────────────────

/**
 * code, name, dimension, is the dimension anchor, UCUM code, decimal places.
 *
 * The dimension is load-bearing rather than descriptive: `enforce_item_uom`
 * refuses a rung whose dimension differs from the item's base UoM, so a pack
 * unit exists once per dimension it is used in. `BOX` is a box of tablets
 * (count); `BOT` is a bottle of syrup (volume). One code cannot be both, and the
 * trigger's message says exactly that when somebody tries.
 *
 * `factor_to_dimension_base` is left at 1 for every pack unit. A strip is not
 * globally "ten of something" — it is ten *of this item*, and that number lives
 * on `item_uoms.factor_to_base` where the converter reads it. Only the true
 * measures (millilitre to litre, milligram to gram) carry a real global factor.
 */
const UOMS: readonly (readonly [
  code: string,
  name: string,
  dimension: 'count' | 'mass' | 'volume',
  isDimensionBase: boolean,
  ucum: string | null,
  decimals: number,
  factorToDimensionBase: string,
])[] = [
  ['EA', 'Each', 'count', true, '1', 0, '1'],
  ['TAB', 'Tablet', 'count', false, '{tbl}', 0, '1'],
  ['CAP', 'Capsule', 'count', false, '{capsule}', 0, '1'],
  ['VIAL', 'Vial', 'count', false, '{vial}', 0, '1'],
  ['AMP', 'Ampoule', 'count', false, null, 0, '1'],
  ['TUBE', 'Tube', 'count', false, null, 0, '1'],
  ['STRIP', 'Strip', 'count', false, null, 0, '1'],
  ['BOX', 'Box', 'count', false, null, 0, '1'],
  ['PACK', 'Pack', 'count', false, null, 0, '1'],
  ['CASE', 'Shipper case', 'count', false, null, 0, '1'],
  ['PAIR', 'Pair', 'count', false, null, 0, '1'],
  ['SET', 'Set', 'count', false, null, 0, '1'],
  ['ROLL', 'Roll', 'count', false, null, 0, '1'],
  ['ML', 'Millilitre', 'volume', true, 'mL', 2, '1'],
  ['L', 'Litre', 'volume', false, 'L', 3, '1000'],
  ['BOT', 'Bottle', 'volume', false, null, 2, '1'],
  ['G', 'Gram', 'mass', true, 'g', 3, '1'],
  ['MG', 'Milligram', 'mass', false, 'mg', 3, '0.001'],
  ['KG', 'Kilogram', 'mass', false, 'kg', 3, '1000'],
];

async function seedUoms(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const rows: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    UOMS.forEach(([code, name, dimension, isBase, ucum, decimals, factor], index) => {
      rows.push(
        row(uomId(h.code, code), h.id, {
          code,
          name,
          dimension,
          is_dimension_base: isBase,
          factor_to_dimension_base: factor,
          decimal_places: decimals,
          ucum_code: ucum,
          sort_order: index,
          active: true,
        }),
      );
    });
  }
  await ctx.write({ table: 'mdm.mdm_uoms', conflict: ['id'] }, rows);
}

// ── HSN, GST and the DPCO ceilings ──────────────────────────────────────────

/** code, description, chapter, IGST rate. CGST and SGST are each half of it. */
const HSN_CODES: readonly (readonly [string, string, string, string])[] = [
  ['3004', 'Medicaments, put up in measured doses or in retail packings', '30', '12.00'],
  ['3005', 'Wadding, gauze, bandages and similar articles', '30', '12.00'],
  ['3006', 'Pharmaceutical goods: sutures, sterile absorbable haemostatics, dressings', '30', '12.00'],
  ['3822', 'Diagnostic or laboratory reagents on a backing; certified reference materials', '38', '12.00'],
  ['9018', 'Instruments and appliances used in medical or surgical sciences', '90', '12.00'],
  ['9021', 'Orthopaedic appliances, splints, artificial parts of the body, implants', '90', '05.00'],
  ['3808', 'Disinfectants and similar products', '38', '18.00'],
  ['4820', 'Registers, account books, order books and similar stationery', '48', '18.00'],
];

/**
 * Notified ceiling prices under the Drugs (Prices Control) Order 2013.
 *
 * Seeded **globally** (`hospital_id` and `drug_key` both null), because a
 * notification from the NPPA is the same document in every hospital and it names
 * a formulation, not a tenant's internal drug key.
 *
 * That leaves `inventory.enforce_dpco_ceiling` inert on this data: it looks the
 * ceiling up by `drug_key`, and a global row cannot carry a key that is minted
 * per hospital. Binding a ceiling to a tenant's drug key is not seedable today —
 * `mdm_dpco_ceilings_no_overlap` excludes on `(formulation, daterange)` alone,
 * with neither `hospital_id` nor `drug_key` in the key, so the second hospital's
 * row for the same formulation is refused. See the report accompanying this
 * change; the ceilings themselves are correct and are here so the mapping has
 * something real to bind to once that constraint is widened.
 *
 * Prices are the ceilings notified for these formulations and are per single
 * unit (tablet or millilitre), which is the basis `per_unit` records.
 */
const DPCO_CEILINGS: readonly (readonly [
  formulation: string,
  pack: string,
  ceiling: string,
  perUnit: string,
  notification: string,
])[] = [
  ['Paracetamol 500 mg tablet', '1 tablet', '2.50', 'tablet', 'NPPA S.O. (DPCO 2013, Schedule I)'],
  [
    'Metformin hydrochloride 500 mg tablet',
    '1 tablet',
    '2.03',
    'tablet',
    'NPPA S.O. (DPCO 2013, Schedule I)',
  ],
];

async function seedTaxMasters(ctx: SeedContext): Promise<void> {
  const hsnRows: SeedRow[] = [];
  const gstRows: SeedRow[] = [];

  for (const [code, description, chapter, igst] of HSN_CODES) {
    const id = seedId('mdm-hsn', code);
    hsnRows.push(
      row(id, null, {
        code,
        description,
        is_service: false,
        chapter,
        active: true,
      }),
    );
    const half = (Number(igst) / 2).toFixed(2);
    gstRows.push(
      row(seedId('mdm-gst', code), null, {
        hsn_code_id: id,
        cgst_rate: half,
        sgst_rate: half,
        igst_rate: Number(igst).toFixed(2),
        cess_rate: '0.00',
        is_exempt: false,
        is_nil_rated: false,
        // The rate in force since the GST rollout. Nothing in this table is
        // retroactive-checked, so a real historical date is safe and honest.
        effective_from: '2017-07-01',
        effective_to: null,
        notification_ref: 'Notification 1/2017-Central Tax (Rate), as amended',
      }),
    );
  }

  const dpcoRows: SeedRow[] = DPCO_CEILINGS.map(([formulation, pack, ceiling, perUnit, notification]) =>
    row(seedId('mdm-dpco', formulation), null, {
      drug_key: null,
      formulation,
      pack_description: pack,
      ceiling_price: ceiling,
      currency: 'INR',
      per_unit: perUnit,
      notification_no: notification,
      effective_from: '2023-04-01',
      effective_to: null,
    }),
  );

  await ctx.write({ table: 'mdm.mdm_hsn_codes', conflict: ['id'] }, hsnRows);
  await ctx.write({ table: 'mdm.mdm_gst_rates', conflict: ['id'] }, gstRows);
  await ctx.write({ table: 'mdm.mdm_dpco_ceilings', conflict: ['id'] }, dpcoRows);
}

// ── item categories ─────────────────────────────────────────────────────────

/** code, name, parent code, expense head, default HSN. */
const CATEGORIES: readonly (readonly [string, string, string | null, string, string | null])[] = [
  ['DRUG', 'Drugs & Pharmaceuticals', null, 'drugs', '3004'],
  ['DRUG-ORAL', 'Oral solids', 'DRUG', 'drugs', '3004'],
  ['DRUG-LIQ', 'Oral liquids', 'DRUG', 'drugs', '3004'],
  ['DRUG-INJ', 'Injectables', 'DRUG', 'drugs', '3004'],
  ['DRUG-RESP', 'Inhalational', 'DRUG', 'drugs', '3004'],
  ['DRUG-NDPS', 'Narcotic & psychotropic', 'DRUG', 'drugs', '3004'],
  ['SURG', 'Surgical consumables', null, 'surgical', '9018'],
  ['SURG-DISP', 'Disposables', 'SURG', 'surgical', '9018'],
  ['SURG-DRESS', 'Dressings', 'SURG', 'surgical', '3005'],
  ['IMPL', 'Implants', null, 'implants', '9021'],
  ['IMPL-ORTHO', 'Orthopaedic implants', 'IMPL', 'implants', '9021'],
  ['REAG', 'Laboratory reagents', null, 'reagents', '3822'],
  ['HK', 'Housekeeping', null, 'housekeeping', '3808'],
  ['STAT', 'Stationery & forms', null, 'stationery', '4820'],
];

async function seedItemCategories(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const byCode = new Map(CATEGORIES.map((c) => [c[0], c]));
  const pathOf = (code: string): string => {
    const parts: string[] = [];
    let cursor: string | null = code;
    while (cursor !== null) {
      parts.unshift(cursor);
      cursor = byCode.get(cursor)?.[2] ?? null;
    }
    return parts.join('/');
  };

  const rows: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    CATEGORIES.forEach(([code, name, parent, expenseHead, hsn], index) => {
      rows.push(
        row(categoryId(h.code, code), h.id, {
          code,
          name,
          parent_id: parent === null ? null : categoryId(h.code, parent),
          path: pathOf(code),
          expense_head: expenseHead,
          default_hsn_code: hsn,
          sort_order: index,
          active: true,
        }),
      );
    });
  }
  await ctx.write({ table: 'mdm.mdm_item_categories', conflict: ['id'] }, rows);
}

function categoryId(hospitalCode: string, code: string): string {
  return seedId('mdm-item-category', hospitalCode, code);
}

// ── manufacturers ───────────────────────────────────────────────────────────

/**
 * code, name, country, GS1 prefix.
 *
 * Licence numbers are synthetic and structurally plausible but issued to nobody
 * — `docs/09 §11` forbids real identifiers in seed data, and a real
 * manufacturing licence number is somebody's.
 */
const MANUFACTURERS: readonly (readonly [string, string, string, string | null])[] = [
  ['MICRO', 'Micro Labs Limited', 'IN', '8901234'],
  ['GSK', 'GlaxoSmithKline Pharmaceuticals Limited', 'IN', '8901235'],
  ['CIPLA', 'Cipla Limited', 'IN', '8901236'],
  ['SUN', 'Sun Pharmaceutical Industries Limited', 'IN', '8901237'],
  ['USV', 'USV Private Limited', 'IN', '8901238'],
  ['ABBOTT', 'Abbott India Limited', 'IN', '8901239'],
  ['TORRENT', 'Torrent Pharmaceuticals Limited', 'IN', '8901240'],
  ['DRL', "Dr. Reddy's Laboratories Limited", 'IN', '8901241'],
  ['INTAS', 'Intas Pharmaceuticals Limited', 'IN', '8901242'],
  ['ROMSONS', 'Romsons Scientific & Surgical Industries', 'IN', '8901243'],
  ['HINDLABS', 'Hindustan Surgical & Diagnostics', 'IN', '8901244'],
  ['ORTHOMED', 'OrthoMed Implants Private Limited', 'IN', '8901245'],
];

async function seedManufacturers(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const rows: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    MANUFACTURERS.forEach(([code, name, country, gs1], index) => {
      rows.push(
        row(manufacturerId(h.code, code), h.id, {
          code,
          name,
          country,
          licence_no: `SYNTH/MFG/${String(index + 1).padStart(4, '0')}`,
          licence_valid_to: '2035-03-31',
          gs1_prefix: gs1,
          is_blacklisted: false,
          blacklist_reason: null,
          active: true,
        }),
      );
    });
  }
  await ctx.write({ table: 'mdm.mdm_manufacturers', conflict: ['id'] }, rows);
}

function manufacturerId(hospitalCode: string, code: string): string {
  return seedId('mdm-manufacturer', hospitalCode, code);
}

// ── cost centres ────────────────────────────────────────────────────────────

/**
 * code, name, parent, type, allocation basis, department code.
 *
 * The codes match the `cost_centre_key` that `tenancy.ts` already stamps on
 * `mdm_departments` (`CC-<DEPT>`), so the department a consumption entry names
 * and the cost centre it is charged to are the same object rather than two lists
 * that drift.
 */
const COST_CENTRES: readonly (readonly [
  string,
  string,
  string | null,
  'revenue' | 'service' | 'overhead',
  string,
  string | null,
])[] = [
  ['CC-HOSP', 'Hospital', null, 'overhead', 'none', null],
  ['CC-GENMED', 'General Medicine', 'CC-HOSP', 'revenue', 'patient_days', 'GENMED'],
  ['CC-ORTHO', 'Orthopaedics', 'CC-HOSP', 'revenue', 'patient_days', 'ORTHO'],
  ['CC-GENSURG', 'General Surgery', 'CC-HOSP', 'revenue', 'patient_days', 'GENSURG'],
  ['CC-EMERG', 'Emergency & Trauma', 'CC-HOSP', 'revenue', 'patient_days', 'EMERG'],
  ['CC-LAB', 'Laboratory Medicine', 'CC-HOSP', 'service', 'tests', 'LAB'],
  ['CC-RAD', 'Radiology & Imaging', 'CC-HOSP', 'service', 'tests', 'RAD'],
  ['CC-PHARM', 'Pharmacy', 'CC-HOSP', 'revenue', 'none', 'PHARM'],
  ['CC-NURS', 'Nursing Services', 'CC-HOSP', 'service', 'bed_days', 'NURS'],
  ['CC-STORES', 'Central Stores', 'CC-HOSP', 'overhead', 'none', null],
  ['CC-ADMIN', 'Administration', 'CC-HOSP', 'overhead', 'headcount', 'ADMIN'],
];

async function seedCostCentres(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const rows: SeedRow[] = [];
  const mappings: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    for (const [code, name, parent, type, basis, department] of COST_CENTRES) {
      const departmentKey = department === null ? null : seedId('mdm-department-key', h.code, department);
      rows.push(
        row(costCentreId(h.code, code), h.id, {
          branch_id: null,
          code,
          name,
          parent_id: parent === null ? null : costCentreId(h.code, parent),
          centre_type: type,
          department_key: departmentKey,
          owner_user_id: null,
          gl_expense_map: jsonb({}),
          allocation_basis: basis,
          active: true,
          deleted_at: null,
          version: 0,
        }),
      );
      if (departmentKey !== null) {
        mappings.push(
          row(seedId('fin-cc-map', h.code, code), h.id, {
            cost_centre_id: costCentreId(h.code, code),
            entity_type: 'department',
            entity_id: departmentKey,
            // NC-008 §4 makes the mapping effective-dated. Nothing checks this
            // one against the clock, so the seed epoch is honest and stable.
            effective_from: SEED_EPOCH,
            effective_to: null,
          }),
        );
      }
    }
  }

  await ctx.write({ table: 'finance.cost_centres', conflict: ['id'] }, rows);
  await ctx.write({ table: 'finance.cost_centre_mappings', conflict: ['id'] }, mappings);
}

// ── vendors ─────────────────────────────────────────────────────────────────

/**
 * code, legal name, trade name, type, categories, GSTIN, PAN last four, credit
 * days, holds a drug licence.
 *
 * GSTINs are structurally valid for Karnataka (state code 29) and issued to
 * nobody. **PAN is stored masked only**: `pan_masked` carries the last four
 * characters and `pan_encrypted` stays null, because a seed has no key material
 * and a plausible-looking placeholder in an encrypted column is worse than an
 * empty one — the application would treat it as a real ciphertext.
 */
const VENDORS: readonly (readonly [
  code: string,
  legalName: string,
  tradeName: string,
  type: string,
  categories: readonly string[],
  gstin: string,
  panLast4: string,
  creditDays: number,
  drugLicence: boolean,
])[] = [
  [
    'VND-PHARMA',
    'Deccan Pharma Distributors Private Limited',
    'Deccan Pharma',
    'distributor',
    ['drugs', 'surgical'],
    '29AABCD1234E1Z5',
    '234E',
    30,
    true,
  ],
  [
    'VND-SURG',
    'Sahyadri Surgicals Private Limited',
    'Sahyadri Surgicals',
    'stockist',
    ['surgical', 'housekeeping'],
    '29AABCS5678F1Z9',
    '678F',
    45,
    false,
  ],
  [
    'VND-IMPL',
    'OrthoMed Implants Private Limited',
    'OrthoMed',
    'consignment',
    ['implants'],
    '29AABCO9012G1Z3',
    '012G',
    60,
    false,
  ],
  [
    'VND-REAG',
    'Cauvery Diagnostics Supply Company',
    'Cauvery Diagnostics',
    'distributor',
    ['reagents'],
    '29AABCC3456H1Z7',
    '456H',
    30,
    false,
  ],
];

async function seedVendors(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const vendors: SeedRow[] = [];
  const gstins: SeedRow[] = [];
  const documents: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    for (const [
      code,
      legalName,
      tradeName,
      type,
      categories,
      gstin,
      panLast4,
      creditDays,
      drugLicence,
    ] of VENDORS) {
      const id = vendorId(h.code, code);
      vendors.push(
        row(id, h.id, {
          group_id: null,
          vendor_code: code,
          legal_name: legalName,
          trade_name: tradeName,
          vendor_type: type,
          categories: [...categories],
          // Masked only. docs/04 §4: financial identifiers are encrypted at rest
          // and masked in the UI; a seed holds neither the key nor the clear value.
          pan_encrypted: null,
          pan_masked: `XXXXXX${panLast4}`,
          pan_verified_at: null,
          tan: null,
          msme_no: null,
          msme_class: 'small',
          msme_valid_until: '2030-03-31',
          gst_type: 'regular',
          einvoice_applicable: true,
          drug_licence_no: drugLicence ? `SYNTH/20B-21B/${code}` : null,
          // Far-dated on purpose: `inventory.enforce_grn_line` refuses a
          // scheduled drug from a vendor whose licence has lapsed on the receipt
          // date, and a demo whose receiving dock stops working next April is a
          // demo nobody trusts.
          drug_licence_valid_to: drugLicence ? '2035-03-31' : null,
          contacts: jsonb([
            { name: 'Accounts desk', role: 'accounts', phone: '+91-80-0000-0000', email: null },
          ]),
          addresses: jsonb([
            {
              kind: 'registered',
              line1: '12 Industrial Suburb',
              city: 'Bengaluru',
              state: 'Karnataka',
              country: 'IN',
              pincode: '560022',
            },
          ]),
          banks_encrypted: null,
          banks_masked: jsonb([{ bank: 'Demo Bank', accountLast4: '0000', ifscPrefix: 'DEMO0' }]),
          tds_section: '194C',
          tds_rate_override: null,
          credit_days: creditDays,
          payment_mode: 'neft',
          related_party: false,
          related_party_details: null,
          risk_rating: 'low',
          status: 'approved',
          status_reason: null,
          blacklisted_until: null,
          last_score: null,
          rating_grade: null,
          lead_time_days_avg: 5,
          kyc_refreshed_at: SEED_EPOCH,
          portal_enabled: false,
          ap_ledger_code: null,
          notes: null,
          deleted_at: null,
          version: 0,
        }),
      );

      gstins.push(
        row(seedId('inv-vendor-gstin', h.code, code), h.id, {
          vendor_id: id,
          gstin,
          state_code: '29',
          legal_name_gstn: legalName,
          status: 'active',
          verified_at: SEED_EPOCH,
          filing_status: jsonb({}),
          is_primary: true,
        }),
      );

      if (drugLicence) {
        documents.push(
          row(seedId('inv-vendor-doc', h.code, code, 'drug_licence_20b'), h.id, {
            vendor_id: id,
            doc_type: 'drug_licence_20b',
            number: `SYNTH/20B/${code}`,
            issuer: 'Karnataka State Drugs Control Department',
            valid_from: '2024-04-01',
            valid_until: '2035-03-31',
            file_id: null,
            verified_by: null,
            status: 'valid',
          }),
        );
      }
      documents.push(
        row(seedId('inv-vendor-doc', h.code, code, 'gst_cert'), h.id, {
          vendor_id: id,
          doc_type: 'gst_cert',
          number: gstin,
          issuer: 'GSTN',
          valid_from: '2017-07-01',
          valid_until: null,
          file_id: null,
          verified_by: null,
          status: 'valid',
        }),
      );
    }
  }

  await ctx.write({ table: 'inventory.vnd_vendors', conflict: ['id'] }, vendors);
  await ctx.write({ table: 'inventory.vnd_gstins', conflict: ['id'] }, gstins);
  await ctx.write({ table: 'inventory.vnd_documents', conflict: ['id'] }, documents);
}

// ── stores ──────────────────────────────────────────────────────────────────

/**
 * code, name, type, parent, department, cost centre, narcotics, negative-stock
 * policy, consignment, main-branch-only.
 *
 * `holds_narcotics` is not decoration: `inventory.enforce_ledger_preconditions`
 * refuses a movement of a controlled drug into a store without it, quoting
 * `phase-04 §4.2` ("narcotics stored and reconciled separately"). So the two
 * pharmacy counters carry it and nothing else does.
 *
 * `negative_stock_policy` follows NC-006 §3.16: the main store and the pharmacy
 * counters `block` — `phase-04 §Constraints` says a dispensing counter fails
 * closed on stock integrity — and the ward stores are `allow_with_approval`,
 * because a nurse who has physically used the last ampoule must be able to
 * record it while the paperwork catches up.
 */
interface StoreSeed {
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly parent: string | null;
  readonly department: string | null;
  readonly costCentre: string;
  readonly narcotics: boolean;
  readonly negativeStock: 'block' | 'allow_with_approval';
  readonly consignment: boolean;
  readonly is24x7: boolean;
}

const STORES: readonly StoreSeed[] = [
  {
    code: 'MAIN',
    name: 'Central Stores',
    type: 'main',
    parent: null,
    department: null,
    costCentre: 'CC-STORES',
    narcotics: false,
    negativeStock: 'block',
    consignment: false,
    is24x7: false,
  },
  {
    code: 'PHARM-OP',
    name: 'Outpatient Pharmacy',
    type: 'pharmacy',
    parent: 'MAIN',
    department: 'PHARM',
    costCentre: 'CC-PHARM',
    narcotics: true,
    negativeStock: 'block',
    consignment: false,
    is24x7: true,
  },
  {
    code: 'PHARM-IP',
    name: 'Inpatient Pharmacy',
    type: 'pharmacy',
    parent: 'MAIN',
    department: 'PHARM',
    costCentre: 'CC-PHARM',
    narcotics: true,
    negativeStock: 'block',
    consignment: false,
    is24x7: true,
  },
  {
    code: 'WARD-GEN',
    name: 'General Ward Stock',
    type: 'ward',
    parent: 'PHARM-IP',
    department: 'NURS',
    costCentre: 'CC-NURS',
    narcotics: false,
    negativeStock: 'allow_with_approval',
    consignment: false,
    is24x7: true,
  },
  {
    code: 'OT',
    name: 'Operation Theatre Store',
    type: 'ot',
    parent: 'MAIN',
    department: 'GENSURG',
    costCentre: 'CC-GENSURG',
    narcotics: false,
    negativeStock: 'allow_with_approval',
    consignment: false,
    is24x7: true,
  },
  {
    code: 'LAB',
    name: 'Laboratory Store',
    type: 'lab',
    parent: 'MAIN',
    department: 'LAB',
    costCentre: 'CC-LAB',
    narcotics: false,
    negativeStock: 'block',
    consignment: false,
    is24x7: false,
  },
  {
    code: 'CSSD',
    name: 'CSSD Store',
    type: 'cssd',
    parent: 'MAIN',
    department: null,
    costCentre: 'CC-STORES',
    narcotics: false,
    negativeStock: 'block',
    consignment: false,
    is24x7: false,
  },
  {
    code: 'CONSIGN',
    name: 'Consignment Implant Store',
    type: 'consignment',
    parent: 'MAIN',
    department: 'ORTHO',
    costCentre: 'CC-ORTHO',
    narcotics: false,
    negativeStock: 'block',
    consignment: true,
    is24x7: false,
  },
  {
    code: 'QUAR',
    name: 'Quarantine & Expired Hold',
    type: 'quarantine',
    parent: 'MAIN',
    department: null,
    costCentre: 'CC-STORES',
    narcotics: false,
    negativeStock: 'block',
    consignment: false,
    is24x7: false,
  },
];

/** The satellite branch gets a store and a counter, not a whole hierarchy. */
const SATELLITE_STORES: readonly StoreSeed[] = [
  {
    code: 'MAIN-SAT',
    name: 'Satellite Store',
    type: 'main',
    parent: null,
    department: null,
    costCentre: 'CC-STORES',
    narcotics: false,
    negativeStock: 'block',
    consignment: false,
    is24x7: false,
  },
  {
    code: 'PHARM-SAT',
    name: 'Satellite Pharmacy',
    type: 'pharmacy',
    parent: 'MAIN-SAT',
    department: 'PHARM',
    costCentre: 'CC-PHARM',
    narcotics: false,
    negativeStock: 'block',
    consignment: false,
    is24x7: false,
  },
];

export function storesFor(branch: SeededBranch): readonly StoreSeed[] {
  return branch.isMain ? STORES : SATELLITE_STORES;
}

async function seedStores(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const stores: SeedRow[] = [];
  const locations: SeedRow[] = [];
  const zones: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    for (const b of h.branches) {
      for (const s of storesFor(b)) {
        const id = storeId(h.code, s.code);
        stores.push(
          row(id, h.id, {
            branch_id: b.id,
            code: s.code,
            name: s.name,
            store_type: s.type,
            parent_store_id: s.parent === null ? null : storeId(h.code, s.parent),
            custodian_user_id: null,
            department_key: s.department === null ? null : seedId('mdm-department-key', h.code, s.department),
            cost_centre_id: costCentreId(h.code, s.costCentre),
            drug_licence_no: s.type === 'pharmacy' ? `SYNTH/20-21/${s.code}` : null,
            drug_licence_expiry: s.type === 'pharmacy' ? '2035-03-31' : null,
            allowed_category_ids: [],
            negative_stock_policy: s.negativeStock,
            valuation_method: 'weighted_average',
            is_consignment: s.consignment,
            holds_narcotics: s.narcotics,
            is_24x7: s.is24x7,
            active: true,
            deleted_at: null,
            version: 0,
          }),
        );

        // Bins. Every store gets a general rack; the ones that need a fridge,
        // a quarantine bay or a controlled-drug safe say so on the location, so
        // put-away can refuse the wrong shelf rather than trusting the label.
        const bins: readonly (readonly [string, string, boolean, boolean, boolean])[] = [
          [`${s.code}-A1`, 'Rack A, shelf 1', false, false, false],
          ...(HAS_COLD_CHAIN.has(s.type)
            ? ([[`${s.code}-COLD`, 'Cold-chain refrigerator', false, false, false]] as const)
            : []),
          ...(s.narcotics ? ([[`${s.code}-SAFE`, 'Controlled-drug safe', false, false, true]] as const) : []),
          ...(s.type === 'quarantine'
            ? ([
                [`${s.code}-HOLD`, 'Quarantine bay', true, false, false],
                [`${s.code}-EXP`, 'Expired stock hold', false, true, false],
              ] as const)
            : []),
        ];

        for (const [code, name, isQuarantine, isExpiredHold, isSafe] of bins) {
          locations.push(
            row(seedId('inv-store-location', h.code, code), h.id, {
              store_id: id,
              code,
              name,
              path: `${s.code}/${code}`,
              temp_zone_id: code.endsWith('-COLD') ? tempZoneId(h.code, s.code) : null,
              capacity: null,
              is_quarantine: isQuarantine,
              is_expired_hold: isExpiredHold,
              is_controlled_safe: isSafe,
              barcode: `LOC-${code}`,
              active: true,
            }),
          );
        }

        if (HAS_COLD_CHAIN.has(s.type)) {
          zones.push(
            row(tempZoneId(h.code, s.code), h.id, {
              store_id: id,
              code: `${s.code}-COLD`,
              name: 'Cold chain 2–8 °C',
              // The band the Indian cold chain is defined by. An excursion is
              // measured against these two numbers and nothing else.
              min_c: '2.00',
              max_c: '8.00',
              sensor_device_id: null,
              last_reading_c: null,
              last_reading_at: null,
              status: 'ok',
              active: true,
            }),
          );
        }
      }
    }
  }

  await ctx.write({ table: 'inventory.stores', conflict: ['id'] }, stores);
  await ctx.write({ table: 'inventory.temp_zones', conflict: ['id'] }, zones);
  await ctx.write({ table: 'inventory.store_locations', conflict: ['id'] }, locations);
}

/**
 * Store types that keep a refrigerator, and therefore get a temperature zone and
 * a cold bin. Everything a cold-chain item is stocked in has to be one of these,
 * or `temp_zone_required` on the item is a promise nothing keeps.
 */
const HAS_COLD_CHAIN = new Set(['pharmacy', 'main', 'lab']);

function tempZoneId(hospitalCode: string, storeCode: string): string {
  return seedId('inv-temp-zone', hospitalCode, storeCode);
}

// ── the item master ─────────────────────────────────────────────────────────

/** A rung of an item's conversion ladder: UoM, factor to base, pack level. */
type Rung = readonly [uom: string, factorToBase: number, packLevel: 'base' | 'inner' | 'outer' | 'shipper'];

interface ItemSeed {
  readonly code: string;
  readonly name: string;
  readonly shortName: string;
  readonly generic: string | null;
  readonly drugCode: string | null;
  readonly category: string;
  readonly itemType: string;
  readonly manufacturer: string | null;
  readonly hsn: string;
  readonly schedule: string;
  readonly isNarcotic: boolean;
  readonly dpcoScheduled: boolean;
  readonly highAlert: boolean;
  readonly lasa: boolean;
  readonly storage: string;
  readonly tempZone: boolean;
  readonly tracking: 'none' | 'batch' | 'batch_expiry' | 'serial' | 'udi';
  readonly minShelfLifeDays: number | null;
  readonly shelfLifeDays: number | null;
  readonly abc: 'a' | 'b' | 'c';
  readonly ved: 'vital' | 'essential' | 'desirable';
  readonly fsn: 'fast' | 'slow' | 'non_moving';
  readonly ladder: readonly Rung[];
  readonly purchaseUom: string;
  readonly issueUom: string;
  readonly dispenseUom: string;
  readonly unitCost: string;
  readonly salePrice: string;
  readonly mrp: string;
  readonly consignment: boolean;
  readonly leadTimeDays: number;
}

/** Two decimal places, never below a paisa. Money in a seed is still money. */
function rupees(value: number): string {
  return Math.max(0.01, Math.round(value * 100) / 100).toFixed(2);
}

/**
 * The drug half of the item master, derived from the Phase-2 formulary.
 *
 * The pack shape follows the form, and the ladder shape follows the pack:
 * a tablet is bought by the box, issued by the strip and dispensed by the
 * tablet; a syrup is bought and issued by the bottle and dispensed by the
 * millilitre; an injection is bought by the box and both issued and dispensed by
 * the vial. Every one of those three ladders stays inside one UoM dimension,
 * which is what `inventory.enforce_item_uom` insists on.
 */
function drugItems(): readonly ItemSeed[] {
  return DRUGS.map((d): ItemSeed => {
    const [, manufacturerName, packSize, packMrp] = d.brand;
    const pack = Math.max(1, packSize);
    const narcotic = d.schedule === 'ndps_narcotic' || d.schedule === 'ndps_psychotropic';

    let ladder: readonly Rung[];
    let purchaseUom: string;
    let issueUom: string;
    let dispenseUom: string;
    let unitsInSalePack: number;

    switch (d.form) {
      case 'syrup':
        ladder = [
          ['ML', 1, 'base'],
          ['BOT', pack, 'inner'],
        ];
        purchaseUom = 'BOT';
        issueUom = 'BOT';
        dispenseUom = 'ML';
        unitsInSalePack = pack;
        break;
      case 'injection':
        ladder = [
          ['VIAL', 1, 'base'],
          ['BOX', 10, 'outer'],
        ];
        purchaseUom = 'BOX';
        issueUom = 'VIAL';
        dispenseUom = 'VIAL';
        // A brand pack of an injection is one vial; the box is a shipper unit.
        unitsInSalePack = 1;
        break;
      case 'inhaler':
        ladder = [
          ['EA', 1, 'base'],
          ['BOX', 10, 'outer'],
        ];
        purchaseUom = 'BOX';
        issueUom = 'EA';
        dispenseUom = 'EA';
        unitsInSalePack = 1;
        break;
      case 'capsule':
        ladder = [
          ['CAP', 1, 'base'],
          ['STRIP', pack, 'inner'],
          ['BOX', pack * 10, 'outer'],
        ];
        purchaseUom = 'BOX';
        issueUom = 'STRIP';
        dispenseUom = 'CAP';
        unitsInSalePack = pack;
        break;
      default:
        ladder = [
          ['TAB', 1, 'base'],
          ['STRIP', pack, 'inner'],
          ['BOX', pack * 10, 'outer'],
        ];
        purchaseUom = 'BOX';
        issueUom = 'STRIP';
        dispenseUom = 'TAB';
        unitsInSalePack = pack;
        break;
    }

    const mrpPerBase = packMrp / unitsInSalePack;

    return {
      code: d.code,
      name: `${d.generic}${d.strength === null ? '' : ` ${d.strength} ${d.strengthUnit ?? ''}`.trimEnd()} ${d.form}`,
      shortName: d.code,
      generic: d.generic,
      drugCode: d.code,
      category:
        narcotic || d.schedule === 'x'
          ? 'DRUG-NDPS'
          : d.form === 'syrup'
            ? 'DRUG-LIQ'
            : d.form === 'injection'
              ? 'DRUG-INJ'
              : d.form === 'inhaler'
                ? 'DRUG-RESP'
                : 'DRUG-ORAL',
      itemType: 'drug',
      manufacturer: MANUFACTURER_BY_BRAND[manufacturerName] ?? null,
      hsn: '3004',
      schedule: d.schedule,
      isNarcotic: narcotic,
      dpcoScheduled: d.dpcoCeiling !== undefined,
      highAlert: d.highAlert ?? false,
      lasa: d.lasa !== undefined,
      storage: d.form === 'injection' ? 'cold_2_8' : 'ambient',
      tempZone: d.form === 'injection',
      tracking: 'batch_expiry',
      // NC-006 §3.16: "min shelf life 6 months (drugs)". The receiving dock
      // refuses a batch with less left than this.
      minShelfLifeDays: 180,
      shelfLifeDays: 730,
      abc: d.dpcoCeiling !== undefined ? 'a' : 'b',
      ved: narcotic || (d.highAlert ?? false) ? 'vital' : 'essential',
      fsn: 'fast',
      ladder,
      purchaseUom,
      issueUom,
      dispenseUom,
      // A distributor's landed cost against MRP. Indicative, and clearly so.
      unitCost: rupees(mrpPerBase * 0.72),
      salePrice: rupees(mrpPerBase),
      mrp: rupees(mrpPerBase),
      consignment: false,
      leadTimeDays: 5,
    };
  });
}

/** `mdm_drugs.brand.manufacturer` is a display name; the item master wants a code. */
const MANUFACTURER_BY_BRAND: Readonly<Record<string, string>> = {
  'Micro Labs': 'MICRO',
  GSK: 'GSK',
  Cipla: 'CIPLA',
  'Sun Pharma': 'SUN',
  USV: 'USV',
  Abbott: 'ABBOTT',
  Torrent: 'TORRENT',
  "Dr Reddy's": 'DRL',
  "Dr. Reddy's": 'DRL',
  Intas: 'INTAS',
};

/**
 * The non-drug half: consumables, dressings, implants, a reagent, a
 * disinfectant and a form.
 *
 * Chosen so the phase's refusals have something to fire on rather than for
 * breadth. The two implants are consignment and UDI-tracked, so
 * `inventory.enforce_consignment_batch` and the serial capture have real rows.
 * The disinfectant and the case sheet are `tracking: 'none'`, so the
 * batch-mandatory path is demonstrably *not* universal — a seed in which every
 * item is batch-tracked never exercises the branch that says otherwise.
 */
const NON_DRUG_ITEMS: readonly ItemSeed[] = [
  {
    code: 'SYR-5ML',
    name: 'Disposable syringe 5 ml with needle',
    shortName: 'Syringe 5 ml',
    generic: null,
    drugCode: null,
    category: 'SURG-DISP',
    itemType: 'consumable',
    manufacturer: 'ROMSONS',
    hsn: '9018',
    schedule: 'otc',
    isNarcotic: false,
    dpcoScheduled: false,
    highAlert: false,
    lasa: false,
    storage: 'ambient',
    tempZone: false,
    tracking: 'batch_expiry',
    minShelfLifeDays: 90,
    shelfLifeDays: 1825,
    abc: 'a',
    ved: 'vital',
    fsn: 'fast',
    ladder: [
      ['EA', 1, 'base'],
      ['PACK', 100, 'outer'],
    ],
    purchaseUom: 'PACK',
    issueUom: 'PACK',
    dispenseUom: 'EA',
    unitCost: '3.20',
    salePrice: '6.00',
    mrp: '6.50',
    consignment: false,
    leadTimeDays: 7,
  },
  {
    code: 'IV-SET',
    name: 'IV infusion set, 20 drops per ml',
    shortName: 'IV set',
    generic: null,
    drugCode: null,
    category: 'SURG-DISP',
    itemType: 'consumable',
    manufacturer: 'ROMSONS',
    hsn: '9018',
    schedule: 'otc',
    isNarcotic: false,
    dpcoScheduled: false,
    highAlert: false,
    lasa: false,
    storage: 'ambient',
    tempZone: false,
    tracking: 'batch_expiry',
    minShelfLifeDays: 90,
    shelfLifeDays: 1825,
    abc: 'a',
    ved: 'vital',
    fsn: 'fast',
    ladder: [
      ['EA', 1, 'base'],
      ['PACK', 50, 'outer'],
    ],
    purchaseUom: 'PACK',
    issueUom: 'PACK',
    dispenseUom: 'EA',
    unitCost: '18.00',
    salePrice: '35.00',
    mrp: '38.00',
    consignment: false,
    leadTimeDays: 7,
  },
  {
    code: 'GLOVE-7',
    name: 'Sterile latex surgical gloves, size 7',
    shortName: 'Gloves 7',
    generic: null,
    drugCode: null,
    category: 'SURG-DISP',
    itemType: 'surgical',
    manufacturer: 'HINDLABS',
    hsn: '4015',
    schedule: 'otc',
    isNarcotic: false,
    dpcoScheduled: false,
    highAlert: false,
    lasa: false,
    storage: 'ambient',
    tempZone: false,
    tracking: 'batch_expiry',
    minShelfLifeDays: 180,
    shelfLifeDays: 1825,
    abc: 'a',
    ved: 'vital',
    fsn: 'fast',
    ladder: [
      ['PAIR', 1, 'base'],
      ['BOX', 50, 'outer'],
    ],
    purchaseUom: 'BOX',
    issueUom: 'BOX',
    dispenseUom: 'PAIR',
    unitCost: '14.50',
    salePrice: '25.00',
    mrp: '28.00',
    consignment: false,
    leadTimeDays: 10,
  },
  {
    code: 'GAUZE-10',
    name: 'Sterile gauze swab 10 x 10 cm, 8-ply',
    shortName: 'Gauze 10 cm',
    generic: null,
    drugCode: null,
    category: 'SURG-DRESS',
    itemType: 'consumable',
    manufacturer: 'HINDLABS',
    hsn: '3005',
    schedule: 'otc',
    isNarcotic: false,
    dpcoScheduled: false,
    highAlert: false,
    lasa: false,
    storage: 'ambient',
    tempZone: false,
    tracking: 'batch_expiry',
    minShelfLifeDays: 180,
    shelfLifeDays: 1825,
    abc: 'b',
    ved: 'essential',
    fsn: 'fast',
    ladder: [
      ['EA', 1, 'base'],
      ['PACK', 100, 'outer'],
    ],
    purchaseUom: 'PACK',
    issueUom: 'PACK',
    dispenseUom: 'EA',
    unitCost: '2.10',
    salePrice: '4.00',
    mrp: '4.50',
    consignment: false,
    leadTimeDays: 10,
  },
  {
    code: 'CANN-18',
    name: 'Intravenous cannula 18G with injection port',
    shortName: 'Cannula 18G',
    generic: null,
    drugCode: null,
    category: 'SURG-DISP',
    itemType: 'consumable',
    manufacturer: 'ROMSONS',
    hsn: '9018',
    schedule: 'otc',
    isNarcotic: false,
    dpcoScheduled: false,
    highAlert: false,
    lasa: false,
    storage: 'ambient',
    tempZone: false,
    tracking: 'batch_expiry',
    minShelfLifeDays: 180,
    shelfLifeDays: 1825,
    abc: 'a',
    ved: 'vital',
    fsn: 'fast',
    ladder: [
      ['EA', 1, 'base'],
      ['BOX', 50, 'outer'],
    ],
    purchaseUom: 'BOX',
    issueUom: 'BOX',
    dispenseUom: 'EA',
    unitCost: '26.00',
    salePrice: '48.00',
    mrp: '52.00',
    consignment: false,
    leadTimeDays: 10,
  },
  {
    code: 'IMP-DHS',
    name: 'Dynamic hip screw plate, 135 degrees, 4-hole',
    shortName: 'DHS plate 4-hole',
    generic: null,
    drugCode: null,
    category: 'IMPL-ORTHO',
    itemType: 'implant',
    manufacturer: 'ORTHOMED',
    hsn: '9021',
    schedule: 'otc',
    isNarcotic: false,
    dpcoScheduled: false,
    highAlert: false,
    lasa: false,
    storage: 'ambient',
    tempZone: false,
    // UDI, not merely batch: an implant that goes into a patient has to be
    // traceable to a single serial, which is what TR-003 handshakes against.
    tracking: 'udi',
    minShelfLifeDays: 365,
    shelfLifeDays: 1825,
    abc: 'a',
    ved: 'vital',
    fsn: 'slow',
    ladder: [['EA', 1, 'base']],
    purchaseUom: 'EA',
    issueUom: 'EA',
    dispenseUom: 'EA',
    unitCost: '12500.00',
    salePrice: '18500.00',
    mrp: '19500.00',
    consignment: true,
    leadTimeDays: 3,
  },
  {
    code: 'IMP-NAIL',
    name: 'Interlocking tibial nail, 9 mm x 300 mm',
    shortName: 'Tibial nail 9x300',
    generic: null,
    drugCode: null,
    category: 'IMPL-ORTHO',
    itemType: 'implant',
    manufacturer: 'ORTHOMED',
    hsn: '9021',
    schedule: 'otc',
    isNarcotic: false,
    dpcoScheduled: false,
    highAlert: false,
    lasa: false,
    storage: 'ambient',
    tempZone: false,
    tracking: 'udi',
    minShelfLifeDays: 365,
    shelfLifeDays: 1825,
    abc: 'a',
    ved: 'vital',
    fsn: 'slow',
    ladder: [['EA', 1, 'base']],
    purchaseUom: 'EA',
    issueUom: 'EA',
    dispenseUom: 'EA',
    unitCost: '16800.00',
    salePrice: '24500.00',
    mrp: '26000.00',
    consignment: true,
    leadTimeDays: 3,
  },
  {
    code: 'REAG-GLU',
    name: 'Glucose oxidase reagent, 4 x 50 ml',
    shortName: 'Glucose reagent',
    generic: null,
    drugCode: null,
    category: 'REAG',
    itemType: 'reagent',
    manufacturer: 'ABBOTT',
    hsn: '3822',
    schedule: 'otc',
    isNarcotic: false,
    dpcoScheduled: false,
    highAlert: false,
    lasa: false,
    storage: 'cold_2_8',
    tempZone: true,
    tracking: 'batch_expiry',
    minShelfLifeDays: 90,
    shelfLifeDays: 365,
    abc: 'a',
    ved: 'vital',
    fsn: 'fast',
    ladder: [
      ['ML', 1, 'base'],
      ['BOT', 50, 'inner'],
    ],
    purchaseUom: 'BOT',
    issueUom: 'BOT',
    dispenseUom: 'ML',
    unitCost: '9.60',
    salePrice: '0.01',
    mrp: '12.00',
    consignment: false,
    leadTimeDays: 14,
  },
  {
    code: 'HK-PHEN',
    name: 'Phenolic floor disinfectant concentrate',
    shortName: 'Phenolic cleaner',
    generic: null,
    drugCode: null,
    category: 'HK',
    itemType: 'housekeeping',
    manufacturer: 'HINDLABS',
    hsn: '3808',
    schedule: 'otc',
    isNarcotic: false,
    dpcoScheduled: false,
    highAlert: false,
    lasa: false,
    storage: 'ambient',
    tempZone: false,
    // Not batch-tracked. The ledger's batch requirement is conditional on the
    // item, and a seed where every item is batch-tracked never proves it.
    tracking: 'none',
    minShelfLifeDays: null,
    shelfLifeDays: null,
    abc: 'c',
    ved: 'desirable',
    fsn: 'fast',
    ladder: [
      ['ML', 1, 'base'],
      ['L', 1000, 'inner'],
    ],
    purchaseUom: 'L',
    issueUom: 'L',
    dispenseUom: 'ML',
    unitCost: '0.18',
    salePrice: '0.01',
    mrp: '0.30',
    consignment: false,
    leadTimeDays: 14,
  },
  {
    code: 'STAT-CASE',
    name: 'Inpatient case sheet, 100 leaves',
    shortName: 'Case sheet',
    generic: null,
    drugCode: null,
    category: 'STAT',
    itemType: 'stationery',
    manufacturer: null,
    hsn: '4820',
    schedule: 'otc',
    isNarcotic: false,
    dpcoScheduled: false,
    highAlert: false,
    lasa: false,
    storage: 'ambient',
    tempZone: false,
    tracking: 'none',
    minShelfLifeDays: null,
    shelfLifeDays: null,
    abc: 'c',
    ved: 'desirable',
    fsn: 'fast',
    ladder: [
      ['EA', 1, 'base'],
      ['BOX', 20, 'outer'],
    ],
    purchaseUom: 'BOX',
    issueUom: 'BOX',
    dispenseUom: 'EA',
    unitCost: '32.00',
    salePrice: '0.01',
    mrp: '45.00',
    consignment: false,
    leadTimeDays: 21,
  },
];

/** Everything in the master, drugs first. Ordered so barcodes are stable. */
export function allItems(): readonly ItemSeed[] {
  return [...drugItems(), ...NON_DRUG_ITEMS];
}

/**
 * Generic substitution pairs.
 *
 * Both directions, because "what may I give instead" is asked from whichever
 * item is out of stock. `requires_prescriber_approval` is true on every one:
 * OP-003 §3 lets a hospital relax it by policy, and the safe default when a
 * *different molecule* is being handed over is that the prescriber decides.
 */
const SUBSTITUTES: readonly (readonly [string, string, string])[] = [
  ['PANTO40', 'OMEP20', 'therapeutic'],
  ['OMEP20', 'PANTO40', 'therapeutic'],
  ['DICLO50', 'IBU400', 'therapeutic'],
  ['IBU400', 'DICLO50', 'therapeutic'],
];

async function seedItems(ctx: SeedContext, tenancy: SeededTenancy, today: string): Promise<void> {
  const items: SeedRow[] = [];
  const uoms: SeedRow[] = [];
  const barcodes: SeedRow[] = [];
  const prices: SeedRow[] = [];
  const substitutes: SeedRow[] = [];
  const expenseHeads: SeedRow[] = [];

  const catalogue = allItems();

  for (const h of tenancy.hospitals) {
    catalogue.forEach((item, index) => {
      const id = itemId(h.code, item.code);
      const base = item.ladder[0];
      if (base === undefined) throw new Error(`Item ${item.code} has no conversion ladder`);
      const [baseUom] = base;

      items.push(
        row(id, h.id, {
          code: item.code,
          name: item.name,
          short_name: item.shortName,
          generic_name: item.generic,
          drug_key: item.drugCode === null ? null : drugKeyOf(h.code, item.drugCode),
          drug_brand_key: null,
          category_id: categoryId(h.code, item.category),
          item_type: item.itemType,
          manufacturer_id: item.manufacturer === null ? null : manufacturerId(h.code, item.manufacturer),
          base_uom_id: uomId(h.code, baseUom),
          purchase_uom_id: uomId(h.code, item.purchaseUom),
          issue_uom_id: uomId(h.code, item.issueUom),
          dispense_uom_id: uomId(h.code, item.dispenseUom),
          hsn_code_id: seedId('mdm-hsn', item.hsn),
          hsn_code: item.hsn,
          schedule: item.schedule,
          is_narcotic: item.isNarcotic,
          dpco_scheduled: item.dpcoScheduled,
          is_high_alert: item.highAlert,
          is_lasa: item.lasa,
          storage_condition: item.storage,
          temp_zone_required: item.tempZone,
          min_shelf_life_days: item.minShelfLifeDays,
          tracking: item.tracking,
          is_consignment_allowed: item.consignment,
          is_capital: false,
          is_returnable: item.itemType !== 'implant',
          is_billable: item.salePrice !== '0.01',
          billable_service_key: null,
          default_expense_head: expenseHeadOf(item.category),
          abc_class: item.abc,
          ved_class: item.ved,
          fsn_class: item.fsn,
          shelf_life_days: item.shelfLifeDays,
          lead_time_days: item.leadTimeDays,
          image_file_id: null,
          msds_file_id: null,
          notes: null,
          status: 'active',
          deleted_at: null,
          version: 0,
        }),
      );

      for (const [uom, factor, packLevel] of item.ladder) {
        uoms.push(
          row(seedId('inv-item-uom', h.code, item.code, uom), h.id, {
            item_id: id,
            uom_id: uomId(h.code, uom),
            pack_level: packLevel,
            factor_to_base: String(factor),
            // Exactly one base rung, and its factor is 1 by definition.
            // `enforce_item_uom` checks both directions of this.
            is_base: uom === baseUom,
            is_purchase_default: uom === item.purchaseUom,
            is_issue_default: uom === item.issueUom && item.issueUom !== item.purchaseUom,
            is_dispense_default: uom === item.dispenseUom && item.dispenseUom !== item.purchaseUom,
            gtin: null,
            active: true,
          }),
        );
      }

      // A synthetic GS1-shaped code. Structurally a 13-digit number and issued
      // to nobody: `docs/09 §11` forbids real identifiers in seed data, and a
      // real GTIN belongs to a real manufacturer's product.
      barcodes.push(
        row(seedId('inv-item-barcode', h.code, item.code), h.id, {
          item_id: id,
          item_uom_id: seedId('inv-item-uom', h.code, item.code, baseUom),
          symbology: item.tracking === 'none' ? 'ean13' : 'gs1_datamatrix',
          value: `890000${String(index + 1).padStart(7, '0')}`,
          carries_batch_expiry: item.tracking !== 'none',
          is_primary: true,
          active: true,
        }),
      );

      prices.push({
        ...row(seedId('inv-item-price', h.code, item.code, 'sale'), h.id, {
          branch_id: null,
          item_id: id,
          price_kind: 'sale',
          unit_price: item.salePrice,
          currency: 'INR',
          max_discount_pct: '5.00',
          // Today, read from the database. `inventory.refuse_retroactive_price`
          // refuses anything earlier, so this column is marked immutable in the
          // upsert below — a re-run next month must not try to move it.
          effective_from: today,
          effective_to: null,
          approved_by: null,
          approved_at: SEED_EPOCH,
          reason: 'Opening price list seeded with the demo item master.',
        }),
      });
    });

    for (const [from, to, kind] of SUBSTITUTES) {
      substitutes.push(
        row(seedId('inv-item-substitute', h.code, from, to), h.id, {
          item_id: itemId(h.code, from),
          substitute_item_id: itemId(h.code, to),
          kind,
          is_preferred: false,
          requires_prescriber_approval: true,
          equivalence_factor: '1',
          note: 'Same therapeutic class, different molecule — the prescriber decides.',
          active: true,
        }),
      );
    }

    for (const [code, , , expenseHead] of CATEGORIES) {
      expenseHeads.push(
        row(seedId('inv-expense-head', h.code, code), h.id, {
          item_id: null,
          category_id: categoryId(h.code, code),
          expense_head: expenseHead,
          gl_account_code: null,
          active: true,
        }),
      );
    }
  }

  // The item and its ladder go in together, in one transaction. See
  // `writeTogether` for why the pool cannot do this.
  await writeTogether(ctx, [
    [{ table: 'inventory.items', conflict: ['id'] }, items],
    [{ table: 'inventory.item_uoms', conflict: ['id'] }, uoms],
  ]);
  await ctx.write({ table: 'inventory.item_barcodes', conflict: ['id'] }, barcodes);
  await ctx.write({ table: 'inventory.item_substitutes', conflict: ['id'] }, substitutes);
  await ctx.write({ table: 'inventory.item_expense_heads', conflict: ['id'] }, expenseHeads);
  await ctx.write(
    { table: 'inventory.item_prices', conflict: ['id'], immutable: ['effective_from', 'approved_at'] },
    prices,
  );
}

function expenseHeadOf(categoryCode: string): string {
  return CATEGORIES.find((c) => c[0] === categoryCode)?.[3] ?? 'other';
}

// ── reorder parameters ──────────────────────────────────────────────────────

/**
 * Which store stocks what, and at what levels.
 *
 * Only three stores hold opening stock, and the split is not arbitrary:
 *
 *   `PHARM-OP`  every drug, because that is the counter `phase-04` exit gate 2
 *               dispenses from — and the only store here designated to hold
 *               narcotics, which is why morphine can be seeded nowhere else.
 *   `MAIN`      consumables, dressings, housekeeping and stationery.
 *   `CONSIGN`   the two implants, on consignment and owned by the vendor until
 *               they go into a patient.
 *   `LAB`       the cold-chain reagent, which also exercises the temperature zone.
 */
interface StockPlan {
  readonly store: string;
  readonly items: readonly string[];
  /** Base units per batch. Two entries means two batches, which is what FEFO needs to order. */
  readonly quantities: readonly number[];
}

function stockPlans(): readonly StockPlan[] {
  const drugCodes = DRUGS.map((d) => d.code);
  return [
    { store: 'PHARM-OP', items: drugCodes, quantities: [300, 200] },
    {
      store: 'MAIN',
      items: ['SYR-5ML', 'IV-SET', 'GLOVE-7', 'GAUZE-10', 'CANN-18', 'HK-PHEN', 'STAT-CASE'],
      quantities: [1000, 500],
    },
    { store: 'LAB', items: ['REAG-GLU'], quantities: [2000] },
    { store: 'CONSIGN', items: ['IMP-DHS', 'IMP-NAIL'], quantities: [2] },
  ];
}

async function seedItemStoreParams(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const catalogue = new Map(allItems().map((i) => [i.code, i]));
  const rows: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    for (const plan of stockPlans()) {
      const total = plan.quantities.reduce((sum, q) => sum + q, 0);
      for (const code of plan.items) {
        const item = catalogue.get(code);
        if (item === undefined) continue;
        rows.push(
          row(seedId('inv-item-store-params', h.code, plan.store, code), h.id, {
            item_id: itemId(h.code, code),
            store_id: storeId(h.code, plan.store),
            // Levels derived from the opening quantity so they are internally
            // consistent: a reorder level above the opening stock would put every
            // item on the replenishment list on day one and teach the buyer to
            // ignore it.
            min_qty: String(Math.round(total * 0.2)),
            max_qty: String(Math.round(total * 1.5)),
            reorder_level: String(Math.round(total * 0.3)),
            reorder_qty: String(total),
            safety_stock: String(Math.round(total * 0.15)),
            safety_auto: false,
            par_level: plan.store === 'PHARM-OP' ? String(Math.round(total * 0.5)) : null,
            lead_days: item.leadTimeDays,
            review_days: 7,
            bin_location_id: seedId('inv-store-location', h.code, `${plan.store}-A1`),
            auto_indent: item.ved === 'vital',
            preferred_source_store_id: plan.store === 'MAIN' ? null : storeId(h.code, 'MAIN'),
            is_stocked: true,
            abc_class: item.abc,
            ved_class: item.ved,
            fsn_class: item.fsn,
            classified_at: SEED_EPOCH,
            last_movement_at: null,
            dead_stock_flag: false,
          }),
        );
      }
    }
  }
  await ctx.write({ table: 'inventory.item_store_params', conflict: ['id'] }, rows);
}

// ── opening stock ───────────────────────────────────────────────────────────

/**
 * Batches, serials and the opening ledger entries.
 *
 * Two expiry dates, not one. A single expiry makes FEFO untestable: the picker
 * has nothing to order and the "first to expire" rule is satisfied by any
 * choice. The earlier batch is deliberately the smaller one, so a four-item
 * prescription of any size crosses the boundary and picks from both.
 *
 * The opening movement's `ref_id` is the batch itself. An opening balance has no
 * upstream document — that is what makes it an opening balance — and pointing
 * `ref_id` at a purchase order that never existed would be worse than pointing
 * it at the row that does.
 */
const EARLY_EXPIRY = '2027-03-31';
const LATE_EXPIRY = '2028-12-31';
const MFG_DATE = '2025-10-01';

async function seedOpeningStock(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const catalogue = new Map(allItems().map((i) => [i.code, i]));
  const batches: SeedRow[] = [];
  const serials: SeedRow[] = [];
  const ledger: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    const main = h.branches.find((b) => b.isMain);
    if (main === undefined) continue;

    for (const plan of stockPlans()) {
      const store = STORES.find((s) => s.code === plan.store);
      if (store === undefined) continue;

      for (const code of plan.items) {
        const item = catalogue.get(code);
        if (item === undefined) continue;
        const base = item.ladder[0];
        if (base === undefined) continue;

        const tracked = item.tracking !== 'none';
        const vendorCode = item.consignment
          ? 'VND-IMPL'
          : item.itemType === 'drug'
            ? 'VND-PHARMA'
            : 'VND-SURG';

        plan.quantities.forEach((qty, batchIndex) => {
          // A non-tracked item has one movement and no batch: the ledger's batch
          // requirement is conditional on the item, and this is the branch that
          // proves it.
          if (!tracked && batchIndex > 0) return;

          const batchNo = `B${code}-${batchIndex + 1}`;
          const batchKey = seedId('inv-item-batch', h.code, code, batchNo);
          const movedAt = seedDate(2 + batchIndex);

          if (tracked) {
            batches.push(
              row(batchKey, h.id, {
                item_id: itemId(h.code, code),
                batch_no: batchNo,
                mfg_date: MFG_DATE,
                expiry_date: batchIndex === 0 ? EARLY_EXPIRY : LATE_EXPIRY,
                mrp: item.mrp,
                unit_cost: item.unitCost,
                currency: 'INR',
                gtin: null,
                manufacturer_id:
                  item.manufacturer === null ? null : manufacturerId(h.code, item.manufacturer),
                vendor_id: vendorId(h.code, vendorCode),
                grn_line_id: null,
                coa_file_id: null,
                status: 'active',
                quarantine_reason: null,
                is_consignment: item.consignment,
                consignment_vendor_id: item.consignment ? vendorId(h.code, vendorCode) : null,
                received_at: movedAt,
                version: 0,
              }),
            );

            if (item.tracking === 'udi') {
              for (let n = 0; n < qty; n += 1) {
                const serialNo = `${code}-${batchNo}-${String(n + 1).padStart(3, '0')}`;
                serials.push(
                  row(seedId('inv-item-serial', h.code, serialNo), h.id, {
                    item_id: itemId(h.code, code),
                    batch_id: batchKey,
                    serial_no: serialNo,
                    udi_di: `0890000${String(n + 1).padStart(6, '0')}`,
                    udi_full: `(01)0890000${String(n + 1).padStart(6, '0')}(10)${batchNo}(21)${serialNo}`,
                    status: 'in_stock',
                    current_store_id: storeId(h.code, plan.store),
                    current_location_id: seedId('inv-store-location', h.code, `${plan.store}-A1`),
                    patient_id: null,
                    usage_ref_type: null,
                    usage_ref_id: null,
                    used_at: null,
                  }),
                );
              }
            }
          }

          // A cold-chain item goes on the cold bin, which exists because
          // `HAS_COLD_CHAIN` gave this store type a refrigerator. Putting it on
          // the general rack would make `temp_zone_required` decorative.
          const locationCode = item.tempZone ? `${plan.store}-COLD` : `${plan.store}-A1`;
          ledger.push({
            id: seedId('inv-ledger-opening', h.code, plan.store, code, String(batchIndex)),
            hospital_id: h.id,
            branch_id: main.id,
            store_id: storeId(h.code, plan.store),
            location_id: seedId('inv-store-location', h.code, locationCode),
            item_id: itemId(h.code, code),
            batch_id: tracked ? batchKey : null,
            serial_id: null,
            movement_type: 'opening',
            // Written in the item's own base UoM, so `enforce_qty_uom`
            // recomputes `qty_base` as `qty_entered × 1` and the two agree by
            // construction rather than by arithmetic somebody has to get right.
            qty_base: String(qty),
            qty_entered: String(qty),
            uom_id: uomId(h.code, base[0]),
            unit_cost: item.unitCost,
            value: (qty * Number(item.unitCost)).toFixed(2),
            currency: 'INR',
            ref_type: 'opening',
            ref_id: tracked ? batchKey : itemId(h.code, code),
            ref_line_id: null,
            counter_store_id: null,
            counter_ledger_id: null,
            patient_id: null,
            encounter_id: null,
            cost_centre_id: costCentreId(h.code, store.costCentre),
            // Must agree with the batch, or the month-end valuation books the
            // vendor's implants as our asset (`enforce_consignment_flag`).
            is_consignment: item.consignment,
            corrects_ledger_id: null,
            reason: null,
            remarks: 'Opening balance seeded with the demo item master.',
            actor_id: null,
            second_actor_id: null,
            moved_at: movedAt,
            created_at: SEED_EPOCH,
            created_by: null,
          });
        });
      }
    }
  }

  await ctx.write({ table: 'inventory.item_batches', conflict: ['id'] }, batches);
  await ctx.write({ table: 'inventory.item_serials', conflict: ['id'] }, serials);
  // The composite primary key of a partitioned table includes its partition
  // key, so the conflict target must too — conflicting on `id` alone would find
  // nothing and insert a duplicate movement on every run.
  await ctx.write({ table: 'inventory.stock_ledger', conflict: ['id', 'moved_at'] }, ledger);
}

// ── the consignment agreement ───────────────────────────────────────────────

/**
 * One live consignment agreement, covering the two implants.
 *
 * Without it the consignment store holds stock that can be received and never
 * used: NC-007 §5 blocks a usage with no active agreement and no agreed price,
 * and it is right to — an implant used off an expired agreement is one nobody
 * can invoice. The vendor price here is the item's cost, and the item's sale
 * price is what the patient is billed; the difference is the hospital's margin
 * and the reconciliation's subject.
 *
 * `wastage_policy` and `loss_policy` stay at `case_by_case`, which is the
 * database's own default and the honest one: who pays for an opened-and-unused
 * ₹18,500 plate is a commercial negotiation, and a seed that decided it for
 * every hospital would be inventing a contract term.
 */
const CONSIGNMENT_ITEMS = ['IMP-DHS', 'IMP-NAIL'] as const;

async function seedConsignmentAgreements(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const catalogue = new Map(allItems().map((i) => [i.code, i]));
  const agreements: SeedRow[] = [];
  const lines: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    const agreementId = seedId('csn-agreement', h.code, 'CSN-ORTHOMED-2026');
    agreements.push(
      row(agreementId, h.id, {
        branch_id: null,
        vendor_id: vendorId(h.code, 'VND-IMPL'),
        agreement_no: 'CSN/ORTHOMED/2026-27/001',
        start_date: '2026-04-01',
        end_date: '2027-03-31',
        invoicing_cycle: 'monthly',
        payment_terms_days: 45,
        expiry_return_days_before: 90,
        wastage_policy: 'case_by_case',
        loss_policy: 'case_by_case',
        replenishment_sla_days: 3,
        storage_location_ids: [seedId('inv-store-location', h.code, 'CONSIGN-A1')],
        vendor_reps: jsonb([{ name: 'Territory manager', phone: '+91-80-0000-0000' }]),
        document_file_id: null,
        status: 'active',
        approved_by: null,
        approved_at: SEED_EPOCH,
        version: 0,
      }),
    );

    for (const code of CONSIGNMENT_ITEMS) {
      const item = catalogue.get(code);
      if (item === undefined) continue;
      lines.push(
        row(seedId('csn-agreement-item', h.code, code), h.id, {
          agreement_id: agreementId,
          item_id: itemId(h.code, code),
          vendor_item_code: `ORTHOMED/${code}`,
          udi_di: null,
          gtin: null,
          vendor_price: item.unitCost,
          currency: 'INR',
          mrp: item.mrp,
          // Orthopaedic implants sit at 5% GST (HSN 9021), not the 12% a
          // medicament carries. Getting this wrong understates the vendor's
          // invoice on every case.
          gst_rate: '5.00',
          min_stock_base: '2',
          kit_template_id: null,
          replacement_policy: 'like_for_like_within_7_days',
          price_valid_from: '2026-04-01',
          price_valid_to: '2027-03-31',
          active: true,
        }),
      );
    }
  }

  await ctx.write({ table: 'inventory.csn_agreements', conflict: ['id'] }, agreements);
  await ctx.write({ table: 'inventory.csn_agreement_items', conflict: ['id'] }, lines);
}

// ── vendor item mapping, rate contract and purchase settings ────────────────

async function seedPurchaseSettings(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const catalogue = allItems();
  const maps: SeedRow[] = [];
  const contracts: SeedRow[] = [];
  const contractLines: SeedRow[] = [];
  const settings: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    for (const item of catalogue) {
      const vendorCode = item.consignment
        ? 'VND-IMPL'
        : item.itemType === 'drug'
          ? 'VND-PHARMA'
          : item.itemType === 'reagent'
            ? 'VND-REAG'
            : 'VND-SURG';
      maps.push(
        row(seedId('inv-vendor-item', h.code, vendorCode, item.code), h.id, {
          vendor_id: vendorId(h.code, vendorCode),
          item_id: itemId(h.code, item.code),
          vendor_item_code: `${vendorCode}/${item.code}`,
          brand: null,
          preferred_rank: 1,
          lead_time_days: item.leadTimeDays,
          moq: '1',
          moq_uom_id: uomId(h.code, item.purchaseUom),
          last_price: item.unitCost,
          last_po_date: null,
          active: true,
        }),
      );
    }

    // One live rate contract for the drug distributor. NC-005 §3.7 makes the
    // contracted rate the price a new order is raised at, so it exists here for
    // the auto-pricing path to have something to find.
    const contractId = seedId('inv-rate-contract', h.code, 'RC-PHARMA-2026');
    contracts.push(
      row(contractId, h.id, {
        branch_id: null,
        vendor_id: vendorId(h.code, 'VND-PHARMA'),
        contract_no: 'RC/PHARMA/2026-27/001',
        title: 'Annual rate contract — pharmaceuticals',
        source: 'rfq',
        valid_from: '2026-04-01',
        valid_to: '2027-03-31',
        max_value: '5000000.00',
        currency: 'INR',
        delivery_sla_days: 3,
        min_shelf_life_pct: '75.00',
        penalty_terms: 'Late delivery beyond the SLA attracts 0.5% per week, capped at 5% of line value.',
        split_share_pct: null,
        document_file_id: null,
        status: 'active',
        approved_by: null,
        approved_at: SEED_EPOCH,
        previous_id: null,
        version: 0,
      }),
    );

    for (const item of catalogue.filter((i) => i.itemType === 'drug').slice(0, 10)) {
      contractLines.push(
        row(seedId('inv-rate-contract-line', h.code, 'RC-PHARMA-2026', item.code), h.id, {
          contract_id: contractId,
          item_id: itemId(h.code, item.code),
          uom_id: uomId(h.code, item.purchaseUom),
          rate: item.unitCost,
          currency: 'INR',
          discount_pct: '0.00',
          free_qty_per_unit: '0',
          hsn_code: item.hsn,
          moq: '1',
          valid_from: '2026-04-01',
          valid_to: '2027-03-31',
          utilised_qty: '0',
          utilised_value: '0.00',
        }),
      );
    }

    settings.push(
      row(seedId('inv-pur-settings', h.code), h.id, {
        branch_id: null,
        // NC-005 §3.14 seed defaults. Zero quantity tolerance is not
        // conservatism: a receipt that does not match the order is a question,
        // and the exception queue is where a human answers it.
        qty_tolerance_pct: '0.00',
        qty_tolerance_abs_base: '0',
        price_tolerance_pct: '2.00',
        price_tolerance_abs: '5.00',
        tax_tolerance_abs: '1.00',
        receipt_tolerance_pct: '0.00',
        min_vendors_for_rfq: 3,
        rfq_threshold_amount: '100000.00',
        // "regularisation 48 h" (NC-005 §3.14), expressed in the column's unit.
        emergency_regularise_days: 2,
        default_min_shelf_life_pct: '0.00',
        require_qc_before_accept: true,
        version: 0,
      }),
    );
  }

  await ctx.write({ table: 'inventory.vnd_item_map', conflict: ['id'] }, maps);
  await ctx.write({ table: 'inventory.vnd_rate_contracts', conflict: ['id'] }, contracts);
  await ctx.write({ table: 'inventory.vnd_rate_contract_lines', conflict: ['id'] }, contractLines);
  await ctx.write({ table: 'inventory.pur_settings', conflict: ['id'] }, settings);
}
