import type { SeedContext } from './context.js';
import { SEED_EPOCH, seedId } from './ids.js';
import { storeId } from './inventory.js';
import type { SeededTenancy } from './tenancy.js';
import { demoUsers } from './users.js';
import { jsonb, type SeedRow } from './upsert.js';

/**
 * Phase 4 — the pharmacy counters and the statutory limits they dispense under.
 *
 * Two things are seeded here and they are seeded for opposite reasons.
 *
 * **The counters** are configuration a hospital owns: which windows exist, what
 * licences they hold, which languages their labels print in. They are demo data.
 *
 * **The controlled-substance limits** are not. `pharmacy.controlled_substance_
 * limits` exists because the obvious design — a `max_course_days` on every
 * controlled drug — encodes a rule that does not exist, and the migration's own
 * §C.4 comment says so at length. What follows is the statute, seeded globally
 * with `basis = 'statutory'`, which the database refuses to let a tenant author
 * or downgrade to a warning.
 */
export async function seedPharmacy(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  await seedControlledSubstanceLimits(ctx);
  await seedPharmacyStores(ctx, tenancy);
}

/**
 * The pharmacy counters, one per store of type `pharmacy`.
 *
 * The licence dates are far-dated on purpose. `pharmacy.enforce_dispense_line`
 * refuses a Schedule H/H1/X drug from a counter whose Form 20/21 licence has
 * lapsed, and an NDPS line from one whose NDPS recognition has, both against
 * `current_date`. A demo whose pharmacy stops dispensing on the next financial
 * year boundary teaches everybody that the licence check is noise.
 *
 * `label_locales` is `en-IN` plus Kannada: `phase-04` exit gate 2 wants labels
 * in "English + one Indian language", and both demo hospitals are in Karnataka.
 */
const PHARMACY_COUNTERS: readonly (readonly [
  storeCode: string,
  code: string,
  name: string,
  type: string,
  is24x7: boolean,
  ndps: boolean,
  mainBranchOnly: boolean,
])[] = [
  ['PHARM-OP', 'PH-OP', 'Outpatient Pharmacy Counter', 'op_retail', true, true, true],
  ['PHARM-IP', 'PH-IP', 'Inpatient Pharmacy', 'ip', true, true, true],
  ['PHARM-SAT', 'PH-SAT', 'Satellite Pharmacy Counter', 'satellite', false, false, false],
];

async function seedPharmacyStores(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const users = demoUsers(tenancy);
  const rows: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    const pharmacists = users
      .filter(
        (u) =>
          u.hospital.code === h.code &&
          (u.roleKey === 'pharmacist_op' ||
            u.roleKey === 'pharmacist_ip' ||
            u.roleKey === 'pharmacy_incharge'),
      )
      .map((u) => u.id);

    for (const b of h.branches) {
      for (const [storeCode, code, name, type, is24x7, ndps, mainOnly] of PHARMACY_COUNTERS) {
        if (mainOnly !== b.isMain) continue;
        rows.push({
          id: seedId('ph-store', h.code, code),
          hospital_id: h.id,
          branch_id: b.id,
          store_id: storeId(h.code, storeCode),
          code,
          name,
          pharmacy_type: type,
          licence_no: `SYNTH/FORM20-21/${h.code}/${code}`,
          licence_type: 'form_20_21',
          licence_valid_to: '2035-03-31',
          // NDPS Rules 1985 r.52Q: only a Recognised Medical Institution may
          // dispense an essential narcotic drug. The satellite counter has no
          // recognition, and therefore no morphine — which is also why the
          // satellite store is not designated to hold narcotics.
          ndps_licence_no: ndps ? `SYNTH/RMI/${h.code}/${code}` : null,
          ndps_licence_valid_to: ndps ? '2035-03-31' : null,
          gstin: h.gstin,
          registered_pharmacist_ids: pharmacists,
          counters: jsonb([
            { code: `${code}-1`, name: 'Counter 1' },
            { code: `${code}-2`, name: 'Counter 2' },
          ]),
          is_24x7: is24x7,
          print_profile_id: null,
          label_locales: ['en-IN', 'kn'],
          active: true,
          created_at: SEED_EPOCH,
          created_by: null,
          updated_at: SEED_EPOCH,
          updated_by: null,
          version: 0,
        });
      }
    }
  }

  await ctx.write({ table: 'pharmacy.pharmacy_stores', conflict: ['id'] }, rows);
}

/**
 * The statutory ceilings on controlled substances — and, deliberately, the ones
 * that do not exist.
 *
 * **NDPS Rules 1985, rule 66(2)** is the only hard number in the regime: 100
 * dosage units of a psychotropic substance for personal medical use, or 300
 * where the prescriber has specifically prescribed for long-term personal
 * medical use. It binds Schedule X and the psychotropic Schedule H1 drugs.
 *
 * **The Essential Narcotic Drugs regime does not contain one.** Chapters VA and
 * VB of the NDPS Rules, inserted by G.S.R. 359(E) of 5 May 2015, carry no
 * maximum duration and no maximum quantity per patient. Rule 52U caps what the
 * *institution* may hold against its Form 3J estimate — not what a patient may
 * be prescribed — and rule 52G(i) delegates the period of consumption to the
 * prescriber by requiring them to state it.
 *
 * So `max_course_days` is **null on every row here**, and that is the finding
 * rather than an omission. `docs/DECISIONS.md` open question O-1 records it:
 * `clinical.cdss_kb_dose_rules` holds no `max_course_days`, so a controlled drug
 * currently hard-stops with "no statutory cap configured". The correct fix is a
 * licensed drug knowledge base or a hospital policy row a pharmacy in-charge
 * authors — not a number invented in a seed. India's morphine consumption fell
 * about 92% under the pre-2015 licensing regime and the 2014 amendment exists to
 * undo that; a fabricated seven-day ceiling shipped as a product default would
 * quietly rebuild it in every hospital that installed this.
 *
 * `hospital_id` is null on all of them because
 * `pharmacy.enforce_controlled_limit_authority` refuses a tenant-authored
 * statutory limit outright: rule 66(2) is the same statute in every hospital.
 */
const CONTROLLED_LIMITS: readonly (readonly [
  key: string,
  schedule: string,
  maxUnits: number | null,
  maxUnitsLongTerm: number | null,
  retentionYears: number,
  secondPerson: boolean,
  legalBasis: string,
  notes: string,
])[] = [
  [
    'ndps-r66-schedule-x',
    'x',
    100,
    300,
    2,
    true,
    'NDPS Rules 1985, rule 66(2)',
    'Quantity ceiling for personal medical use; 300 dosage units where the prescriber has specifically prescribed for long-term use. No duration ceiling exists in the rule, so max_course_days is null (docs/DECISIONS.md O-1).',
  ],
  [
    'ndps-r66-schedule-h1',
    'h1',
    100,
    300,
    3,
    false,
    'NDPS Rules 1985, rule 66(2); Drugs and Cosmetics Rules 1945, Schedule H1',
    'Applies to the psychotropic substances within Schedule H1. The H1 register itself is retained three years with prescriber details (docs/04 §1). No duration ceiling exists, so max_course_days is null.',
  ],
  [
    'ndps-end-narcotic',
    'ndps_narcotic',
    null,
    null,
    10,
    true,
    'NDPS Rules 1985, Chapters VA and VB (G.S.R. 359(E), 5 May 2015), rules 52G(i), 52T and 52U',
    'Essential Narcotic Drugs carry NO statutory maximum quantity and NO maximum course duration. Rule 52U caps the institution’s holding against its Form 3J estimate, not the patient’s prescription, and rule 52T’s Explanation permits even that to be exceeded with a recorded justification. What the statute does require is dual authorisation and a register — both enforced by the database. max_course_days is null and stays null until a hospital authors a stricter policy row of its own (docs/DECISIONS.md O-1).',
  ],
  [
    'ndps-end-psychotropic',
    'ndps_psychotropic',
    100,
    300,
    10,
    true,
    'NDPS Rules 1985, rule 66(2) and Chapter VI',
    'Psychotropic substances take the rule 66(2) dosage-unit ceiling. No duration ceiling exists, so max_course_days is null.',
  ],
];

async function seedControlledSubstanceLimits(ctx: SeedContext): Promise<void> {
  const rows: SeedRow[] = CONTROLLED_LIMITS.map(
    ([key, schedule, maxUnits, maxLongTerm, retention, secondPerson, legalBasis, notes]) => ({
      id: seedId('ph-controlled-limit', key),
      // Global. The trigger refuses `basis = 'statutory'` with a hospital.
      hospital_id: null,
      schedule,
      item_id: null,
      drug_key: null,
      basis: 'statutory',
      max_dosage_units: maxUnits,
      max_dosage_units_long_term: maxLongTerm,
      // Null on every row, on purpose. See the comment above CONTROLLED_LIMITS.
      max_course_days: null,
      // The trigger also refuses a statutory limit that only warns: "a statutory
      // limit that only warns is not a limit."
      is_enforced: true,
      refill_allowed_by_default: false,
      record_retention_years: retention,
      requires_second_person: secondPerson,
      legal_basis: legalBasis,
      notes,
      effective_from: '2015-05-05',
      effective_to: null,
      active: true,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      updated_by: null,
    }),
  );

  await ctx.write({ table: 'pharmacy.controlled_substance_limits', conflict: ['id'] }, rows);
}
