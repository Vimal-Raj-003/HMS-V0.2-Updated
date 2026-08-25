import type { SeedContext } from './context.js';
import { SEED_EPOCH, seedId } from './ids.js';
import { jsonb, type SeedRow, type SeedValue } from './upsert.js';
import { type SeededTenancy } from './tenancy.js';

/**
 * The Phase-2 clinical configuration: terminology beyond ICD-10, the drug
 * formulary, the dosing and instruction libraries, the EN-029 rule estate and
 * its knowledge base, the OP-007 vitals thresholds, and the NC-003 MRD policy.
 *
 * Two rules govern what is here rather than invented:
 *
 *   1. **Terminology extends, it does not fork.** SNOMED CT, ATC and the
 *      allergen/complaint pick-lists are `mdm_code_systems` + `mdm_concepts` +
 *      `mdm_value_sets` rows, exactly as ICD-10 was in Phase 1. `phase-02 §2.1`
 *      asks for an "allergen master" and a "symptom/complaint master"; a value
 *      set over concepts *is* that master, and it is the one a hospital can
 *      curate without a release.
 *
 *   2. **The drug list is a demonstration, not a formulary.** Twenty-six
 *      molecules chosen so that every safety path in `phase-02`'s exit gates has
 *      something real to fire on: a penicillin for the allergy hard stop, a
 *      cross-reactive cephalosporin, warfarin and aspirin for the interaction
 *      soft stop, a nitrate and sildenafil for the contraindicated pair,
 *      paracetamol with a real paediatric mg/kg band and an absolute ceiling for
 *      the 10× overdose check, and a Schedule H1/X pair for the guardrails. The
 *      real formulary is a licensed file the hospital loads through EN-036.
 */
export async function seedClinical(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  await seedClinicalTerminology(ctx);
  await seedDoseFrequencies(ctx, tenancy);
  await seedDrugFormulary(ctx, tenancy);
  await seedInstructionLibrary(ctx, tenancy);
  await seedUnsafeAbbreviations(ctx, tenancy);
  await seedVitalsConfiguration(ctx, tenancy);
  await seedCdss(ctx, tenancy);
  await seedMrdConfiguration(ctx, tenancy);
}

/** The columns every effective-dated master carries, in one place. */
function master(
  table: string,
  hospitalId: string,
  recordKey: string,
  branchId: string | null,
  columns: Record<string, SeedValue>,
): SeedRow {
  return {
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
}

// ── terminology (EN-027 §4, extending what Phase 0 and Phase 1 created) ──────

/**
 * ATC is the classification every EN-029 allergy-class, duplicate-therapy and
 * dose rule subsumes over. It is a WHO product, free to use, and it is the join
 * between the hospital's own drug master and any licensed interaction database —
 * which is why it is loaded as a code system with a materialised closure rather
 * than as a string column on `mdm_drugs`.
 */
const ATC_CONCEPTS: readonly (readonly [code: string, display: string, parent: string | null])[] = [
  ['A', 'Alimentary tract and metabolism', null],
  ['A02BC', 'Proton pump inhibitors', 'A'],
  ['A02BC01', 'Omeprazole', 'A02BC'],
  ['A02BC02', 'Pantoprazole', 'A02BC'],
  ['A10BA', 'Biguanides', 'A'],
  ['A10BA02', 'Metformin', 'A10BA'],
  ['B', 'Blood and blood forming organs', null],
  ['B01AA', 'Vitamin K antagonists', 'B'],
  ['B01AA03', 'Warfarin', 'B01AA'],
  ['B01AC', 'Platelet aggregation inhibitors excl. heparin', 'B'],
  ['B01AC06', 'Acetylsalicylic acid', 'B01AC'],
  ['C', 'Cardiovascular system', null],
  ['C01DA', 'Organic nitrates', 'C'],
  ['C01DA02', 'Glyceryl trinitrate', 'C01DA'],
  ['C07AB', 'Beta blocking agents, selective', 'C'],
  ['C07AB07', 'Bisoprolol', 'C07AB'],
  ['C09AA', 'ACE inhibitors, plain', 'C'],
  ['C09AA02', 'Enalapril', 'C09AA'],
  ['C10AA', 'HMG CoA reductase inhibitors', 'C'],
  ['C10AA05', 'Atorvastatin', 'C10AA'],
  ['G', 'Genito-urinary system and sex hormones', null],
  ['G04BE', 'Drugs used in erectile dysfunction', 'G'],
  ['G04BE03', 'Sildenafil', 'G04BE'],
  ['J', 'Antiinfectives for systemic use', null],
  ['J01C', 'Beta-lactam antibacterials, penicillins', 'J'],
  ['J01CA', 'Penicillins with extended spectrum', 'J01C'],
  ['J01CA04', 'Amoxicillin', 'J01CA'],
  ['J01CR', 'Combinations of penicillins, incl. beta-lactamase inhibitors', 'J01C'],
  ['J01CR02', 'Amoxicillin and beta-lactamase inhibitor', 'J01CR'],
  ['J01D', 'Other beta-lactam antibacterials', 'J'],
  ['J01DD', 'Third-generation cephalosporins', 'J01D'],
  ['J01DD04', 'Ceftriaxone', 'J01DD'],
  ['J01EE', 'Combinations of sulfonamides and trimethoprim', 'J'],
  ['J01EE01', 'Sulfamethoxazole and trimethoprim', 'J01EE'],
  ['J01FA', 'Macrolides', 'J'],
  ['J01FA10', 'Azithromycin', 'J01FA'],
  ['M', 'Musculo-skeletal system', null],
  ['M01AB', 'Acetic acid derivatives and related substances', 'M'],
  ['M01AB05', 'Diclofenac', 'M01AB'],
  ['M01AE', 'Propionic acid derivatives', 'M'],
  ['M01AE01', 'Ibuprofen', 'M01AE'],
  ['M03BX', 'Other centrally acting agents', 'M'],
  ['M03BX01', 'Baclofen', 'M03BX'],
  ['M05BA', 'Bisphosphonates', 'M'],
  ['M05BA04', 'Alendronic acid', 'M05BA'],
  ['N', 'Nervous system', null],
  ['N02AA', 'Natural opium alkaloids', 'N'],
  ['N02AA01', 'Morphine', 'N02AA'],
  ['N02AJ', 'Opioids in combination with non-opioid analgesics', 'N'],
  ['N02AJ06', 'Codeine and paracetamol', 'N02AJ'],
  ['N02BE', 'Anilides', 'N'],
  ['N02BE01', 'Paracetamol', 'N02BE'],
  ['N03AX', 'Other antiepileptics', 'N'],
  ['N03AX12', 'Gabapentin', 'N03AX'],
  ['N05BA', 'Benzodiazepine derivatives', 'N'],
  ['N05BA01', 'Diazepam', 'N05BA'],
  ['R', 'Respiratory system', null],
  ['R03AC', 'Selective beta-2-adrenoreceptor agonists', 'R'],
  ['R03AC02', 'Salbutamol', 'R03AC'],
  ['R06AE', 'Piperazine derivatives', 'R'],
  ['R06AE07', 'Cetirizine', 'R06AE'],
];

/**
 * A SNOMED CT slice, complaint- and allergen-weighted.
 *
 * India's SNOMED CT licence is national and free at the point of use, but the
 * release itself is a 350 000-concept file downloaded from NRCeS under a
 * registered affiliate agreement (O-8 in `docs/DECISIONS.md` is still open on
 * the registration). What a repository can ship is the *loader path* and enough
 * concepts to make the quick-pick value sets real.
 */
const SNOMED_CONCEPTS: readonly (readonly [code: string, display: string, tag: string])[] = [
  // presenting complaints (the OP-002 §3.2 quick-pick chips)
  ['25064002', 'Headache', 'finding'],
  ['21522001', 'Abdominal pain', 'finding'],
  ['29857009', 'Chest pain', 'finding'],
  ['386661006', 'Fever', 'finding'],
  ['49727002', 'Cough', 'finding'],
  ['267036007', 'Dyspnoea', 'finding'],
  ['422587007', 'Nausea', 'finding'],
  ['422400008', 'Vomiting', 'finding'],
  ['62315008', 'Diarrhoea', 'finding'],
  ['279039007', 'Low back pain', 'finding'],
  ['30989003', 'Knee pain', 'finding'],
  ['45326000', 'Shoulder pain', 'finding'],
  ['125605004', 'Fracture of bone', 'disorder'],
  ['125670008', 'Foreign body injury', 'disorder'],
  ['399963005', 'Abrasion', 'disorder'],
  ['262574004', 'Bite wound', 'disorder'],
  ['84229001', 'Fatigue', 'finding'],
  ['404640003', 'Dizziness', 'finding'],
  ['271807003', 'Skin rash', 'finding'],
  ['13645005', 'Chronic obstructive lung disease', 'disorder'],
  // allergen substances (the `phase-02 §2.1` "allergen master")
  ['373270004', 'Penicillin (substance)', 'substance'],
  ['387406002', 'Sulfonamide (substance)', 'substance'],
  ['372665008', 'Nonsteroidal anti-inflammatory agent (substance)', 'substance'],
  ['387207008', 'Ibuprofen (substance)', 'substance'],
  ['387458008', 'Aspirin (substance)', 'substance'],
  ['96068000', 'Iodinated contrast media (substance)', 'substance'],
  ['227493005', 'Cashew nut (substance)', 'substance'],
  ['256349002', 'Peanut (substance)', 'substance'],
  ['102263004', 'Egg protein (substance)', 'substance'],
  ['3718001', 'Cow milk protein (substance)', 'substance'],
  ['227037002', 'Prawn (substance)', 'substance'],
  ['256277009', 'House dust mite (substance)', 'substance'],
  ['111088007', 'Latex (substance)', 'substance'],
];

async function seedClinicalTerminology(ctx: SeedContext): Promise<void> {
  const atcId = seedId('mdm-code-system', 'ATC', '2026');
  const snomedId = seedId('mdm-code-system', 'SNOMEDCT', 'IN-2026-04');

  await ctx.write({ table: 'mdm.mdm_code_systems', conflict: ['id'] }, [
    {
      id: atcId,
      key: 'ATC',
      name: 'WHO Anatomical Therapeutic Chemical classification, 2026',
      version: '2026',
      release_date: '2026-01-01',
      licence: 'free',
      licence_ref: 'WHO Collaborating Centre for Drug Statistics Methodology — free for non-commercial use',
      source_url: 'https://www.whocc.no/atc_ddd_index/',
      // A full ATC release is ~6500 codes across five levels. The slice here is
      // what the seeded formulary needs; the figure keeps the EN-027 §5 delta
      // report honest about what a real load would add.
      concept_count: 6_500,
      status: 'active',
      loaded_at: SEED_EPOCH,
      activated_at: SEED_EPOCH,
      delta_report_file_id: null,
      created_at: SEED_EPOCH,
      updated_at: SEED_EPOCH,
    },
    {
      id: snomedId,
      key: 'SNOMEDCT',
      name: 'SNOMED CT India edition (NRCeS), April 2026 release',
      version: 'IN-2026-04',
      release_date: '2026-04-01',
      licence: 'national',
      licence_ref:
        'India has a national SNOMED CT affiliate licence administered by NRCeS; affiliate registration is open question O-8 in docs/DECISIONS.md',
      source_url: 'https://www.nrces.in/snomed-ct',
      concept_count: 352_000,
      status: 'loaded',
      loaded_at: SEED_EPOCH,
      // Deliberately NOT activated: EN-027 §5 requires a delta report review
      // before activation, and there is no delta report for a seeded slice.
      activated_at: null,
      delta_report_file_id: null,
      created_at: SEED_EPOCH,
      updated_at: SEED_EPOCH,
    },
  ]);

  const concepts: SeedRow[] = [];
  const closure: SeedRow[] = [];

  for (const [code, display, parent] of ATC_CONCEPTS) {
    concepts.push({
      id: seedId('mdm-concept', 'ATC', code),
      code_system_id: atcId,
      code,
      display,
      display_lang: 'en',
      definition: null,
      parent_codes: parent === null ? [] : [parent],
      properties: jsonb({ level: code.length, anatomicalMainGroup: code.slice(0, 1) }),
      status: 'active',
      effective_from: '2026-01-01',
      inactivated_reason: null,
      created_at: SEED_EPOCH,
      updated_at: SEED_EPOCH,
    });
  }

  // The transitive closure, walked properly rather than one level deep: an
  // allergy to the penicillin class must subsume J01CR02 through J01CR and
  // J01C, which a depth-1 closure would miss and a prescriber would not.
  const parentOf = new Map(ATC_CONCEPTS.map(([code, , parent]) => [code, parent]));
  for (const [code] of ATC_CONCEPTS) {
    let ancestor: string | null = code;
    let depth = 0;
    while (ancestor !== null) {
      closure.push({
        id: seedId('mdm-closure', 'ATC', ancestor, code),
        code_system_id: atcId,
        ancestor_code: ancestor,
        descendant_code: code,
        depth,
      });
      ancestor = parentOf.get(ancestor) ?? null;
      depth += 1;
    }
  }

  for (const [code, display, tag] of SNOMED_CONCEPTS) {
    concepts.push({
      id: seedId('mdm-concept', 'SNOMEDCT', code),
      code_system_id: snomedId,
      code,
      display,
      display_lang: 'en',
      definition: null,
      parent_codes: [],
      properties: jsonb({ semanticTag: tag }),
      status: 'active',
      effective_from: '2026-04-01',
      inactivated_reason: null,
      created_at: SEED_EPOCH,
      updated_at: SEED_EPOCH,
    });
    closure.push({
      id: seedId('mdm-closure', 'SNOMEDCT', code, code),
      code_system_id: snomedId,
      ancestor_code: code,
      descendant_code: code,
      depth: 0,
    });
  }

  await ctx.write({ table: 'mdm.mdm_concepts', conflict: ['id'] }, concepts);
  await ctx.write({ table: 'mdm.mdm_concept_closure', conflict: ['id'] }, closure);

  // The two value sets `phase-02 §2.1` calls the "symptom/complaint master" and
  // the "allergen master". `hospital_id` is null because these are shipped
  // defaults; a hospital that wants its own creates a tenant-scoped value set
  // with the same key, which the mixed-tenancy RLS policy already allows.
  const valueSets: readonly (readonly [key: string, name: string, tag: string, purpose: string])[] = [
    [
      'opd.complaints.general',
      'Presenting complaints — general OPD',
      'finding',
      'The quick-pick chips on the OP-002 chief-complaint field. A hospital may define its own value set with this key; the tenant-scoped one wins.',
    ],
    [
      'allergy.substances',
      'Allergen substances',
      'substance',
      'The pick-list behind patient.allergies.substance_code. Coded rather than free text so EN-029 can subsume over ATC and the cross-sensitivity map.',
    ],
  ];

  const setRows: SeedRow[] = [];
  const versionRows: SeedRow[] = [];
  const memberRows: SeedRow[] = [];

  for (const [key, name, tag, purpose] of valueSets) {
    const setId = seedId('mdm-value-set', key);
    const versionId = seedId('mdm-value-set-version', key, '1');
    setRows.push({
      id: setId,
      hospital_id: null,
      key,
      name,
      purpose,
      owner_role: 'clinical_informaticist',
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      deleted_at: null,
    });
    versionRows.push({
      id: versionId,
      hospital_id: null,
      value_set_id: setId,
      version: 1,
      definition: jsonb({ type: 'filter', system: 'SNOMEDCT', semanticTag: tag }),
      expansion_cached: null,
      expanded_at: null,
      status: 'active',
      created_at: SEED_EPOCH,
      updated_at: SEED_EPOCH,
    });
    let sort = 0;
    for (const [code, display, conceptTag] of SNOMED_CONCEPTS) {
      if (conceptTag !== tag) continue;
      memberRows.push({
        id: seedId('mdm-value-set-member', key, code),
        hospital_id: null,
        value_set_version_id: versionId,
        code_system_key: 'SNOMEDCT',
        code,
        display,
        sort_order: sort,
      });
      sort += 1;
    }
  }

  await ctx.write({ table: 'mdm.mdm_value_sets', conflict: ['id'] }, setRows);
  await ctx.write({ table: 'mdm.mdm_value_set_versions', conflict: ['id'] }, versionRows);
  await ctx.write({ table: 'mdm.mdm_value_set_members', conflict: ['id'] }, memberRows);
}

// ── dose frequencies ────────────────────────────────────────────────────────

/** code, label, doses per day, schedule times, PRN, STAT. */
const FREQUENCIES: readonly (readonly [
  string,
  string,
  number | null,
  readonly string[],
  boolean,
  boolean,
])[] = [
  ['OD', 'Once daily', 1, ['09:00'], false, false],
  ['BD', 'Twice daily', 2, ['09:00', '21:00'], false, false],
  ['TDS', 'Three times daily', 3, ['08:00', '14:00', '21:00'], false, false],
  ['QID', 'Four times daily', 4, ['06:00', '12:00', '18:00', '00:00'], false, false],
  ['HS', 'At bedtime', 1, ['22:00'], false, false],
  ['Q4H', 'Every 4 hours', 6, ['06:00', '10:00', '14:00', '18:00', '22:00', '02:00'], false, false],
  ['Q6H', 'Every 6 hours', 4, ['06:00', '12:00', '18:00', '00:00'], false, false],
  ['Q8H', 'Every 8 hours', 3, ['06:00', '14:00', '22:00'], false, false],
  ['ALT', 'Alternate days', 0.5, ['09:00'], false, false],
  ['WEEKLY', 'Once weekly', 0.142857, ['09:00'], false, false],
  // NABH's "do not use" list bans `QD`; `SOS` and `STAT` are unambiguous and stay.
  ['SOS', 'As needed', null, [], true, false],
  ['STAT', 'Immediately, once', null, [], false, true],
];

async function seedDoseFrequencies(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const rows: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    for (const [code, label, perDay, times, isPrn, isStat] of FREQUENCIES) {
      rows.push({
        id: seedId('mdm-dose-frequency', h.code, code),
        hospital_id: h.id,
        code,
        label,
        times_per_day: perDay,
        schedule_times: times,
        is_prn: isPrn,
        is_stat: isStat,
        sort_order: FREQUENCIES.findIndex((f) => f[0] === code),
        active: true,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
      });
    }
  }
  await ctx.write({ table: 'mdm.mdm_dose_frequencies', conflict: ['id'] }, rows);
}

// ── the drug formulary ──────────────────────────────────────────────────────

/**
 * Exported so the Phase-4 item master can be built from the same formulary the
 * prescriber writes against. An `inventory.items` row whose `drug_key` points at
 * a drug the CDSS has never heard of is an item nobody can prescribe, and a
 * second, divergent drug list is exactly the thing `EN-027` exists to prevent.
 */
export interface DrugSeed {
  readonly code: string;
  readonly generic: string;
  readonly atc: string;
  readonly form: string;
  readonly route: string;
  readonly strength: number | null;
  readonly strengthUnit: string | null;
  readonly schedule: string;
  readonly highAlert?: boolean;
  readonly lasa?: string;
  readonly pregnancy: string;
  readonly weightBased?: boolean;
  readonly renal?: boolean;
  readonly hepatic?: boolean;
  readonly beers?: boolean;
  readonly dpcoCeiling?: number;
  readonly maxDaily?: number;
  readonly maxDailyUnit?: string;
  readonly therapeuticClass: string;
  readonly brand: readonly [name: string, manufacturer: string, pack: number, mrp: number];
}

export const DRUGS: readonly DrugSeed[] = [
  {
    code: 'PCM500',
    generic: 'Paracetamol',
    atc: 'N02BE01',
    form: 'tablet',
    route: 'oral',
    strength: 500,
    strengthUnit: 'mg',
    schedule: 'g',
    pregnancy: 'b',
    weightBased: true,
    hepatic: true,
    dpcoCeiling: 2.5,
    maxDaily: 4000,
    maxDailyUnit: 'mg',
    therapeuticClass: 'Analgesic / antipyretic',
    brand: ['Dolo 500', 'Micro Labs', 15, 30.8],
  },
  {
    code: 'PCMSYR',
    generic: 'Paracetamol',
    atc: 'N02BE01',
    form: 'syrup',
    route: 'oral',
    strength: 125,
    strengthUnit: 'mg/5ml',
    schedule: 'g',
    pregnancy: 'b',
    weightBased: true,
    hepatic: true,
    maxDaily: 60,
    maxDailyUnit: 'mg/kg',
    therapeuticClass: 'Analgesic / antipyretic',
    brand: ['Calpol 125 Syrup', 'GSK', 60, 46.0],
  },
  {
    code: 'AMOX500',
    generic: 'Amoxicillin',
    atc: 'J01CA04',
    form: 'capsule',
    route: 'oral',
    strength: 500,
    strengthUnit: 'mg',
    schedule: 'h',
    pregnancy: 'b',
    weightBased: true,
    renal: true,
    therapeuticClass: 'Penicillin antibacterial',
    brand: ['Novamox 500', 'Cipla', 10, 68.5],
  },
  {
    code: 'AMOXCLAV',
    generic: 'Amoxicillin + Clavulanic acid',
    atc: 'J01CR02',
    form: 'tablet',
    route: 'oral',
    strength: 625,
    strengthUnit: 'mg',
    schedule: 'h',
    pregnancy: 'b',
    weightBased: true,
    renal: true,
    therapeuticClass: 'Penicillin antibacterial',
    brand: ['Augmentin 625 Duo', 'GSK', 10, 205.0],
  },
  {
    code: 'CEFTRIAX',
    generic: 'Ceftriaxone',
    atc: 'J01DD04',
    form: 'injection',
    route: 'intravenous',
    strength: 1,
    strengthUnit: 'g',
    schedule: 'h',
    pregnancy: 'b',
    weightBased: true,
    renal: true,
    therapeuticClass: 'Third-generation cephalosporin',
    brand: ['Monocef 1g', 'Aristo', 1, 62.0],
  },
  {
    code: 'COTRIM',
    generic: 'Sulfamethoxazole + Trimethoprim',
    atc: 'J01EE01',
    form: 'tablet',
    route: 'oral',
    strength: 960,
    strengthUnit: 'mg',
    schedule: 'h',
    pregnancy: 'd',
    renal: true,
    therapeuticClass: 'Sulfonamide antibacterial',
    brand: ['Septran DS', 'Abbott', 10, 44.0],
  },
  {
    code: 'AZITH500',
    generic: 'Azithromycin',
    atc: 'J01FA10',
    form: 'tablet',
    route: 'oral',
    strength: 500,
    strengthUnit: 'mg',
    schedule: 'h',
    pregnancy: 'b',
    hepatic: true,
    therapeuticClass: 'Macrolide antibacterial',
    brand: ['Azithral 500', 'Alembic', 5, 116.0],
  },
  {
    code: 'WARF5',
    generic: 'Warfarin',
    atc: 'B01AA03',
    form: 'tablet',
    route: 'oral',
    strength: 5,
    strengthUnit: 'mg',
    schedule: 'h',
    highAlert: true,
    pregnancy: 'x',
    hepatic: true,
    beers: true,
    maxDaily: 10,
    maxDailyUnit: 'mg',
    therapeuticClass: 'Vitamin K antagonist anticoagulant',
    brand: ['Warf 5', 'Cipla', 30, 60.0],
  },
  {
    code: 'ASA75',
    generic: 'Aspirin',
    atc: 'B01AC06',
    form: 'tablet',
    route: 'oral',
    strength: 75,
    strengthUnit: 'mg',
    schedule: 'g',
    pregnancy: 'd',
    beers: true,
    therapeuticClass: 'Antiplatelet',
    brand: ['Ecosprin 75', 'USV', 14, 8.5],
  },
  {
    code: 'GTN',
    generic: 'Glyceryl trinitrate',
    atc: 'C01DA02',
    form: 'tablet',
    route: 'sublingual',
    strength: 0.5,
    strengthUnit: 'mg',
    schedule: 'h',
    pregnancy: 'c',
    therapeuticClass: 'Nitrate vasodilator',
    brand: ['Angispan 0.5', 'USV', 25, 30.0],
  },
  {
    code: 'SILD50',
    generic: 'Sildenafil',
    atc: 'G04BE03',
    form: 'tablet',
    route: 'oral',
    strength: 50,
    strengthUnit: 'mg',
    schedule: 'h',
    pregnancy: 'b',
    therapeuticClass: 'Phosphodiesterase-5 inhibitor',
    brand: ['Manforce 50', 'Mankind', 4, 132.0],
  },
  {
    code: 'DICLO50',
    generic: 'Diclofenac',
    atc: 'M01AB05',
    form: 'tablet',
    route: 'oral',
    strength: 50,
    strengthUnit: 'mg',
    schedule: 'h',
    pregnancy: 'c',
    renal: true,
    beers: true,
    maxDaily: 150,
    maxDailyUnit: 'mg',
    therapeuticClass: 'NSAID',
    brand: ['Voveran 50', 'Novartis', 10, 22.0],
  },
  {
    code: 'IBU400',
    generic: 'Ibuprofen',
    atc: 'M01AE01',
    form: 'tablet',
    route: 'oral',
    strength: 400,
    strengthUnit: 'mg',
    schedule: 'g',
    pregnancy: 'c',
    weightBased: true,
    renal: true,
    beers: true,
    maxDaily: 2400,
    maxDailyUnit: 'mg',
    therapeuticClass: 'NSAID',
    brand: ['Brufen 400', 'Abbott', 15, 44.0],
  },
  {
    code: 'MORPH10',
    generic: 'Morphine sulphate',
    atc: 'N02AA01',
    form: 'injection',
    route: 'intravenous',
    strength: 10,
    strengthUnit: 'mg',
    schedule: 'ndps_narcotic',
    highAlert: true,
    pregnancy: 'c',
    weightBased: true,
    renal: true,
    hepatic: true,
    therapeuticClass: 'Opioid analgesic',
    brand: ['Morphine 10mg/ml', 'Rusan', 1, 34.0],
  },
  {
    code: 'DIAZ5',
    generic: 'Diazepam',
    atc: 'N05BA01',
    form: 'tablet',
    route: 'oral',
    strength: 5,
    strengthUnit: 'mg',
    schedule: 'x',
    highAlert: true,
    pregnancy: 'd',
    hepatic: true,
    beers: true,
    therapeuticClass: 'Benzodiazepine',
    brand: ['Valium 5', 'Abbott', 10, 18.0],
  },
  {
    code: 'GABA300',
    generic: 'Gabapentin',
    atc: 'N03AX12',
    form: 'capsule',
    route: 'oral',
    strength: 300,
    strengthUnit: 'mg',
    schedule: 'h1',
    pregnancy: 'c',
    renal: true,
    beers: true,
    maxDaily: 3600,
    maxDailyUnit: 'mg',
    therapeuticClass: 'Gabapentinoid',
    brand: ['Gabapin 300', 'Intas', 10, 105.0],
  },
  {
    code: 'BACLO10',
    generic: 'Baclofen',
    atc: 'M03BX01',
    form: 'tablet',
    route: 'oral',
    strength: 10,
    strengthUnit: 'mg',
    schedule: 'h',
    pregnancy: 'c',
    renal: true,
    therapeuticClass: 'Skeletal muscle relaxant',
    brand: ['Liofen 10', 'Sun Pharma', 10, 39.0],
  },
  {
    code: 'ALEN70',
    generic: 'Alendronic acid',
    atc: 'M05BA04',
    form: 'tablet',
    route: 'oral',
    strength: 70,
    strengthUnit: 'mg',
    schedule: 'h',
    pregnancy: 'c',
    renal: true,
    therapeuticClass: 'Bisphosphonate',
    brand: ['Osteofos 70', 'Cipla', 4, 260.0],
  },
  {
    code: 'PANTO40',
    generic: 'Pantoprazole',
    atc: 'A02BC02',
    form: 'tablet',
    route: 'oral',
    strength: 40,
    strengthUnit: 'mg',
    schedule: 'h',
    pregnancy: 'b',
    hepatic: true,
    therapeuticClass: 'Proton pump inhibitor',
    brand: ['Pantocid 40', 'Sun Pharma', 15, 138.0],
  },
  {
    code: 'OMEP20',
    generic: 'Omeprazole',
    atc: 'A02BC01',
    form: 'capsule',
    route: 'oral',
    strength: 20,
    strengthUnit: 'mg',
    schedule: 'h',
    pregnancy: 'c',
    hepatic: true,
    therapeuticClass: 'Proton pump inhibitor',
    brand: ['Omez 20', 'Dr Reddys', 20, 78.0],
  },
  {
    code: 'METF500',
    generic: 'Metformin',
    atc: 'A10BA02',
    form: 'tablet',
    route: 'oral',
    strength: 500,
    strengthUnit: 'mg',
    schedule: 'h',
    pregnancy: 'b',
    renal: true,
    dpcoCeiling: 2.03,
    maxDaily: 2550,
    maxDailyUnit: 'mg',
    therapeuticClass: 'Biguanide antidiabetic',
    brand: ['Glycomet 500', 'USV', 20, 40.0],
  },
  {
    code: 'ENAL5',
    generic: 'Enalapril',
    atc: 'C09AA02',
    form: 'tablet',
    route: 'oral',
    strength: 5,
    strengthUnit: 'mg',
    schedule: 'h',
    pregnancy: 'd',
    renal: true,
    therapeuticClass: 'ACE inhibitor',
    brand: ['Envas 5', 'Cadila', 15, 42.0],
  },
  {
    code: 'BISO5',
    generic: 'Bisoprolol',
    atc: 'C07AB07',
    form: 'tablet',
    route: 'oral',
    strength: 5,
    strengthUnit: 'mg',
    schedule: 'h',
    pregnancy: 'c',
    therapeuticClass: 'Selective beta blocker',
    brand: ['Concor 5', 'Merck', 10, 92.0],
  },
  {
    code: 'ATOR10',
    generic: 'Atorvastatin',
    atc: 'C10AA05',
    form: 'tablet',
    route: 'oral',
    strength: 10,
    strengthUnit: 'mg',
    schedule: 'h',
    pregnancy: 'x',
    hepatic: true,
    therapeuticClass: 'Statin',
    brand: ['Atorva 10', 'Zydus', 10, 60.0],
  },
  {
    code: 'SALB',
    generic: 'Salbutamol',
    atc: 'R03AC02',
    form: 'inhaler',
    route: 'inhalation',
    strength: 100,
    strengthUnit: 'mcg/dose',
    schedule: 'h',
    pregnancy: 'c',
    therapeuticClass: 'Short-acting beta-2 agonist',
    brand: ['Asthalin HFA', 'Cipla', 200, 128.0],
  },
  {
    code: 'CETI10',
    generic: 'Cetirizine',
    atc: 'R06AE07',
    form: 'tablet',
    route: 'oral',
    strength: 10,
    strengthUnit: 'mg',
    schedule: 'g',
    pregnancy: 'b',
    renal: true,
    therapeuticClass: 'Second-generation antihistamine',
    brand: ['Cetzine 10', 'GSK', 10, 27.0],
  },
];

/** The `mdm_drugs.record_key` a Phase-4 item points at. One function, two callers. */
export function drugKeyOf(hospitalCode: string, drugCode: string): string {
  return seedId('mdm-drug-key', hospitalCode, drugCode);
}

async function seedDrugFormulary(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const drugRows: SeedRow[] = [];
  const brandRows: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    for (const d of DRUGS) {
      const drugKey = drugKeyOf(h.code, d.code);
      drugRows.push(
        master('mdm-drug', h.id, drugKey, null, {
          code: d.code,
          generic_name: d.generic,
          molecules: d.generic.split(' + '),
          atc_code: d.atc,
          snomed_code: null,
          rxnorm_code: null,
          form: d.form,
          route: d.route,
          strength_value: d.strength,
          strength_unit: d.strengthUnit,
          strength_text: d.strength === null ? null : `${d.strength} ${d.strengthUnit ?? ''}`.trim(),
          schedule: d.schedule,
          is_high_alert: d.highAlert ?? false,
          is_lasa: d.lasa !== undefined,
          tall_man_display: d.lasa ?? null,
          dpco_scheduled: d.dpcoCeiling !== undefined,
          dpco_ceiling_price: d.dpcoCeiling ?? null,
          currency: 'INR',
          pregnancy_category: d.pregnancy,
          lactation_caution: d.pregnancy === 'd' || d.pregnancy === 'x',
          beers_listed: d.beers ?? false,
          renal_dose_adjust: d.renal ?? false,
          hepatic_dose_adjust: d.hepatic ?? false,
          is_weight_based: d.weightBased ?? false,
          max_daily_dose: d.maxDaily ?? null,
          max_daily_dose_unit: d.maxDailyUnit ?? null,
          therapeutic_class: d.therapeuticClass,
          in_formulary: true,
          default_uom: d.form === 'syrup' ? 'ml' : 'unit',
          notes: null,
        }),
      );

      const [brandName, manufacturer, packSize, mrp] = d.brand;
      brandRows.push(
        master('mdm-drug-brand', h.id, seedId('mdm-drug-brand-key', h.code, d.code), null, {
          drug_key: drugKey,
          code: `${d.code}-B1`,
          brand_name: brandName,
          manufacturer,
          pack_size: packSize,
          pack_uom: d.form === 'syrup' ? 'ml' : 'unit',
          // The DPCO trigger refuses an activation above the notified ceiling,
          // so a seeded MRP for a scheduled formulation must be per-unit
          // compliant: ceiling x pack size, rounded down to the paise.
          mrp:
            d.dpcoCeiling === undefined
              ? mrp
              : Math.min(mrp, Math.floor(d.dpcoCeiling * packSize * 100) / 100),
          currency: 'INR',
          hsn_code: '3004',
          gst_rate: 12,
          gtin: null,
          item_key: null,
          is_available: true,
        }),
      );
    }
  }

  await ctx.write({ table: 'mdm.mdm_drugs', conflict: ['id'] }, drugRows);
  await ctx.write({ table: 'mdm.mdm_drug_brands', conflict: ['id'] }, brandRows);
}

// ── the instruction / advice library ────────────────────────────────────────

/** code, kind, category, en-IN text, hi text, ta text. */
const INSTRUCTIONS: readonly (readonly [string, string, string, string, string, string])[] = [
  [
    'AFTER_FOOD',
    'dosing',
    'Dosing',
    'Take after food.',
    'भोजन के बाद लें।',
    'உணவுக்குப் பிறகு எடுத்துக் கொள்ளவும்.',
  ],
  [
    'BEFORE_FOOD',
    'dosing',
    'Dosing',
    'Take 30 minutes before food.',
    'भोजन से 30 मिनट पहले लें।',
    'உணவுக்கு 30 நிமிடங்களுக்கு முன் எடுத்துக் கொள்ளவும்.',
  ],
  [
    'COMPLETE_COURSE',
    'warning',
    'Antibiotics',
    'Complete the full course even if you feel better.',
    'ठीक महसूस होने पर भी पूरा कोर्स लें।',
    'நலமாக உணர்ந்தாலும் முழு மருந்தையும் முடிக்கவும்.',
  ],
  [
    'PLENTY_FLUIDS',
    'lifestyle',
    'General',
    'Drink plenty of fluids.',
    'खूब तरल पदार्थ पिएँ।',
    'நிறைய திரவங்கள் அருந்தவும்.',
  ],
  [
    'NO_DRIVING',
    'warning',
    'Sedation',
    'Do not drive or operate machinery after taking this medicine.',
    'यह दवा लेने के बाद वाहन या मशीन न चलाएँ।',
    'இந்த மருந்தை எடுத்த பிறகு வாகனம் ஓட்ட வேண்டாம்.',
  ],
  [
    'LIMB_ELEVATION',
    'activity',
    'Orthopaedics',
    'Keep the limb elevated above heart level for the first 48 hours.',
    'पहले 48 घंटे अंग को हृदय के स्तर से ऊपर रखें।',
    'முதல் 48 மணி நேரம் கை/காலை இதய அளவுக்கு மேல் வைக்கவும்.',
  ],
  [
    'CAST_CARE',
    'activity',
    'Orthopaedics',
    'Keep the cast dry. Return immediately if fingers or toes become numb, cold or blue.',
    'प्लास्टर सूखा रखें। उंगलियाँ सुन्न, ठंडी या नीली हों तो तुरंत आएँ।',
    'கட்டு ஈரமாகாமல் பார்த்துக்கொள்ளவும். விரல்கள் மரத்துப்போனால் உடனே வரவும்.',
  ],
  [
    'FASTING_8H',
    'procedure_prep',
    'Investigations',
    'Fast for 8 hours before the test. Water is allowed.',
    'जाँच से 8 घंटे पहले तक कुछ न खाएँ। पानी ले सकते हैं।',
    'பரிசோதனைக்கு 8 மணி நேரம் முன் உணவு வேண்டாம். தண்ணீர் அருந்தலாம்.',
  ],
  [
    'REVIEW_7D',
    'follow_up',
    'Follow-up',
    'Come back for review after 7 days, or earlier if symptoms worsen.',
    '7 दिन बाद दिखाएँ, या लक्षण बढ़ने पर पहले आएँ।',
    '7 நாட்களுக்குப் பிறகு மறுபரிசோதனைக்கு வரவும்.',
  ],
  [
    'DIABETIC_DIET',
    'diet',
    'Diabetes',
    'Avoid sugar, sweets and fried food. Eat small frequent meals.',
    'चीनी, मिठाई और तला खाना न लें। थोड़ा-थोड़ा बार-बार खाएँ।',
    'சர்க்கரை, இனிப்பு, பொரித்த உணவு தவிர்க்கவும்.',
  ],
];

async function seedInstructionLibrary(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const rows: SeedRow[] = [];
  const textRows: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    for (const [code, kind, category, en, hi, ta] of INSTRUCTIONS) {
      const recordKey = seedId('mdm-instruction-key', h.code, code);
      rows.push(
        master('mdm-instruction', h.id, recordKey, null, {
          code,
          kind,
          category,
          default_text: en,
          speciality_key: null,
          sort_order: INSTRUCTIONS.findIndex((i) => i[0] === code),
        }),
      );
      const instructionId = seedId('mdm-instruction-v1', recordKey);
      for (const [locale, text] of [
        ['hi', hi],
        ['ta', ta],
      ] as const) {
        textRows.push({
          id: seedId('mdm-instruction-text', h.code, code, locale),
          hospital_id: h.id,
          instruction_id: instructionId,
          locale,
          text,
          created_at: SEED_EPOCH,
          updated_at: SEED_EPOCH,
        });
      }
    }
  }

  await ctx.write({ table: 'mdm.mdm_instructions', conflict: ['id'] }, rows);
  await ctx.write({ table: 'mdm.mdm_instruction_texts', conflict: ['id'] }, textRows);
}

/**
 * The NABH / ISMP "do not use" list, as data.
 *
 * OP-002 §5 requires it enforced on free-text instructions. It is a table rather
 * than a regex in a validator because the list is a document a quality manager
 * owns and revises after every audit.
 */
const UNSAFE_ABBREVIATIONS: readonly (readonly [
  pattern: string,
  isRegex: boolean,
  preferred: string,
  rationale: string,
  severity: string,
])[] = [
  ['\\yU\\y', true, 'unit', 'A trailing "U" is read as a zero or a four — a tenfold insulin error.', 'block'],
  ['\\yIU\\y', true, 'international unit', 'Read as "IV" or as the number ten.', 'block'],
  [
    '\\yQD\\y',
    true,
    'once daily',
    'The period after Q is mistaken for an I, giving QID — four times the dose.',
    'block',
  ],
  ['\\yQOD\\y', true, 'every other day', 'Mistaken for QD or QID.', 'block'],
  [
    '\\yMS\\y',
    true,
    'morphine sulphate',
    'Ambiguous between morphine sulphate and magnesium sulphate.',
    'block',
  ],
  ['\\yMSO4\\y', true, 'morphine sulphate', 'Confused with magnesium sulphate.', 'block'],
  ['\\yMgSO4\\y', true, 'magnesium sulphate', 'Confused with morphine sulphate.', 'block'],
  [
    '\\y\\d+\\.0\\y',
    true,
    'the whole number with no trailing zero',
    'A missed decimal point makes 1.0 mg into 10 mg.',
    'block',
  ],
  [
    '\\y\\.\\d',
    true,
    'a leading zero before the decimal point',
    'A missed decimal point makes .5 mg into 5 mg.',
    'block',
  ],
  ['\\yµg\\y', true, 'mcg', 'The Greek mu is read as an m, giving milligrams.', 'block'],
  ['\\ycc\\y', true, 'ml', 'Read as a zero or as "u".', 'warn'],
  ['\\yHS\\y', true, 'at bedtime', 'Ambiguous between "half strength" and "at bedtime".', 'warn'],
];

async function seedUnsafeAbbreviations(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const rows: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    for (const [pattern, isRegex, preferred, rationale, severity] of UNSAFE_ABBREVIATIONS) {
      rows.push({
        id: seedId('mdm-unsafe-abbrev', h.code, pattern),
        hospital_id: h.id,
        pattern,
        is_regex: isRegex,
        preferred,
        rationale,
        severity,
        active: true,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
      });
    }
  }
  await ctx.write({ table: 'mdm.mdm_unsafe_abbreviations', conflict: ['id'] }, rows);
}

// ── vitals configuration (OP-007 §5.1) ──────────────────────────────────────

/**
 * The adult defaults from OP-007 §5.1, plus the paediatric bands the same
 * section names. Age is in days: a neonate band is 0–28 days and a year-grained
 * column could not express it.
 *
 * parameter, ageMin, ageMax, sex, lowAbn, highAbn, lowCrit, highCrit,
 * lowPlausible, highPlausible, unit.
 */
type Range = readonly [
  string,
  number,
  number,
  string,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  string,
];

/**
 * Tuple order: parameter, ageMin, ageMax, sex, **low_abnormal, high_abnormal**,
 * **low_critical, high_critical**, low_plausible, high_plausible, unit.
 *
 * `low_abnormal`/`high_abnormal` bound the **normal** band — a value outside
 * them is amber — and `low_critical`/`high_critical` bound the amber band, so a
 * value outside *those* is red. The schema's `vitals_reference_ranges_band_order`
 * CHECK (`low_critical <= low_abnormal`, `high_critical >= high_abnormal`) only
 * makes sense under that reading.
 *
 * `OP-007 §5.1` tabulates the **amber** and **red** bands instead, so its rows
 * cannot be copied into these columns directly. Doing so inverts the flag: a
 * normal value falls outside the "normal" band and reads amber, while a genuinely
 * abnormal one falls inside it and reads normal. Six parameters were encoded that
 * way and are corrected below; each carries the §5.1 band it was derived from.
 */
export const ADULT_RANGES: readonly Range[] = [
  ['systolic', 6570, 43800, 'any', 100, 140, 90, 180, 40, 300, 'mmHg'],
  ['diastolic', 6570, 43800, 'any', null, 90, 50, 110, 10, 200, 'mmHg'],
  ['pulse', 6570, 43800, 'any', 60, 100, 50, 120, 20, 300, '/min'],
  ['spo2', 6570, 43800, 'any', 95, null, 92, null, 0, 100, '%'], // §5.1: amber 92-94, red < 92
  ['temperature_c', 6570, 43800, 'any', 36.1, 37.5, 35.0, 39.0, 30, 45, 'degC'], // §5.1: amber 37.6-38.9 / 35.1-36.0, red >= 39.0 / <= 35.0
  ['resp_rate', 6570, 43800, 'any', 9, 24, 8, 25, 4, 80, '/min'],
  ['glucose_rbs', 6570, 43800, 'any', 70, 140, 70, 300, 10, 900, 'mg/dL'], // §5.1: amber 141-250, red < 70 or > 300
  ['glucose_fbs', 6570, 43800, 'any', 70, 99, 60, 200, 10, 900, 'mg/dL'], // §5.1: amber 100-125, red < 60 or >= 200
  ['pain_score', 6570, 43800, 'any', null, 3, null, 7, 0, 10, 'NRS'], // §5.1: amber 4-6, red >= 7
  ['bmi', 6570, 43800, 'any', 18.5, 22.9, 16, 30, 8, 80, 'kg/m2'], // WHO Asian: normal 18.5-22.9, overweight 23-24.9, red >= 30
  // paediatric bands, APLS normal ranges
  ['pulse', 0, 28, 'any', 120, 160, 100, 180, 20, 300, '/min'],
  ['pulse', 29, 365, 'any', 110, 160, 90, 180, 20, 300, '/min'],
  ['pulse', 366, 1825, 'any', 95, 140, 80, 160, 20, 300, '/min'],
  ['pulse', 1826, 4380, 'any', 80, 120, 70, 140, 20, 300, '/min'],
  ['pulse', 4381, 6569, 'any', 60, 100, 50, 130, 20, 300, '/min'],
  ['resp_rate', 0, 28, 'any', 30, 60, 25, 70, 4, 90, '/min'],
  ['resp_rate', 29, 365, 'any', 25, 45, 20, 60, 4, 90, '/min'],
  ['resp_rate', 366, 1825, 'any', 20, 30, 18, 40, 4, 90, '/min'],
  ['resp_rate', 1826, 4380, 'any', 18, 25, 15, 35, 4, 90, '/min'],
  ['systolic', 0, 28, 'any', 60, 90, 50, 100, 30, 200, 'mmHg'],
  ['systolic', 29, 1825, 'any', 75, 110, 65, 120, 30, 200, 'mmHg'],
  ['systolic', 1826, 6569, 'any', 90, 120, 80, 140, 30, 250, 'mmHg'],
  ['spo2', 0, 6569, 'any', 95, null, 92, null, 0, 100, '%'], // amber 92-94, red < 92
];

async function seedVitalsConfiguration(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const rangeRows: SeedRow[] = [];
  const stationRows: SeedRow[] = [];
  const deviceRows: SeedRow[] = [];
  const policyRows: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    for (const [
      parameter,
      ageMin,
      ageMax,
      sex,
      lowAbn,
      highAbn,
      lowCrit,
      highCrit,
      lowPlaus,
      highPlaus,
      unit,
    ] of ADULT_RANGES) {
      rangeRows.push({
        id: seedId('vitals-range', h.code, parameter, String(ageMin), String(ageMax), sex),
        hospital_id: h.id,
        branch_id: null,
        parameter,
        age_min_days: ageMin,
        age_max_days: ageMax,
        sex,
        pregnancy: null,
        scale: null,
        low_abnormal: lowAbn,
        high_abnormal: highAbn,
        low_critical: lowCrit,
        high_critical: highCrit,
        low_plausible: lowPlaus,
        high_plausible: highPlaus,
        unit,
        effective_from: SEED_EPOCH,
        effective_to: null,
        status: 'active',
        approved_by: null,
        approved_at: SEED_EPOCH,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
      });
    }

    // OP-007 §5.1: "pregnancy: SBP >= 140 or DBP >= 90 flagged abnormal
    // (pre-eclampsia screen) and >= 160/110 critical." A separate row rather
    // than a special case in the evaluator.
    for (const [parameter, lowAbn, highAbn, highCrit, unit] of [
      ['systolic', 100, 140, 160, 'mmHg'],
      ['diastolic', null, 90, 110, 'mmHg'],
    ] as const) {
      rangeRows.push({
        id: seedId('vitals-range-preg', h.code, parameter),
        hospital_id: h.id,
        branch_id: null,
        parameter,
        age_min_days: 4380,
        age_max_days: 20075,
        sex: 'female',
        pregnancy: 'yes',
        scale: null,
        low_abnormal: lowAbn,
        high_abnormal: highAbn,
        low_critical: null,
        high_critical: highCrit,
        low_plausible: parameter === 'systolic' ? 40 : 10,
        high_plausible: parameter === 'systolic' ? 300 : 200,
        unit,
        effective_from: SEED_EPOCH,
        effective_to: null,
        status: 'active',
        approved_by: null,
        approved_at: SEED_EPOCH,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
      });
    }

    // OP-007 §5.2 / §5.1: SpO2 scale 2, used only when a doctor has set the
    // hypercapnic-COPD flag. Same parameter, different scale — which is why
    // `scale` is part of the overlap-exclusion key.
    rangeRows.push({
      id: seedId('vitals-range-copd', h.code, 'spo2'),
      hospital_id: h.id,
      branch_id: null,
      parameter: 'spo2',
      age_min_days: 6570,
      age_max_days: 43800,
      sex: 'any',
      pregnancy: null,
      scale: 2,
      low_abnormal: 88,
      high_abnormal: 93,
      // §5.1: "< 88 on COPD scale 2" is red. Without this bound the scale-2
      // patient the row exists for could never trigger a critical alert at all,
      // which is the opposite of what a separate COPD scale is for.
      low_critical: 88,
      high_critical: null,
      low_plausible: 0,
      high_plausible: 100,
      unit: '%',
      effective_from: SEED_EPOCH,
      effective_to: null,
      status: 'active',
      approved_by: null,
      approved_at: SEED_EPOCH,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      updated_by: null,
    });

    for (const b of h.branches) {
      for (const n of [1, 2]) {
        const stationId = seedId('vitals-station', h.code, b.code, String(n));
        stationRows.push({
          id: stationId,
          hospital_id: h.id,
          branch_id: b.id,
          code: `VS${n}`,
          name: `Vitals station ${n}`,
          location: 'OPD ground floor',
          station_group_id: seedId('vitals-station-group', h.code, b.code),
          queue_id: null,
          room_key: null,
          printer_id: null,
          is_active: true,
          created_at: SEED_EPOCH,
          created_by: null,
          updated_at: SEED_EPOCH,
          updated_by: null,
        });

        for (const [type, make, model] of [
          ['bp', 'Omron', 'HBP-1300'],
          ['spo2', 'Contec', 'CMS50D'],
          ['thermometer', 'Microlife', 'NC 150'],
          ['scale', 'Seca', '813'],
        ] as const) {
          deviceRows.push({
            id: seedId('vitals-device', h.code, b.code, String(n), type),
            hospital_id: h.id,
            branch_id: b.id,
            station_id: stationId,
            type,
            make,
            model,
            // Obviously synthetic: docs/09 §11 forbids real identifiers in seeds.
            serial: `SEED-${b.code}-${String(n)}-${type.toUpperCase()}`,
            connection: 'ble',
            address: null,
            asset_id: null,
            calibration_due: '2027-01-01',
            status: 'active',
            last_seen_at: null,
            created_at: SEED_EPOCH,
            created_by: null,
            updated_at: SEED_EPOCH,
            updated_by: null,
          });
        }
      }
    }

    // OP-007 §5: "default adult: BP, pulse, SpO2, temp, weight; paeds: + height,
    // head circ < 2 y". Seeded for the two departments that always route through
    // the vitals room in a trauma-and-ortho hospital.
    for (const dept of ['GENMED', 'ORTHO', 'PAED']) {
      policyRows.push({
        id: seedId('dept-vitals-policy', h.code, dept),
        hospital_id: h.id,
        branch_id: null,
        department_key: seedId('mdm-department-key', h.code, dept),
        practitioner_key: null,
        vitals_required: true,
        mandatory_fields:
          dept === 'PAED'
            ? ['systolic', 'diastolic', 'pulse', 'spo2', 'temperature_c', 'weight_kg', 'height_cm']
            : ['systolic', 'diastolic', 'pulse', 'spo2', 'temperature_c', 'weight_kg'],
        paediatric_fields: ['height_cm', 'head_circ_cm'],
        paediatric_age_days: dept === 'PAED' ? 6570 : 4380,
        repeat_threshold_minutes: 120,
        critical_blocks_forward: true,
        active: true,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
      });
    }
  }

  await ctx.write({ table: 'clinical.vitals_reference_ranges', conflict: ['id'] }, rangeRows);
  await ctx.write({ table: 'clinical.vitals_stations', conflict: ['id'] }, stationRows);
  await ctx.write({ table: 'clinical.vitals_devices', conflict: ['id'] }, deviceRows);
  await ctx.write({ table: 'clinical.department_vitals_policies', conflict: ['id'] }, policyRows);
}

// ── EN-029 ──────────────────────────────────────────────────────────────────

/** code, label, requires free text, minimum length. */
const OVERRIDE_REASONS: readonly (readonly [string, string, boolean, number])[] = [
  ['PRIOR_TOLERANCE', 'Patient has tolerated this before', false, 0],
  ['BENEFIT_OUTWEIGHS', 'Clinical benefit outweighs the risk in this case', false, 0],
  ['ALLERGY_DISPUTED', 'Reported allergy is an intolerance, not a true allergy', false, 0],
  ['DESENSITISED', 'Patient desensitised / premedicated', false, 0],
  ['SPECIALIST_ADVICE', 'Prescribed on specialist advice', false, 0],
  ['NO_ALTERNATIVE', 'No suitable alternative available', false, 0],
  ['MONITORING_PLANNED', 'Will monitor levels / INR / renal function', false, 0],
  ['DOSE_INTENTIONAL', 'Dose is intentional and reviewed', false, 0],
  ['ALERT_NOT_RELEVANT', 'Alert not clinically relevant to this patient', false, 0],
  // EN-029 §5: "`other` requires >= 20 characters".
  ['OTHER', 'Other (state the reason)', true, 20],
];

/**
 * One rule per safety-floor entry, plus two ordinary tunable rules so the
 * governance screens have something that *can* be tuned next to something that
 * cannot.
 *
 * The floor-enforcing ones carry `enforces_floor_key`, which the migration's
 * trigger reads: they may not be disabled, shadowed, retired, downgraded below
 * `hard_stop`, suppressed or end-dated. Trying any of those is the test
 * `phase-02` exit gate 2 asks for.
 */
const FLOOR_RULES: readonly (readonly [
  key: string,
  name: string,
  family: string,
  floorKey: string,
  severity: string,
  rationale: string,
])[] = [
  [
    'allergy.documented.hard_stop',
    'Documented allergy to the prescribed substance or a cross-reactive class',
    'allergy',
    'allergy_documented_anaphylaxis',
    'contraindicated',
    'NABH 5th ed. MOM and docs/04 §7. Evaluates against patient.allergies and clinical.cdss_allergy_cross_map, both local, so D-9 forbids it from degrading when the vendor knowledge base is unreachable.',
  ],
  [
    'ddi.contraindicated.hard_stop',
    'Contraindicated drug-drug interaction',
    'ddi',
    'interaction_contraindicated',
    'contraindicated',
    'The contraindicated tier is carried in the offline interaction subset; only the wider severity grading and the management text depend on a licensed release (D-9).',
  ],
  [
    'pregnancy.category_x.hard_stop',
    'Pregnancy category X drug in a confirmed pregnancy',
    'pregnancy',
    'pregnancy_category_x',
    'contraindicated',
    'Category X means the risk clearly outweighs any benefit. docs/04 §7.',
  ],
  [
    'schedule.ndps_cap.hard_stop',
    'NDPS statutory quantity or duration cap exceeded',
    'schedule_guardrail',
    'ndps_statutory_cap',
    'contraindicated',
    'A statutory cap is not a clinical judgement a hospital may tune. NDPS Act 1985.',
  ],
  [
    'paediatric.missing_weight.hard_stop',
    'Weight-based dose in an under-18 with no recorded weight',
    'paediatric_weight',
    'paediatric_missing_weight',
    'major',
    'EN-029 §3.8: safer to block than to guess. The database additionally refuses to store such a prescription line at all.',
  ],
  [
    'dose.absolute_ceiling.hard_stop',
    'Dose above 200 per cent of the absolute ceiling',
    'dose_range',
    'dose_above_absolute_ceiling',
    'major',
    'Two hundred per cent of a ceiling is a decimal-point error, not a dosing decision. docs/04 §7.',
  ],
];

/** key, name, family, interruption, severity, alerts-per-1000 budget. */
const TUNABLE_RULES: readonly (readonly [string, string, string, string, string, number])[] = [
  ['ddi.major.soft_stop', 'Major drug-drug interaction', 'ddi', 'soft_stop', 'major', 30],
  [
    'duplicate.therapy.passive',
    'Duplicate therapy — same molecule or ATC class already active',
    'duplicate_therapy',
    'passive',
    'moderate',
    60,
  ],
  [
    'geriatric.beers.passive',
    'Beers criteria caution in a patient over 65',
    'geriatric',
    'passive',
    'low',
    80,
  ],
];

async function seedCdss(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  // The reason set is shipped (hospital_id null): a hospital may add its own
  // codes, but the shipped ones are what the fatigue dashboard aggregates
  // across tenants for the product's own benchmarking.
  const reasonSetId = seedId('cdss-reason-set', 'medication.default');
  await ctx.write({ table: 'clinical.cdss_override_reason_sets', conflict: ['id'] }, [
    {
      id: reasonSetId,
      hospital_id: null,
      key: 'medication.default',
      name: 'Medication alert override reasons',
      family_scope: ['allergy', 'ddi', 'dose_range', 'duplicate_therapy', 'pregnancy', 'geriatric'],
      active: true,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      updated_by: null,
    },
  ]);

  await ctx.write(
    { table: 'clinical.cdss_override_reasons', conflict: ['id'] },
    OVERRIDE_REASONS.map(([code, label, requiresText, minLength], index) => ({
      id: seedId('cdss-reason', code),
      hospital_id: null,
      reason_set_id: reasonSetId,
      code,
      label,
      requires_free_text: requiresText,
      min_free_text_length: minLength,
      sort_order: index,
      active: true,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      updated_by: null,
    })),
  );

  const ruleRows: SeedRow[] = [];
  const versionRows: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    for (const [key, name, family, floorKey, severity, rationale] of FLOOR_RULES) {
      const ruleId = seedId('cdss-rule', h.code, key);
      ruleRows.push({
        id: ruleId,
        hospital_id: h.id,
        branch_id: null,
        key,
        name,
        family,
        scope: 'hospital',
        owner_role: 'medical_superintendent',
        clinical_rationale: rationale,
        evidence: jsonb({
          sources: ['docs/04-security-compliance.md §7', 'docs/modules/05-enablers/EN-029 §5'],
          year: 2026,
        }),
        enforces_floor_key: floorKey,
        status: 'active',
        current_version: 1,
        alert_budget_per_1000: null,
        disabled_at: null,
        disabled_by: null,
        disabled_reason: null,
        governance_decision: null,
        governance_reviewed_at: null,
        governance_minutes_ref: null,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
      });
      versionRows.push({
        id: seedId('cdss-rule-version', h.code, key, '1'),
        hospital_id: h.id,
        rule_id: ruleId,
        version: 1,
        family,
        condition: jsonb({ floor: floorKey }),
        action: jsonb({
          title: name,
          oneLiner: rationale.split('.')[0] ?? name,
          suggestedActions: ['choose_alternative', 'contact_consultant'],
        }),
        interruption: 'hard_stop',
        severity,
        applicability: jsonb({ encounterTypes: ['opd', 'er', 'ip_consult', 'tele'] }),
        // Must stay empty: the migration's trigger refuses a suppression policy
        // on a floor-enforcing rule (EN-029 §5).
        suppression: jsonb({}),
        override_reason_set_id: reasonSetId,
        effective_from: SEED_EPOCH,
        effective_to: null,
        published_by: null,
        published_at: SEED_EPOCH,
        // A hard stop always carries an EN-038 approval reference. Deterministic
        // and obviously synthetic, like every other seeded identifier.
        approval_ref: seedId('cdss-approval', h.code, key),
        test_report: jsonb({ seeded: true, note: 'Shipped floor rule; no tenant cohort was replayed.' }),
        checksum: checksumOf(`${h.code}|${key}|1`),
        created_at: SEED_EPOCH,
        created_by: null,
      });
    }

    for (const [key, name, family, interruption, severity, budget] of TUNABLE_RULES) {
      const ruleId = seedId('cdss-rule', h.code, key);
      ruleRows.push({
        id: ruleId,
        hospital_id: h.id,
        branch_id: null,
        key,
        name,
        family,
        scope: 'hospital',
        owner_role: 'pharmacy_in_charge',
        clinical_rationale:
          'Tunable by the CDSS governance committee: severity, scope and suppression may all change without a release (EN-029 §3.7).',
        evidence: jsonb({ sources: ['docs/modules/05-enablers/EN-029 §3.1'], year: 2026 }),
        enforces_floor_key: null,
        status: 'active',
        current_version: 1,
        alert_budget_per_1000: budget,
        disabled_at: null,
        disabled_by: null,
        disabled_reason: null,
        governance_decision: null,
        governance_reviewed_at: null,
        governance_minutes_ref: null,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
      });
      versionRows.push({
        id: seedId('cdss-rule-version', h.code, key, '1'),
        hospital_id: h.id,
        rule_id: ruleId,
        version: 1,
        family,
        condition: jsonb({ family }),
        action: jsonb({ title: name, oneLiner: name }),
        interruption,
        severity,
        applicability: jsonb({ encounterTypes: ['opd', 'er', 'ip_consult', 'tele'] }),
        suppression: jsonb(
          interruption === 'soft_stop'
            ? { scope: 'patient_drug', windowHours: 72, snoozeAllowed: false, maxPerEncounter: 1 }
            : {},
        ),
        override_reason_set_id: reasonSetId,
        effective_from: SEED_EPOCH,
        effective_to: null,
        published_by: null,
        published_at: SEED_EPOCH,
        approval_ref: interruption === 'hard_stop' ? seedId('cdss-approval', h.code, key) : null,
        test_report: jsonb({ seeded: true }),
        checksum: checksumOf(`${h.code}|${key}|1`),
        created_at: SEED_EPOCH,
        created_by: null,
      });
    }
  }

  await ctx.write({ table: 'clinical.cdss_rules', conflict: ['id'] }, ruleRows);
  await ctx.write({ table: 'clinical.cdss_rule_versions', conflict: ['id'] }, versionRows);

  // ── the knowledge base ────────────────────────────────────────────────────
  // `local_formulary`, because O-1 in docs/DECISIONS.md is still open and the
  // product must run acceptably with no vendor licence at all. Shipped
  // (hospital_id null), so a tenant sees it without loading anything.
  const kbId = seedId('cdss-kb-release', 'local_formulary', '2026.1');
  await ctx.write({ table: 'clinical.cdss_kb_releases', conflict: ['id'] }, [
    {
      id: kbId,
      hospital_id: null,
      provider: 'local_formulary',
      release_version: '2026.1',
      licence_ref: null,
      loaded_at: SEED_EPOCH,
      checksum: checksumOf('local_formulary|2026.1'),
      coverage: jsonb({
        interactions: 8,
        doseBands: 8,
        note: 'The licence-free core: contraindicated and major pairs, paediatric mg/kg bands, and the absolute ceilings the docs/04 §7 floor needs. Severity grading beyond this, pregnancy categories and food interactions arrive with a licensed provider (O-1).',
      }),
      status: 'active',
      diff_report_file_id: null,
      expires_at: null,
      reviewed_by: null,
      reviewed_at: SEED_EPOCH,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      updated_by: null,
    },
  ]);

  /** a kind, a code, b kind, b code, severity, onset, mechanism, management. */
  const INTERACTIONS: readonly (readonly [string, string, string, string, string, string, string, string])[] =
    [
      [
        'atc',
        'C01DA02',
        'atc',
        'G04BE03',
        'contraindicated',
        'rapid',
        'Additive vasodilation through the nitric oxide / cGMP pathway.',
        'Do not co-prescribe. Nitrates are contraindicated within 24 hours of sildenafil (48 hours for tadalafil).',
      ],
      [
        'atc',
        'B01AA03',
        'atc',
        'B01AC06',
        'major',
        'delayed',
        'Additive bleeding risk: anticoagulation plus platelet inhibition.',
        'Co-prescribe only for a documented indication. Monitor INR closely and consider gastroprotection.',
      ],
      [
        'atc',
        'B01AA03',
        'atc',
        'M01AB05',
        'major',
        'delayed',
        'NSAIDs displace warfarin from protein binding and impair platelet function.',
        'Prefer paracetamol. If unavoidable, monitor INR and add a proton pump inhibitor.',
      ],
      [
        'atc',
        'B01AA03',
        'atc',
        'J01EE01',
        'major',
        'delayed',
        'Co-trimoxazole inhibits CYP2C9 and displaces warfarin, raising INR sharply.',
        'Choose another antibacterial. If unavoidable, recheck INR within 3 days.',
      ],
      [
        'atc',
        'B01AA03',
        'atc',
        'J01FA10',
        'moderate',
        'delayed',
        'Macrolides may raise the INR.',
        'Recheck INR after 3-5 days.',
      ],
      [
        'atc',
        'C09AA02',
        'atc',
        'M01AB05',
        'moderate',
        'delayed',
        'NSAIDs blunt the antihypertensive effect and, with a diuretic, risk acute kidney injury.',
        'Monitor blood pressure and renal function; limit the NSAID course.',
      ],
      [
        'atc',
        'A10BA02',
        'condition',
        'egfr_lt_30',
        'contraindicated',
        'delayed',
        'Metformin accumulates in renal impairment and precipitates lactic acidosis.',
        'Stop metformin below eGFR 30 mL/min/1.73m2.',
      ],
      [
        'atc',
        'N05BA01',
        'atc',
        'N02AA01',
        'major',
        'rapid',
        'Additive respiratory and central nervous system depression.',
        'Avoid. If both are required, reduce doses and monitor respiration continuously.',
      ],
    ];

  await ctx.write(
    { table: 'clinical.cdss_kb_interactions', conflict: ['id'] },
    INTERACTIONS.map(([aKind, aCode, bKind, bCode, severity, onset, mechanism, management]) => ({
      id: seedId('cdss-kb-interaction', aCode, bCode),
      hospital_id: null,
      kb_release_id: kbId,
      subject_a_kind: aKind,
      subject_a_code: aCode,
      subject_a_display: ATC_CONCEPTS.find((c) => c[0] === aCode)?.[1] ?? aCode,
      subject_b_kind: bKind,
      subject_b_code: bCode,
      subject_b_display: ATC_CONCEPTS.find((c) => c[0] === bCode)?.[1] ?? bCode,
      severity,
      onset,
      documentation: 'good',
      mechanism_md: mechanism,
      management_md: management,
      source_ref: 'Hospital formulary committee, 2026 review',
      created_at: SEED_EPOCH,
    })),
  );

  /**
   * Dose bands. The paracetamol paediatric row is the one `phase-02` exit gate 3
   * fires on: 15 mg/kg per dose, 60 mg/kg/day, and an absolute ceiling of 75
   * mg/kg/day — so a 12 kg child prescribed 500 mg TDS (125 mg/kg/day) is well
   * over 200 per cent of the ceiling and hits the floor, not a warning.
   *
   * drug ATC, route, population, basis, min, max, unit, maxDaily, ceiling.
   */
  const DOSE_RULES: readonly (readonly [
    string,
    string,
    string,
    string,
    number,
    number,
    string,
    number,
    number,
  ])[] = [
    ['N02BE01', 'oral', 'child', 'per_kg', 10, 15, 'mg/kg/dose', 60, 75],
    ['N02BE01', 'oral', 'adult', 'flat', 500, 1000, 'mg/dose', 4000, 4000],
    ['J01CA04', 'oral', 'child', 'per_kg', 20, 40, 'mg/kg/day', 90, 100],
    ['J01CA04', 'oral', 'adult', 'flat', 250, 1000, 'mg/dose', 3000, 4000],
    ['M01AE01', 'oral', 'child', 'per_kg', 5, 10, 'mg/kg/dose', 30, 40],
    ['B01AA03', 'oral', 'adult', 'flat', 1, 10, 'mg/day', 10, 15],
    ['N02AA01', 'intravenous', 'child', 'per_kg', 0.05, 0.1, 'mg/kg/dose', 0.4, 0.5],
    ['A10BA02', 'oral', 'adult', 'flat', 500, 1000, 'mg/dose', 2550, 3000],
  ];

  await ctx.write(
    { table: 'clinical.cdss_kb_dose_rules', conflict: ['id'] },
    DOSE_RULES.map(([atc, route, population, basis, minDose, maxDose, unit, maxDaily, ceiling]) => ({
      id: seedId('cdss-kb-dose', atc, route, population),
      hospital_id: null,
      kb_release_id: kbId,
      drug_key_kind: 'atc',
      drug_key: atc,
      route,
      indication_code: null,
      population,
      basis,
      min_dose: minDose,
      max_dose: maxDose,
      unit,
      max_daily: maxDaily,
      absolute_ceiling: ceiling,
      max_course_days: null,
      freq_min: null,
      freq_max: null,
      renal_bands: jsonb(
        atc === 'A10BA02'
          ? [
              { egfrMin: 45, egfrMax: 59, adjustment: 'max 1000 mg/day' },
              { egfrMin: 30, egfrMax: 44, adjustment: 'max 500 mg/day' },
              { egfrMin: 0, egfrMax: 29, adjustment: 'contraindicated' },
            ]
          : [],
      ),
      hepatic_bands: jsonb([]),
      notes: null,
      created_at: SEED_EPOCH,
    })),
  );

  /**
   * The cross-sensitivity map. This is the table that turns "allergic to
   * Amoxicillin" into a hard stop on Ampicillin and a warning on Ceftriaxone,
   * and it is local data — which is exactly why D-9 forbids the allergy check
   * from degrading when a remote service is down.
   *
   * class, member ATC/SNOMED, cross classes, cross-reactivity %.
   */
  const CROSS_MAP: readonly (readonly [string, string, string, string, readonly string[], number])[] = [
    ['penicillin', 'ATC', 'J01C', 'Beta-lactam antibacterials, penicillins', ['cephalosporin'], 2],
    ['penicillin', 'ATC', 'J01CA04', 'Amoxicillin', ['cephalosporin'], 2],
    ['penicillin', 'ATC', 'J01CR02', 'Amoxicillin and beta-lactamase inhibitor', ['cephalosporin'], 2],
    ['cephalosporin', 'ATC', 'J01DD04', 'Ceftriaxone', ['penicillin'], 2],
    ['sulfonamide', 'ATC', 'J01EE01', 'Sulfamethoxazole and trimethoprim', [], 0],
    ['nsaid', 'ATC', 'M01AB05', 'Diclofenac', ['salicylate'], 25],
    ['nsaid', 'ATC', 'M01AE01', 'Ibuprofen', ['salicylate'], 25],
    ['salicylate', 'ATC', 'B01AC06', 'Acetylsalicylic acid', ['nsaid'], 25],
    ['opioid', 'ATC', 'N02AA01', 'Morphine', [], 0],
  ];

  await ctx.write(
    { table: 'clinical.cdss_allergy_cross_map', conflict: ['id'] },
    CROSS_MAP.map(([allergenClass, systemKey, member, display, crossClasses, pct]) => ({
      id: seedId('cdss-cross-map', allergenClass, member),
      hospital_id: null,
      allergen_class: allergenClass,
      code_system_key: systemKey,
      member_substance: member,
      member_display: display,
      cross_classes: crossClasses,
      cross_reactivity_pct: pct,
      source: 'Product default, reviewed against the 2026 hospital formulary',
      active: true,
      created_at: SEED_EPOCH,
      created_by: null,
      updated_at: SEED_EPOCH,
      updated_by: null,
    })),
  );
}

// ── NC-003 MRD configuration ────────────────────────────────────────────────

/** code, encounter kind, description, check type, params, role, due hours. */
const DEFICIENCY_RULES: readonly (readonly [
  string,
  string,
  string,
  string,
  Record<string, unknown>,
  string,
  number,
])[] = [
  [
    'DX_PRESENT',
    'op',
    'At least one diagnosis, or a recorded reason for none',
    'field_present',
    { table: 'clinical.encounter_diagnoses', orField: 'no_diagnosis_reason' },
    'doctor',
    24,
  ],
  [
    'NOTE_SIGNED',
    'op',
    'The consultation note is signed',
    'document_signed',
    { documentType: 'consult_note' },
    'doctor',
    24,
  ],
  [
    'RX_SIGNED',
    'op',
    'Every prescription is signed or countersigned',
    'document_signed',
    { documentType: 'prescription' },
    'doctor',
    24,
  ],
  [
    'VITALS_CAPTURED',
    'op',
    'Vitals captured, or a recorded reason for not doing so',
    'field_present',
    { table: 'clinical.vitals', orField: 'not_done_reason' },
    'nurse',
    4,
  ],
  ['CODED', 'op', 'ICD coding complete and QA-passed', 'coded', { minStatus: 'coded' }, 'mrd_coder', 72],
  [
    'MLC_LINKED',
    'mlc_op',
    'A medico-legal record is linked to its MLC case',
    'field_present',
    { field: 'ml_source_ref' },
    'mrd_officer',
    24,
  ],
];

/** code, name, encounter kind, retain years, count from, action, applies to ML. */
const RETENTION_POLICIES: readonly (readonly [
  string,
  string,
  string | null,
  number,
  string,
  string,
  boolean,
  Record<string, unknown>,
])[] = [
  ['OP_ADULT', 'Outpatient record, adult', 'op', 10, 'closure', 'review', false, { ageAtEncounterMin: 18 }],
  [
    'PAEDIATRIC',
    'Any record for a minor — retained until age 21',
    null,
    21,
    'age18',
    'review',
    false,
    { ageAtEncounterMax: 17 },
  ],
  [
    'MEDICO_LEGAL',
    'Medico-legal record — permanent',
    null,
    99,
    'closure',
    'review',
    false,
    { isMedicoLegal: true },
  ],
  [
    'DEATH',
    'Record of a death — permanent, MCCD required before closure',
    null,
    99,
    'closure',
    'review',
    false,
    { isDeath: true },
  ],
];

async function seedMrdConfiguration(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const ruleRows: SeedRow[] = [];
  const policyRows: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    for (const [code, kind, description, checkType, params, role, dueHours] of DEFICIENCY_RULES) {
      ruleRows.push({
        id: seedId('mrd-deficiency-rule', h.code, code),
        hospital_id: h.id,
        branch_id: null,
        encounter_kind: kind,
        code,
        description,
        check_type: checkType,
        params: jsonb(params),
        responsible_role: role,
        due_hours: dueHours,
        escalation: jsonb({ afterHours: dueHours * 2, to: 'hod' }),
        active: true,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
      });
    }

    for (const [
      code,
      name,
      kind,
      retainYears,
      countFrom,
      action,
      appliesToMl,
      condition,
    ] of RETENTION_POLICIES) {
      policyRows.push({
        id: seedId('mrd-retention-policy', h.code, code),
        hospital_id: h.id,
        code,
        name,
        encounter_kind: kind,
        condition: jsonb(condition),
        retain_years: retainYears,
        count_from: countFrom,
        action,
        // NC-003 §5: a medico-legal record is never destroyed. The migration's
        // CHECK refuses a `destroy` policy that claims otherwise, so this is
        // false everywhere and the "permanent" policies are `review`.
        applies_to_medico_legal: appliesToMl,
        priority: RETENTION_POLICIES.findIndex((p) => p[0] === code) * 10,
        active: true,
        created_at: SEED_EPOCH,
        created_by: null,
        updated_at: SEED_EPOCH,
        updated_by: null,
      });
    }
  }

  await ctx.write({ table: 'clinical.mrd_deficiency_rules', conflict: ['id'] }, ruleRows);
  await ctx.write({ table: 'clinical.mrd_retention_policies', conflict: ['id'] }, policyRows);
}

/**
 * A deterministic 64-hex digest for seeded rows whose column is CHECKed to be a
 * sha256. `seedId` already hashes; this reuses it twice rather than importing
 * `node:crypto` a second time, and the value's only job is to be stable and
 * well-formed.
 */
function checksumOf(input: string): string {
  return (seedId('checksum', input) + seedId('checksum2', input)).replace(/-/g, '');
}
