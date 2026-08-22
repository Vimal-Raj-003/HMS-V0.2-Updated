import type { SeedContext } from './context.js';
import { SEED_EPOCH, seedId } from './ids.js';
import { jsonb, type SeedRow, type SeedValue } from './upsert.js';
import { type SeededTenancy } from './tenancy.js';

/**
 * The Phase-3 diagnostics configuration: the laboratory catalogue and its
 * reference intervals, the rejection list, TAT targets, the Westgard rule set,
 * one interfaced analyzer, the imaging procedure catalogue with its diagnostic
 * reference levels, and the OP-022 investigation services.
 *
 * Three rules govern what is here rather than invented, and the third is the one
 * this file exists to obey:
 *
 *   1. **Nothing is shipped as product content.** A test catalogue, a reference
 *      interval, a Westgard rule set and a diagnostic reference level are all
 *      things a laboratory or an imaging department authors under its own
 *      accreditation. These rows are seeded *per hospital* and are a
 *      demonstration, not a formulary — the real catalogue arrives through
 *      EN-036 or is typed by the quality manager.
 *
 *   2. **The catalogue is chosen so the Phase-3 exit gates have something real
 *      to fire on.** A potassium with a genuine panic range for the
 *      critical-value loop; a haemoglobin and a creatinine for the ordinary
 *      path; a blood culture for microbiology; an obstetric ultrasound for
 *      PC-PNDT; a CT head for the dose register and the DRL comparison.
 *
 *   3. **Every threshold seeded here is covered by `lab-ranges.spec.ts`.**
 *      `OP-007`'s vitals ranges were seeded once with the *abnormal* band in the
 *      columns that bound the *normal* band, and no schema CHECK could catch it
 *      — every row satisfied `low_critical <= low <= high <= high_critical`.
 *      Only a test that knows what a healthy adult's potassium looks like can,
 *      which is what that file is. Read the comment on `LAB_RANGES` before
 *      touching a number in it.
 */
export async function seedDiagnostics(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  await seedLabCatalogue(ctx, tenancy);
  await seedLabReferenceRanges(ctx, tenancy);
  await seedLabOperations(ctx, tenancy);
  await seedLabQuality(ctx, tenancy);
  await seedRadiologyCatalogue(ctx, tenancy);
  await seedInvestigationServices(ctx, tenancy);
}

/**
 * The columns every effective-dated master carries, in one place.
 *
 * `absent` names the governance columns a particular table does not have. Not
 * every master carries the full set: a test parameter and a panel member belong
 * to their parent test rather than to a branch, and a reference interval is
 * approved by the laboratory director rather than through an EN-027 change set.
 * Passing a column a table lacks is a runtime error from `pg`, which is a
 * perfectly good failure — but naming the difference here is what makes it
 * legible.
 */
function master(
  table: string,
  hospitalId: string,
  recordKey: string,
  branchId: string | null,
  columns: Record<string, SeedValue>,
  absent: readonly string[] = [],
): SeedRow {
  const row: SeedRow = {
    id: seedId(`${table}-v1`, recordKey),
    record_key: recordKey,
    hospital_id: hospitalId,
    branch_id: branchId,
    version: 1,
    ...columns,
    effective_from: SEED_EPOCH,
    effective_to: null,
    status: 'active',
    change_set_id: null,
    replaced_by_key: null,
    approved_by: null,
    approved_at: SEED_EPOCH,
    created_at: SEED_EPOCH,
    created_by: null,
    updated_at: SEED_EPOCH,
    updated_by: null,
  };
  for (const key of absent) delete row[key];
  return row;
}

/** Columns a table does not have, by table. */
const NO_BRANCH_NO_REPLACED = ['branch_id', 'replaced_by_key'] as const;
const NO_REPLACED = ['replaced_by_key'] as const;
const NO_CHANGESET_NO_REPLACED = ['change_set_id', 'replaced_by_key'] as const;

// ── specimens, containers, tests ────────────────────────────────────────────

/** code, name, SNOMED, stability hours for add-ons, retention days. */
const SPECIMEN_TYPES: readonly (readonly [string, string, string, number, number])[] = [
  ['SER', 'Serum', '119364003', 24, 7],
  ['EDTA', 'Whole blood (EDTA)', '445295009', 24, 2],
  ['CIT', 'Whole blood (sodium citrate)', '446272009', 4, 1],
  ['FLU', 'Whole blood (sodium fluoride)', '119297000', 8, 2],
  ['URN', 'Urine', '122575003', 4, 1],
  ['BLDC', 'Blood for culture', '119297000', 0, 7],
  ['TIS', 'Tissue', '119376003', 0, 3650],
];

/**
 * code, name, cap colour, hex, additive, draw volume ml, CLSI GP41 order of
 * draw, inversions, specimen type.
 *
 * The order of draw is not decoration: drawing an EDTA tube before a citrate one
 * carries potassium-EDTA into the coagulation sample and produces an
 * uninterpretable INR. The unique index on `(hospital_id, order_of_draw)` is
 * what stops two tubes claiming the same position.
 */
const CONTAINERS: readonly (readonly [
  string,
  string,
  string,
  string,
  string | null,
  number,
  number,
  number,
  string,
])[] = [
  ['BC-BOT', 'Blood culture bottle', 'Yellow-black', '#8a7f2a', 'Broth', 10, 1, 8, 'BLDC'],
  ['CIT-BLU', 'Citrate tube', 'Light blue', '#7fb2e5', '3.2% sodium citrate', 2.7, 2, 4, 'CIT'],
  ['SST-GLD', 'Serum separator tube', 'Gold', '#d4a017', 'Clot activator + gel', 5, 3, 5, 'SER'],
  ['HEP-GRN', 'Lithium heparin tube', 'Green', '#2e8b57', 'Lithium heparin', 4, 4, 8, 'SER'],
  ['EDTA-LAV', 'EDTA tube', 'Lavender', '#b39ddb', 'K2 EDTA', 3, 5, 8, 'EDTA'],
  [
    'FLU-GRY',
    'Fluoride oxalate tube',
    'Grey',
    '#9e9e9e',
    'Sodium fluoride / potassium oxalate',
    2,
    6,
    8,
    'FLU',
  ],
  ['URN-CUP', 'Urine container', 'White', '#f5f5f5', null, 30, 7, 0, 'URN'],
];

/**
 * code, name, short code, LOINC, discipline, specimen, container, result type,
 * unit, decimals, method, TAT (routine/urgent/stat minutes), NABL scope,
 * sensitive, fasting hours or null, absurd low, absurd high.
 */
const LAB_TESTS: readonly (readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string | null,
  string,
  string | null,
  number | null,
  string,
  number,
  number,
  number,
  boolean,
  boolean,
  number | null,
  number | null,
  number | null,
])[] = [
  // The critical-value workhorse. `phase-03` exit gate 2 is a critical potassium.
  [
    'K',
    'Potassium, serum',
    'K',
    '2823-3',
    'biochemistry',
    'SER',
    'SST-GLD',
    'numeric',
    'mmol/L',
    1,
    'ISE indirect',
    240,
    60,
    30,
    true,
    false,
    null,
    0.5,
    12,
  ],
  [
    'NA',
    'Sodium, serum',
    'Na',
    '2951-2',
    'biochemistry',
    'SER',
    'SST-GLD',
    'numeric',
    'mmol/L',
    0,
    'ISE indirect',
    240,
    60,
    30,
    true,
    false,
    null,
    80,
    200,
  ],
  [
    'CREA',
    'Creatinine, serum',
    'Creat',
    '2160-0',
    'biochemistry',
    'SER',
    'SST-GLD',
    'numeric',
    'mg/dL',
    2,
    'Jaffe kinetic',
    240,
    90,
    45,
    true,
    false,
    null,
    0.05,
    40,
  ],
  [
    'GLUF',
    'Glucose, fasting',
    'FBS',
    '1558-6',
    'biochemistry',
    'FLU',
    'FLU-GRY',
    'numeric',
    'mg/dL',
    0,
    'Hexokinase',
    240,
    90,
    45,
    true,
    false,
    8,
    5,
    1200,
  ],
  [
    'HB',
    'Haemoglobin',
    'Hb',
    '718-7',
    'haematology',
    'EDTA',
    'EDTA-LAV',
    'numeric',
    'g/dL',
    1,
    'SLS haemoglobin',
    180,
    60,
    30,
    true,
    false,
    null,
    1,
    25,
  ],
  [
    'PLT',
    'Platelet count',
    'Plt',
    '777-3',
    'haematology',
    'EDTA',
    'EDTA-LAV',
    'numeric',
    '10^3/uL',
    0,
    'Impedance',
    180,
    60,
    30,
    true,
    false,
    null,
    1,
    3000,
  ],
  [
    'INR',
    'INR',
    'INR',
    '6301-6',
    'haematology',
    'CIT',
    'CIT-BLU',
    'numeric',
    'ratio',
    2,
    'Clot detection',
    240,
    60,
    30,
    true,
    false,
    null,
    0.5,
    15,
  ],
  [
    'TSH',
    'TSH',
    'TSH',
    '3016-3',
    'immunology',
    'SER',
    'SST-GLD',
    'numeric',
    'uIU/mL',
    3,
    'CLIA',
    480,
    240,
    120,
    true,
    false,
    null,
    0.001,
    200,
  ],
  // Sensitive: no WhatsApp/SMS delivery, and `lab.result.sensitive.read` gates it.
  [
    'HIV',
    'HIV 1 & 2 antibody/antigen screen',
    'HIV',
    '75622-1',
    'serology',
    'SER',
    'SST-GLD',
    'qualitative',
    null,
    null,
    'CLIA (4th generation)',
    720,
    480,
    240,
    true,
    true,
    null,
    null,
    null,
  ],
  [
    'BLDCUL',
    'Blood culture and sensitivity',
    'BldCS',
    '600-7',
    'microbiology',
    'BLDC',
    'BC-BOT',
    'microbiology',
    null,
    null,
    'Automated continuous monitoring',
    4320,
    4320,
    4320,
    true,
    false,
    null,
    null,
    null,
  ],
  [
    'HPE',
    'Histopathology, routine',
    'HPE',
    '11529-5',
    'histopathology',
    'TIS',
    null,
    'histopathology',
    null,
    null,
    'H&E, paraffin section',
    10080,
    7200,
    4320,
    false,
    false,
    null,
    null,
    null,
  ],
];

/** panel code, name, member test codes. */
const LAB_PANELS: readonly (readonly [string, string, readonly string[]])[] = [
  ['RFT', 'Renal function test', ['NA', 'K', 'CREA']],
  ['CBC', 'Complete blood count', ['HB', 'PLT']],
];

async function seedLabCatalogue(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const specimens: SeedRow[] = [];
  const containers: SeedRow[] = [];
  const tests: SeedRow[] = [];
  const panels: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    for (const [code, name, snomed, stability, retention] of SPECIMEN_TYPES) {
      specimens.push(
        master('lab-specimen', h.id, specimenKey(h.code, code), null, {
          code,
          name,
          snomed_code: snomed,
          hl7_code: code,
          stability_hours: stability > 0 ? stability : null,
          storage_temp_c: null,
          retention_days: retention,
          is_biohazard: true,
        }),
      );
    }

    for (const [code, name, colour, hex, additive, volume, order, inversions, spec] of CONTAINERS) {
      containers.push(
        master('lab-container', h.id, containerKey(h.code, code), null, {
          code,
          name,
          cap_colour: colour,
          cap_colour_hex: hex,
          additive,
          draw_volume_ml: volume,
          min_volume_ml: Math.max(0.5, volume / 2),
          order_of_draw: order,
          inversions,
          specimen_type_key: specimenKey(h.code, spec),
        }),
      );
    }

    for (const t of LAB_TESTS) {
      const [
        code,
        name,
        shortCode,
        loinc,
        discipline,
        specimen,
        container,
        resultType,
        unit,
        decimals,
        method,
        tatRoutine,
        tatUrgent,
        tatStat,
        nabl,
        sensitive,
        fasting,
        absurdLow,
        absurdHigh,
      ] = t;
      tests.push(
        master('lab-test', h.id, testKey(h.code, code), null, {
          code,
          name,
          short_code: shortCode,
          loinc_code: loinc,
          snomed_code: null,
          discipline,
          department_key: null,
          specimen_type_key: specimenKey(h.code, specimen),
          container_key: container === null ? null : containerKey(h.code, container),
          volume_ml: 2,
          is_panel: false,
          result_type: resultType,
          unit,
          decimals,
          method,
          is_calculated: false,
          calc_formula_key: null,
          tat_routine_minutes: tatRoutine,
          tat_urgent_minutes: tatUrgent,
          tat_stat_minutes: tatStat,
          is_outsourced_default: false,
          referral_lab_key: null,
          is_nabl_scope: nabl,
          is_sensitive: sensitive,
          requires_fasting: fasting !== null,
          fasting_hours: fasting,
          prep_instruction_key: null,
          service_key: null,
          reflex_rules: null,
          is_orderable: true,
          absurd_low: absurdLow,
          absurd_high: absurdHigh,
          notes: null,
        }),
      );
    }

    for (const [code, name, members] of LAB_PANELS) {
      tests.push(
        master('lab-test', h.id, testKey(h.code, code), null, {
          code,
          name,
          short_code: code,
          loinc_code: null,
          snomed_code: null,
          discipline: 'biochemistry',
          department_key: null,
          specimen_type_key: specimenKey(h.code, 'SER'),
          container_key: containerKey(h.code, 'SST-GLD'),
          volume_ml: 5,
          is_panel: true,
          result_type: 'numeric',
          unit: null,
          decimals: null,
          method: null,
          is_calculated: false,
          calc_formula_key: null,
          tat_routine_minutes: 240,
          tat_urgent_minutes: 90,
          tat_stat_minutes: 45,
          is_outsourced_default: false,
          referral_lab_key: null,
          is_nabl_scope: true,
          is_sensitive: false,
          requires_fasting: false,
          fasting_hours: null,
          prep_instruction_key: null,
          service_key: null,
          reflex_rules: null,
          is_orderable: true,
          absurd_low: null,
          absurd_high: null,
          notes: null,
        }),
      );

      members.forEach((memberCode, index) => {
        panels.push(
          master(
            'lab-panel-member',
            h.id,
            panelMemberKey(h.code, code, memberCode),
            null,
            {
              panel_key: testKey(h.code, code),
              member_test_key: testKey(h.code, memberCode),
              sequence: index,
              is_optional: false,
            },
            NO_BRANCH_NO_REPLACED,
          ),
        );
      });
    }
  }

  await ctx.write(
    { table: 'mdm.mdm_lab_specimen_types', conflict: ['id'], immutable: ['approved_at'] },
    specimens,
  );
  await ctx.write(
    { table: 'mdm.mdm_lab_containers', conflict: ['id'], immutable: ['approved_at'] },
    containers,
  );
  await ctx.write({ table: 'mdm.mdm_lab_tests', conflict: ['id'], immutable: ['approved_at'] }, tests);
  await ctx.write(
    { table: 'mdm.mdm_lab_panel_members', conflict: ['id'], immutable: ['approved_at'] },
    panels,
  );
}

// ── reference intervals ─────────────────────────────────────────────────────

/**
 * test code, ageMin days, ageMax days, sex, **low, high** (the NORMAL band),
 * **critical_low, critical_high** (the PANIC bounds), unit.
 *
 * ── Read this before changing a number ──────────────────────────────────────
 *
 * `low`/`high` bound the **normal** interval — a value outside them is flagged
 * L or H — and `critical_low`/`critical_high` are the **panic** bounds, outside
 * which `OP-004 §3.5` fires the critical-value loop immediately. The schema's
 * `lab_result_versions_ref_order` CHECK (`critical_low <= low`,
 * `critical_high >= high`) only makes sense under that reading.
 *
 * This is exactly where `OP-007`'s vitals ranges went wrong: §5.1 tabulates the
 * *amber* and *red* bands, those numbers were copied straight into the columns
 * that bound the *normal* band, and the result was an inversion — 37.0 °C read
 * amber while 38.5 °C read normal. Every row satisfied the ordering CHECK, so
 * nothing in the database could catch it. `src/seed/lab-ranges.spec.ts` is the
 * thing that can: it asserts that an ordinary adult reads normal on every
 * analyte, that each value a clinician would call a panic value reads critical,
 * and that every analyte with a panic threshold actually carries one — because
 * a potassium of 7.1 that produces an H rather than a critical flag raises no
 * alert at all, and the whole of §C.6 never runs.
 *
 * Sources: adult intervals are the common Indian laboratory consensus values
 * (a hospital replaces them with its own, established on its own instruments,
 * which is what `EN-031 §5`'s method validation is for); the panic limits are
 * the widely published critical-value list — potassium < 2.5 or > 6.0,
 * sodium < 120 or > 160, haemoglobin < 7, platelets < 20 or > 1000,
 * INR > 5, glucose < 50 or > 400, creatinine > 5.
 */
export const LAB_RANGES: readonly (readonly [
  test: string,
  ageMinDays: number,
  ageMaxDays: number,
  sex: string,
  low: number | null,
  high: number | null,
  criticalLow: number | null,
  criticalHigh: number | null,
  unit: string,
])[] = [
  ['K', 6570, 43800, 'any', 3.5, 5.1, 2.5, 6.0, 'mmol/L'],
  ['K', 0, 6569, 'any', 3.4, 5.6, 2.8, 6.5, 'mmol/L'],
  ['NA', 6570, 43800, 'any', 136, 145, 120, 160, 'mmol/L'],
  ['CREA', 6570, 43800, 'male', 0.7, 1.3, null, 5.0, 'mg/dL'],
  ['CREA', 6570, 43800, 'female', 0.6, 1.1, null, 5.0, 'mg/dL'],
  ['GLUF', 6570, 43800, 'any', 70, 99, 50, 400, 'mg/dL'],
  ['HB', 6570, 43800, 'male', 13.0, 17.0, 7.0, 20.0, 'g/dL'],
  ['HB', 6570, 43800, 'female', 12.0, 15.0, 7.0, 20.0, 'g/dL'],
  ['PLT', 6570, 43800, 'any', 150, 410, 20, 1000, '10^3/uL'],
  ['INR', 6570, 43800, 'any', 0.8, 1.2, null, 5.0, 'ratio'],
  ['TSH', 6570, 43800, 'any', 0.4, 4.0, null, null, 'uIU/mL'],
];

/**
 * A qualitative analyte's normal answer, and the coded values that are critical.
 * A reactive HIV screen is not a "high" number; it is a coded result that must
 * reach a counsellor, and `lab_reference_ranges.critical_coded_values` is how
 * the evaluator knows that without special-casing the test code.
 */
export const LAB_CODED_RANGES: readonly (readonly [
  test: string,
  textNormal: string,
  criticalCoded: readonly string[],
])[] = [['HIV', 'Non-reactive', ['Reactive']]];

async function seedLabReferenceRanges(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const rows: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    for (const [test, ageMin, ageMax, sex, low, high, criticalLow, criticalHigh, unit] of LAB_RANGES) {
      rows.push(
        master(
          'lab-range',
          h.id,
          rangeKey(h.code, test, ageMin, sex),
          null,
          {
            test_key: testKey(h.code, test),
            parameter_key: null,
            sex,
            age_min_days: ageMin,
            age_max_days: ageMax,
            pregnancy: null,
            specimen_type_key: null,
            method: null,
            unit,
            low,
            high,
            critical_low: criticalLow,
            critical_high: criticalHigh,
            text_normal: null,
            critical_coded_values: [],
            interpretation_note: null,
          },
          NO_CHANGESET_NO_REPLACED,
        ),
      );
    }

    for (const [test, textNormal, criticalCoded] of LAB_CODED_RANGES) {
      rows.push(
        master(
          'lab-range',
          h.id,
          rangeKey(h.code, test, 0, 'any'),
          null,
          {
            test_key: testKey(h.code, test),
            parameter_key: null,
            sex: 'any',
            age_min_days: 0,
            age_max_days: 43800,
            pregnancy: null,
            specimen_type_key: null,
            method: null,
            unit: null,
            low: null,
            high: null,
            critical_low: null,
            critical_high: null,
            text_normal: textNormal,
            critical_coded_values: [...criticalCoded],
            interpretation_note:
              'A reactive screen requires a confirmatory assay and pre-test/post-test counselling before release. Never delivered by SMS or WhatsApp (OP-004 §3.6.3).',
          },
          NO_CHANGESET_NO_REPLACED,
        ),
      );
    }
  }

  await ctx.write({ table: 'lab.lab_reference_ranges', conflict: ['id'], immutable: ['approved_at'] }, rows);
}

// ── the operational configuration a laboratory cannot start without ─────────

/**
 * The NABL 112 pre-analytical rejection list. `OP-004 §3.2.3` names these
 * outright; a hospital adds its own, which is why this is a table and not an
 * enum.
 *
 * code, label, NABL category, notify patient.
 */
const REJECTION_REASONS: readonly (readonly [string, string, string, boolean])[] = [
  ['HAEM', 'Haemolysed specimen', 'specimen_quality', true],
  ['CLOT', 'Clotted specimen', 'specimen_quality', true],
  ['QNS', 'Quantity not sufficient', 'specimen_quantity', true],
  ['WRONG-TUBE', 'Collected in the wrong container', 'specimen_container', true],
  ['UNLABELLED', 'Unlabelled or mislabelled specimen', 'identification', true],
  ['LIPAEMIC', 'Grossly lipaemic specimen', 'specimen_quality', true],
  ['LEAKED', 'Specimen leaked in transit', 'transport', true],
  ['DELAYED', 'Specimen received beyond stability window', 'transport', true],
  ['TEMP', 'Cold-chain excursion in transit', 'transport', false],
  ['DUPLICATE', 'Duplicate order for the same specimen', 'ordering', false],
];

/** discipline, priority, minutes, clock start. */
const TAT_TARGETS: readonly (readonly [string, string, number, string])[] = [
  ['biochemistry', 'stat', 60, 'order'],
  ['biochemistry', 'urgent', 120, 'receipt'],
  ['biochemistry', 'routine', 240, 'receipt'],
  ['haematology', 'stat', 60, 'order'],
  ['haematology', 'urgent', 120, 'receipt'],
  ['haematology', 'routine', 180, 'receipt'],
  ['microbiology', 'routine', 4320, 'receipt'],
  ['histopathology', 'routine', 10080, 'receipt'],
];

async function seedLabOperations(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const reasons: SeedRow[] = [];
  const tats: SeedRow[] = [];
  const benches: SeedRow[] = [];
  const instruments: SeedRow[] = [];
  const testMaps: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    const mainBranch = h.branches.find((b) => b.isMain) ?? h.branches[0];
    if (mainBranch === undefined) continue;
    const branchId = seedId('branch', h.code, mainBranch.code);

    REJECTION_REASONS.forEach(([code, label, category, notifyPatient], index) => {
      reasons.push({
        id: seedId('lab-reject-v1', rejectionKey(h.code, code)),
        record_key: rejectionKey(h.code, code),
        hospital_id: h.id,
        version: 1,
        code,
        label,
        nabl_category: category,
        discipline: null,
        requires_recollection: code !== 'DUPLICATE',
        recollection_chargeable: false,
        notify_patient: notifyPatient,
        notify_ordering_doctor: true,
        sort_order: index,
        effective_from: SEED_EPOCH,
        effective_to: null,
        status: 'active',
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
      });
    });

    for (const [discipline, priority, minutes, clockStart] of TAT_TARGETS) {
      tats.push({
        id: seedId('lab-tat-v1', tatKey(h.code, discipline, priority)),
        record_key: tatKey(h.code, discipline, priority),
        hospital_id: h.id,
        branch_id: null,
        version: 1,
        test_key: null,
        discipline,
        priority,
        source: null,
        target_minutes: minutes,
        clock_start: clockStart,
        warn_at_percent: 80,
        effective_from: SEED_EPOCH,
        effective_to: null,
        status: 'active',
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
      });
    }

    const instrumentId = seedId('lab-instrument', h.code, 'CHEM-01');
    instruments.push({
      id: instrumentId,
      hospital_id: h.id,
      branch_id: branchId,
      code: 'CHEM-01',
      name: 'Main chemistry analyzer',
      make: 'Demo Diagnostics',
      model: 'DX-2000',
      // Synthetic. docs/09 §11 forbids real identifiers in seed data, and a
      // serial number is an identifier a service engineer would recognise.
      serial: 'DEMO-DX2000-0001',
      discipline: 'biochemistry',
      department_key: null,
      bench_id: seedId('lab-bench', h.code, 'BIOCHEM'),
      driver_key: 'generic_hl7v2_mllp',
      protocol: 'hl7_v2',
      transport: 'tcp_server',
      connection: jsonb({ host: '0.0.0.0', port: 2575, mllp: true }),
      host_query_mode: true,
      send_demographics: false,
      encoding: 'UTF-8',
      timeouts: jsonb({ connect_ms: 5000, ack_ms: 10000 }),
      status: 'live',
      last_heartbeat_at: null,
      asset_ref: null,
      raw_retention_days: 90,
      is_buffering: false,
      buffered_since: null,
      buffered_count: 0,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      updated_by: null,
      version: 0,
    });

    benches.push(
      {
        id: seedId('lab-bench', h.code, 'BIOCHEM'),
        hospital_id: h.id,
        branch_id: branchId,
        code: 'BIOCHEM',
        name: 'Biochemistry bench',
        discipline: 'biochemistry',
        department_key: null,
        room_key: null,
        instrument_ids: [instrumentId],
        is_active: true,
        sort_order: 0,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
      },
      {
        id: seedId('lab-bench', h.code, 'HAEM'),
        hospital_id: h.id,
        branch_id: branchId,
        code: 'HAEM',
        name: 'Haematology bench',
        discipline: 'haematology',
        department_key: null,
        room_key: null,
        instrument_ids: [],
        is_active: true,
        sort_order: 1,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
      },
    );

    // The analyzer's own codes, mapped to ours. `EN-004 §4`: this is what stops
    // a result arriving as "K+" and landing nowhere.
    for (const [instrumentCode, testCode] of [
      ['K', 'K'],
      ['NA+', 'NA'],
      ['CREA-2', 'CREA'],
      ['GLU', 'GLUF'],
    ] as const) {
      testMaps.push({
        id: seedId('lab-testmap', h.code, instrumentCode),
        hospital_id: h.id,
        instrument_id: instrumentId,
        instrument_code: instrumentCode,
        instrument_sample_type_code: 'SER',
        test_key: testKey(h.code, testCode),
        parameter_key: null,
        loinc_code: null,
        unit_factor: null,
        unit_offset: null,
        target_unit: null,
        precision: null,
        result_type: 'numeric',
        flag_map: jsonb({ H: 'high', L: 'low', HH: 'critical_high', LL: 'critical_low', N: 'normal' }),
        dilution_rule: null,
        is_active: true,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
      });
    }
  }

  await ctx.write({ table: 'lab.lab_rejection_reasons', conflict: ['id'] }, reasons);
  await ctx.write({ table: 'lab.lab_tat_targets', conflict: ['id'] }, tats);
  await ctx.write({ table: 'lab.lab_benches', conflict: ['id'] }, benches);
  await ctx.write({ table: 'integration.lab_instruments', conflict: ['id'] }, instruments);
  await ctx.write({ table: 'integration.lab_instrument_test_maps', conflict: ['id'] }, testMaps);
}

// ── quality control ─────────────────────────────────────────────────────────

/**
 * The Westgard rule set. `EN-031 §5`: **`1-2s` is a warning, never a
 * rejection** — using it as a rejection rule is the classic false-rejection
 * error, because at two standard deviations roughly one run in twenty fails by
 * chance, and a laboratory that repeats one run in twenty stops believing its
 * own QC. The schema refuses the other configuration outright; this is the
 * default a hospital starts from.
 *
 * rule, n, r, action.
 */
export const WESTGARD_RULES: readonly (readonly [string, number | null, number | null, string])[] = [
  ['r_1_2s', 1, null, 'warning'],
  ['r_1_3s', 1, null, 'reject'],
  ['r_2_2s', 2, null, 'reject'],
  ['r_R_4s', null, 4, 'reject'],
  ['r_4_1s', 4, null, 'reject'],
  ['r_10x', 10, null, 'reject'],
];

async function seedLabQuality(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const westgard: SeedRow[] = [];
  const schedules: SeedRow[] = [];
  const qcStates: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    const mainBranch = h.branches.find((b) => b.isMain) ?? h.branches[0];
    if (mainBranch === undefined) continue;
    const branchId = seedId('branch', h.code, mainBranch.code);
    const instrumentId = seedId('lab-instrument', h.code, 'CHEM-01');

    for (const [rule, n, r, action] of WESTGARD_RULES) {
      westgard.push({
        id: seedId('labq-westgard', h.code, rule),
        hospital_id: h.id,
        branch_id: null,
        test_key: null,
        parameter_key: null,
        instrument_id: null,
        rule_code: rule,
        n,
        r,
        action,
        enabled: true,
        tea_percent: null,
        sigma_source: null,
        effective_from: SEED_EPOCH,
        effective_to: null,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
      });
    }

    // The four interfaced analytes get a QC schedule and a state row. The state
    // is seeded as `never_evaluated` **on purpose**: no control has been run on
    // a freshly provisioned tenant, and `lab.qc_permits_release()` therefore
    // refuses to release a patient result until one has. Seeding `in_control`
    // would be seeding a lie, and it is exactly the lie the whole of §C.4
    // exists to make unstorable.
    for (const testCode of ['K', 'NA', 'CREA', 'GLUF'] as const) {
      schedules.push({
        id: seedId('labq-schedule', h.code, testCode),
        hospital_id: h.id,
        branch_id: branchId,
        instrument_id: instrumentId,
        test_key: testKey(h.code, testCode),
        parameter_key: null,
        levels: 2,
        frequency: 'per_shift',
        n_samples: null,
        shifts: ['morning', 'evening', 'night'],
        grace_minutes: 60,
        block_release_on_miss: true,
        is_active: true,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
      });

      qcStates.push({
        id: seedId('labq-state', h.code, testCode),
        hospital_id: h.id,
        branch_id: branchId,
        instrument_id: instrumentId,
        test_key: testKey(h.code, testCode),
        parameter_key: null,
        state: 'never_evaluated',
        last_evaluated_at: null,
        last_run_id: null,
        last_run_at: null,
        next_due_at: null,
        reason: null,
        active_lockout_id: null,
        held_result_count: 0,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
      });
    }
  }

  await ctx.write({ table: 'lab.labq_westgard_config', conflict: ['id'] }, westgard);
  await ctx.write({ table: 'lab.labq_qc_schedules', conflict: ['id'] }, schedules);
  await ctx.write({ table: 'lab.labq_analyte_qc_state', conflict: ['id'] }, qcStates);
}

// ── imaging ─────────────────────────────────────────────────────────────────

/**
 * code, name, modality, DICOM body part, duration minutes, ionising, PC-PNDT,
 * contrast default, pregnancy check, DRL CTDIvol, DRL DLP, k-factor.
 *
 * The DRLs are the Indian national diagnostic reference levels published by
 * AERB/AAPM for adult protocols; a department replaces them with its own local
 * levels once it has surveyed its scanners, which is what `OP-008 §3.6.2` means
 * by "national/local".
 */
const RAD_PROCEDURES: readonly (readonly [
  string,
  string,
  string,
  string | null,
  number,
  boolean,
  boolean,
  boolean,
  boolean,
  number | null,
  number | null,
  number | null,
])[] = [
  ['XR-CHEST-PA', 'X-ray chest PA', 'DX', 'CHEST', 10, true, false, false, true, null, null, 0.014],
  ['CT-HEAD-PLAIN', 'CT head, plain', 'CT', 'HEAD', 20, true, false, false, true, 60, 1000, 0.0021],
  [
    'CT-ABD-CONTRAST',
    'CT abdomen with contrast',
    'CT',
    'ABDOMEN',
    30,
    true,
    false,
    true,
    true,
    25,
    900,
    0.015,
  ],
  ['MR-KNEE', 'MRI knee', 'MR', 'KNEE', 45, false, false, false, false, null, null, null],
  ['US-ABD', 'Ultrasound abdomen', 'US', 'ABDOMEN', 15, false, false, false, false, null, null, null],
  // PC-PNDT. The Form F machinery hangs off this row.
  [
    'US-OB-ANOMALY',
    'Ultrasound obstetric anomaly scan',
    'US',
    'ABDOMEN',
    30,
    false,
    true,
    false,
    false,
    null,
    null,
    null,
  ],
  ['MG-BILAT', 'Mammography, bilateral', 'MG', 'BREAST', 20, true, false, false, true, null, null, 0.0003],
];

async function seedRadiologyCatalogue(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const procedures: SeedRow[] = [];
  const rooms: SeedRow[] = [];
  const priors: SeedRow[] = [];
  const retention: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    const mainBranch = h.branches.find((b) => b.isMain) ?? h.branches[0];
    if (mainBranch === undefined) continue;
    const branchId = seedId('branch', h.code, mainBranch.code);

    for (const p of RAD_PROCEDURES) {
      const [
        code,
        name,
        modality,
        bodyPart,
        duration,
        ionising,
        pcpndt,
        contrast,
        pregnancyCheck,
        drlCtdi,
        drlDlp,
        kFactor,
      ] = p;
      procedures.push(
        master('rad-procedure', h.id, procedureKey(h.code, code), null, {
          code,
          name,
          modality,
          body_part_snomed: null,
          body_part_dicom: bodyPart,
          radlex_playbook_id: null,
          loinc_code: null,
          laterality_required: code === 'MR-KNEE',
          contrast_default: contrast,
          duration_minutes: duration,
          prep_instruction_key: null,
          consent_required: contrast,
          requires_pregnancy_check: pregnancyCheck,
          requires_creatinine: contrast,
          requires_mri_safety: modality === 'MR',
          sedation_option: modality === 'MR',
          is_ionising: ionising,
          is_pcpndt: pcpndt,
          drl_ctdivol_mgy: drlCtdi,
          drl_dlp_mgycm: drlDlp,
          drl_dap_gycm2: null,
          effective_dose_k_factor: kFactor,
          default_report_template_key: null,
          service_key: null,
          tat_routine_minutes: 1440,
          tat_urgent_minutes: 240,
          tat_stat_minutes: 30,
          notes: null,
        }),
      );
    }

    // Rooms. The ultrasound room carries a PC-PNDT registration because it is
    // the one that may lawfully perform an obstetric scan; the CT room does not,
    // and nothing on it is flagged `is_pcpndt`.
    for (const [code, name, modality, ae, pcpndtReg] of [
      ['XR-1', 'X-ray Room 1', 'DX', 'VIMSXR1', null],
      ['CT-1', 'CT Room 1', 'CT', 'VIMSCT1', null],
      ['USG-1', 'Ultrasound Room 1', 'US', 'VIMSUS1', 'PCPNDT/DEMO/0001'],
      ['MRI-1', 'MRI Suite', 'MR', 'VIMSMR1', null],
    ] as const) {
      rooms.push({
        id: seedId('rad-room', h.code, code),
        hospital_id: h.id,
        branch_id: branchId,
        code,
        name,
        modality,
        ae_title: ae,
        host: null,
        port: null,
        room_key: null,
        is_portable: false,
        status: 'active',
        aerb_licence_no: modality === 'US' || modality === 'MR' ? null : `AERB/DEMO/${code}`,
        aerb_licence_valid_to:
          modality === 'US' || modality === 'MR' ? null : new Date('2028-03-31T00:00:00.000Z'),
        qa_due_at: modality === 'US' || modality === 'MR' ? null : new Date('2027-03-31T00:00:00.000Z'),
        rso_user_id: null,
        scheduling_blocked: false,
        scheduling_block_reason: null,
        scheduling_override_by: null,
        scheduling_override_reason: null,
        pcpndt_registration_no: pcpndtReg,
        pcpndt_registration_valid_to: pcpndtReg === null ? null : new Date('2029-03-31T00:00:00.000Z'),
        slot_duration_minutes: 15,
        asset_ref: null,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
        version: 0,
      });
    }

    // `EN-008 §5`: prior comparison lookback default five years, filtered by a
    // body-part map.
    priors.push({
      id: seedId('pacs-priors', h.code, 'CT-HEAD'),
      hospital_id: h.id,
      procedure_key: procedureKey(h.code, 'CT-HEAD-PLAIN'),
      modality: 'CT',
      body_part_dicom: 'HEAD',
      relevant_procedure_keys: [procedureKey(h.code, 'CT-HEAD-PLAIN')],
      relevant_modalities: ['CT', 'MR'],
      relevant_body_parts: ['HEAD'],
      lookback_days: 1825,
      max_priors: 3,
      is_active: true,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      updated_by: null,
    });

    // `EN-008 §5`: adults five years, minors to 18 + three, MLC never.
    for (const [cls, hot, warm, years, untilAge, extra] of [
      ['adult', 30, 365, 5, null, null],
      ['minor', 30, 365, 5, 18, 3],
      ['mlc', 90, 3650, 99, null, null],
    ] as const) {
      retention.push({
        id: seedId('pacs-retention', h.code, cls),
        hospital_id: h.id,
        branch_id: null,
        modality: null,
        patient_class: cls,
        hot_days: hot,
        warm_days: warm,
        retain_years: years,
        minor_retain_until_age: untilAge,
        minor_extra_years: extra,
        never_purge_mlc: true,
        is_active: true,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
      });
    }
  }

  await ctx.write(
    { table: 'mdm.mdm_rad_procedures', conflict: ['id'], immutable: ['approved_at'] },
    procedures,
  );
  await ctx.write({ table: 'rad.rad_modality_rooms', conflict: ['id'] }, rooms);
  await ctx.write({ table: 'rad.pacs_priors_map', conflict: ['id'] }, priors);
  await ctx.write({ table: 'rad.pacs_retention_policies', conflict: ['id'] }, retention);
}

// ── the investigation console (OP-022) ──────────────────────────────────────

/** code, name, modality group, TAT minutes, co-sign required, ionising. */
const INVESTIGATION_SERVICES: readonly (readonly [string, string, string, number, boolean, boolean])[] = [
  ['ECG-12', 'ECG, 12-lead', 'ecg', 60, false, false],
  ['ECHO-2D', '2D echocardiography', 'echo', 240, true, false],
  ['TMT', 'Treadmill test', 'tmt', 240, true, false],
  ['PFT', 'Pulmonary function test', 'pft', 240, false, false],
  ['UGIE', 'Upper GI endoscopy', 'endoscopy', 240, true, false],
  ['DENTAL-IOPA', 'Dental intraoral periapical X-ray', 'dental_xray', 60, false, true],
];

async function seedInvestigationServices(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const rows: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    for (const [code, name, group, tat, cosign, ionising] of INVESTIGATION_SERVICES) {
      rows.push(
        master(
          'inv-service',
          h.id,
          investigationKey(h.code, code),
          null,
          {
            code,
            name,
            service_key: null,
            modality_group: group,
            report_template_key: null,
            prep_instruction_key: null,
            tat_report_minutes: tat,
            requires_slot: group !== 'ecg',
            cosign_required: cosign,
            is_pcpndt: false,
            is_ionising: ionising,
            requires_media: true,
          },
          NO_REPLACED,
        ),
      );
    }
  }

  await ctx.write(
    { table: 'mdm.mdm_investigation_services', conflict: ['id'], immutable: ['approved_at'] },
    rows,
  );
}

// ── deterministic record keys ───────────────────────────────────────────────

const specimenKey = (hospital: string, code: string): string => seedId('lab-specimen-key', hospital, code);
const containerKey = (hospital: string, code: string): string => seedId('lab-container-key', hospital, code);
const testKey = (hospital: string, code: string): string => seedId('lab-test-key', hospital, code);
const panelMemberKey = (hospital: string, panel: string, member: string): string =>
  seedId('lab-panel-member-key', hospital, panel, member);
const rangeKey = (hospital: string, test: string, ageMin: number, sex: string): string =>
  seedId('lab-range-key', hospital, test, String(ageMin), sex);
const rejectionKey = (hospital: string, code: string): string => seedId('lab-reject-key', hospital, code);
const tatKey = (hospital: string, discipline: string, priority: string): string =>
  seedId('lab-tat-key', hospital, discipline, priority);
const procedureKey = (hospital: string, code: string): string => seedId('rad-procedure-key', hospital, code);
const investigationKey = (hospital: string, code: string): string =>
  seedId('inv-service-key', hospital, code);
