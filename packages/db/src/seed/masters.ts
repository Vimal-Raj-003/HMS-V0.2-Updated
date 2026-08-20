import type { SeedContext } from './context.js';
import { SEED_EPOCH, seedId } from './ids.js';
import { jsonb, type SeedRow, type SeedValue } from './upsert.js';
import { type SeededTenancy } from './tenancy.js';

/**
 * The EN-027 domain masters Phase 1 consumes.
 *
 * Every one of them uses the effective-dated pattern `mdm_departments`
 * established in Phase 0, so this file has exactly one shape helper and
 * fifteen tables' worth of data rather than fifteen slightly different
 * insert routines. `record_key` is the stable identity a later version
 * supersedes; `id` is one version of it; the exclusion constraint on each
 * table guarantees the versions never overlap.
 *
 * These are seeded **per hospital**, not shipped globally, and that is a
 * deliberate reading of EN-027 §3.6: a hospital renames "Area" to "Locality",
 * adds an occupation the NCO does not list, and disables the religions it does
 * not record. A global catalogue would make each of those a product change.
 * Terminology proper — ICD-10 here, LOINC and SNOMED later — *is* global, and
 * goes into the `mdm_code_systems` / `mdm_concepts` tables Phase 0 created for
 * exactly that reason.
 */
export async function seedMasters(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  await seedTerminology(ctx);
  await seedSpecialities(ctx, tenancy);
  await seedConsultTypes(ctx, tenancy);
  await seedPractitioners(ctx, tenancy);
  await seedServices(ctx, tenancy);
  await seedRooms(ctx, tenancy);
  await seedDemographicLookups(ctx, tenancy);
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

// ── terminology: the ICD-10 loader (`phase-01 §1.1`) ────────────────────────

/**
 * ICD-10 lands as a code system plus its concepts, not as a bespoke table.
 * EN-027 §4 puts all terminology in `mdm_code_systems` / `mdm_concepts`, and
 * Phase 0 created them with the "readable only with a tenant context" policy
 * and the trigram index on `display` already in place. A parallel `mdm_icd10`
 * would fork terminology in two and break subsumption queries.
 *
 * A representative slice rather than all 14 000 codes: the seed's job is to
 * make the loader path real and the indexes honest, and the full WHO release is
 * a licensed file a hospital loads through EN-036, not something a repository
 * ships. `concept_count` records what a full load would report.
 */
const ICD10_CHAPTERS: readonly (readonly [string, string])[] = [
  ['I', 'Certain infectious and parasitic diseases'],
  ['IX', 'Diseases of the circulatory system'],
  ['X', 'Diseases of the respiratory system'],
  ['XI', 'Diseases of the digestive system'],
  ['XIII', 'Diseases of the musculoskeletal system and connective tissue'],
  ['XIX', 'Injury, poisoning and certain other consequences of external causes'],
];

/** code, display, parent, chapter — an ortho- and trauma-weighted slice. */
const ICD10_CODES: readonly (readonly [string, string, string | null, string])[] = [
  ['A09', 'Infectious gastroenteritis and colitis, unspecified', null, 'I'],
  ['A15', 'Respiratory tuberculosis, bacteriologically and histologically confirmed', null, 'I'],
  ['E11', 'Type 2 diabetes mellitus', null, 'IV'],
  ['E11.9', 'Type 2 diabetes mellitus without complications', 'E11', 'IV'],
  ['I10', 'Essential (primary) hypertension', null, 'IX'],
  ['I20', 'Angina pectoris', null, 'IX'],
  ['I21', 'Acute myocardial infarction', null, 'IX'],
  ['I50', 'Heart failure', null, 'IX'],
  ['J18', 'Pneumonia, unspecified organism', null, 'X'],
  ['J44', 'Other chronic obstructive pulmonary disease', null, 'X'],
  ['J45', 'Asthma', null, 'X'],
  ['K29', 'Gastritis and duodenitis', null, 'XI'],
  ['K80', 'Cholelithiasis', null, 'XI'],
  ['M17', 'Osteoarthritis of knee', null, 'XIII'],
  ['M51', 'Thoracic, thoracolumbar and lumbosacral intervertebral disc disorders', null, 'XIII'],
  ['M54', 'Dorsalgia', null, 'XIII'],
  ['M54.5', 'Low back pain', 'M54', 'XIII'],
  ['S06', 'Intracranial injury', null, 'XIX'],
  ['S42', 'Fracture of shoulder and upper arm', null, 'XIX'],
  ['S42.0', 'Fracture of clavicle', 'S42', 'XIX'],
  ['S52', 'Fracture of forearm', null, 'XIX'],
  ['S52.5', 'Fracture of lower end of radius', 'S52', 'XIX'],
  ['S72', 'Fracture of femur', null, 'XIX'],
  ['S72.0', 'Fracture of neck of femur', 'S72', 'XIX'],
  ['S82', 'Fracture of lower leg, including ankle', null, 'XIX'],
  ['S82.6', 'Fracture of lateral malleolus', 'S82', 'XIX'],
  ['T14', 'Injury of unspecified body region', null, 'XIX'],
  ['Z00', 'General examination without complaint or reported diagnosis', null, 'XXI'],
  ['Z34', 'Supervision of normal pregnancy', null, 'XXI'],
  ['Z96', 'Presence of other functional implants', null, 'XXI'],
];

async function seedTerminology(ctx: SeedContext): Promise<void> {
  const codeSystemId = seedId('mdm-code-system', 'ICD10', '2019');
  await ctx.write({ table: 'mdm.mdm_code_systems', conflict: ['id'] }, [
    {
      id: codeSystemId,
      key: 'ICD10',
      name: 'ICD-10 (WHO), 2019 release',
      version: '2019',
      release_date: '2019-01-01',
      licence: 'national',
      licence_ref: 'WHO ICD-10 — free for member-state use; NHA mandates ICD-10 for NHCX claims',
      source_url: 'https://icd.who.int/browse10',
      // The number of codes a full WHO release carries. The seeded slice is
      // smaller on purpose; recording the real figure keeps the delta report
      // that EN-027 §5 requires at activation honest about what is missing.
      concept_count: 14_400,
      status: 'loaded',
      loaded_at: SEED_EPOCH,
      activated_at: null,
      delta_report_file_id: null,
      created_at: SEED_EPOCH,
      updated_at: SEED_EPOCH,
    },
  ]);

  const concepts: SeedRow[] = ICD10_CODES.map(([code, display, parent, chapter]) => ({
    id: seedId('mdm-concept', 'ICD10', code),
    code_system_id: codeSystemId,
    code,
    display,
    display_lang: 'en',
    definition: null,
    parent_codes: parent === null ? [] : [parent],
    properties: jsonb({
      chapter,
      chapterTitle: ICD10_CHAPTERS.find((c) => c[0] === chapter)?.[1] ?? null,
      billable: code.includes('.') || !ICD10_CODES.some((row) => row[2] === code),
    }),
    status: 'active',
    effective_from: '2019-01-01',
    inactivated_reason: null,
    created_at: SEED_EPOCH,
    updated_at: SEED_EPOCH,
  }));
  await ctx.write({ table: 'mdm.mdm_concepts', conflict: ['id'] }, concepts);

  // The materialised closure EN-027 §4 rebuilds on activation. Depth 0 is the
  // self-row, which is what makes "is this code a kind of X?" a single lookup
  // that does not need a special case for X itself.
  const closure: SeedRow[] = [];
  for (const [code, , parent] of ICD10_CODES) {
    closure.push({
      id: seedId('mdm-closure', 'ICD10', code, code),
      code_system_id: codeSystemId,
      ancestor_code: code,
      descendant_code: code,
      depth: 0,
    });
    if (parent !== null) {
      closure.push({
        id: seedId('mdm-closure', 'ICD10', parent, code),
        code_system_id: codeSystemId,
        ancestor_code: parent,
        descendant_code: code,
        depth: 1,
      });
    }
  }
  await ctx.write({ table: 'mdm.mdm_concept_closure', conflict: ['id'] }, closure);
}

// ── specialities ────────────────────────────────────────────────────────────

/** code, name, department code, telemedicine allowed. */
const SPECIALITIES: readonly (readonly [string, string, string, boolean])[] = [
  ['GENMED', 'General Medicine', 'GENMED', true],
  ['ORTHO', 'Orthopaedics', 'ORTHO', true],
  ['TRAUMA', 'Trauma & Polytrauma', 'EMERG', false],
  ['GENSURG', 'General Surgery', 'GENSURG', true],
  ['OBGYN', 'Obstetrics & Gynaecology', 'OBGYN', true],
  ['PAED', 'Paediatrics', 'PAED', true],
  ['CARDIO', 'Cardiology', 'GENMED', true],
  ['PULMO', 'Pulmonology', 'GENMED', true],
  ['DERMA', 'Dermatology', 'GENMED', true],
  ['ENT', 'ENT', 'GENSURG', true],
  ['OPHTHAL', 'Ophthalmology', 'GENSURG', false],
  ['PHYSIO', 'Physiotherapy & Rehabilitation', 'ORTHO', true],
];

async function seedSpecialities(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const rows: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    for (const [code, name, deptCode, tele] of SPECIALITIES) {
      rows.push(
        master('mdm-speciality', h.id, seedId('mdm-speciality-key', h.code, code), null, {
          code,
          name,
          system_of_medicine: 'allopathy',
          department_key: seedId('mdm-department-key', h.code, deptCode),
          speciality_concept: null,
          telemedicine_allowed: tele,
          website_visible: true,
          sort_order: SPECIALITIES.findIndex((s) => s[0] === code),
          active_branches: h.branches.map((b) => b.id),
        }),
      );
    }
  }
  await ctx.write({ table: 'mdm.mdm_specialities', conflict: ['id'] }, rows);
}

// ── consult types ───────────────────────────────────────────────────────────

/** code, name, kind, chargeable, validity days, validity visits, minutes. */
const CONSULT_TYPES: readonly (readonly [
  string,
  string,
  string,
  boolean,
  number | null,
  number | null,
  number,
])[] = [
  ['NEW', 'New consultation', 'new', true, null, null, 15],
  ['FU', 'Follow-up', 'follow_up', true, 30, null, 10],
  // OP-001 §5: "free follow-up validity from tariff (default 7 days, 1 visit)".
  ['FREE_REVIEW', 'Free review', 'free_review', false, 7, 1, 10],
  ['PROC', 'Procedure', 'procedure', true, null, null, 30],
  ['TELE', 'Teleconsultation', 'tele', true, null, null, 15],
  ['SECOND_OPINION', 'Second opinion', 'second_opinion', true, null, null, 20],
];

async function seedConsultTypes(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const rows: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    for (const [code, name, kind, chargeable, days, visits, minutes] of CONSULT_TYPES) {
      rows.push(
        master('mdm-consult-type', h.id, seedId('mdm-consult-type-key', h.code, code), null, {
          code,
          name,
          kind,
          is_chargeable: chargeable,
          validity_days: days,
          validity_visits: visits,
          default_duration_min: minutes,
          online_bookable: kind !== 'procedure',
          sort_order: CONSULT_TYPES.findIndex((c) => c[0] === code),
        }),
      );
    }
  }
  await ctx.write({ table: 'mdm.mdm_consult_types', conflict: ['id'] }, rows);
}

// ── practitioners and their fees ────────────────────────────────────────────

/** code, name, speciality, council reg suffix, fee for a new consultation. */
const PRACTITIONERS: readonly (readonly [string, string, string, string, number])[] = [
  ['DR001', 'Ananya Krishnan', 'GENMED', 'KMC/2011/40118', 600],
  ['DR002', 'Rajiv Menon', 'ORTHO', 'KMC/2008/32204', 900],
  ['DR003', 'Suresh Gowda', 'ORTHO', 'KMC/2013/45590', 800],
  ['DR004', 'Farah Sheikh', 'OBGYN', 'KMC/2012/41876', 750],
  ['DR005', 'Vikram Iyer', 'GENSURG', 'KMC/2007/29940', 850],
  ['DR006', 'Meera Nair', 'PAED', 'KMC/2015/50331', 600],
  ['DR007', 'Arun Desai', 'CARDIO', 'KMC/2006/28112', 1200],
  ['DR008', 'Latha Subramanian', 'DERMA', 'KMC/2016/52208', 700],
  ['DR009', 'Imran Ansari', 'TRAUMA', 'KMC/2010/38004', 1000],
  ['DR010', 'Priya Shetty', 'PHYSIO', 'KAPT/2017/1188', 400],
];

async function seedPractitioners(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const practitioners: SeedRow[] = [];
  const fees: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    for (const [code, name, specCode, registration, newFee] of PRACTITIONERS) {
      const recordKey = seedId('mdm-practitioner-key', h.code, code);
      practitioners.push(
        master('mdm-practitioner', h.id, recordKey, null, {
          code,
          // A visiting consultant may have no login at all, which is why
          // `user_id` is nullable and why the seed leaves it so: linking every
          // practitioner to a seeded account would hide that case.
          user_id: null,
          title: 'DR',
          full_name: name,
          display_name: `Dr. ${name}`,
          gender: null,
          qualifications: specCode === 'PHYSIO' ? ['BPT', 'MPT'] : ['MBBS', 'MS'],
          registration_council:
            specCode === 'PHYSIO' ? 'Karnataka State Council for Physiotherapy' : 'Karnataka Medical Council',
          registration_number: registration,
          registration_valid_to: '2030-03-31',
          // ABDM HPR ids are issued to a real practitioner; a seeded one has
          // none, and pretending otherwise would put a fake id on a national
          // registry submission the day someone runs the seed against staging.
          hpr_id: null,
          department_key: seedId(
            'mdm-department-key',
            h.code,
            SPECIALITIES.find((s) => s[0] === specCode)?.[2] ?? 'GENMED',
          ),
          speciality_keys: [seedId('mdm-speciality-key', h.code, specCode)],
          languages: ['en-IN', 'hi', 'kn'],
          employment_type: 'full_time',
          default_room_key: null,
          tele_enabled: SPECIALITIES.find((s) => s[0] === specCode)?.[3] ?? false,
          online_booking_enabled: true,
          website_visible: true,
          bio: null,
          photo_file_id: null,
          signature_file_id: null,
          follow_up_days: 7,
          follow_up_free_visits: 1,
          active_branches: h.branches.map((b) => b.id),
        }),
      );

      for (const [consultCode, multiplier] of [
        ['NEW', 1],
        ['FU', 0.5],
        ['TELE', 0.8],
        ['SECOND_OPINION', 1.5],
      ] as const) {
        const feeKey = seedId('mdm-practitioner-fee-key', h.code, code, consultCode);
        fees.push(
          master('mdm-practitioner-fee', h.id, feeKey, null, {
            practitioner_key: recordKey,
            consult_type_key: seedId('mdm-consult-type-key', h.code, consultCode),
            amount: (newFee * multiplier).toFixed(2),
            currency: 'INR',
            tariff_item_key: null,
          }),
        );
      }
    }
  }

  await ctx.write({ table: 'mdm.mdm_practitioners', conflict: ['id'] }, practitioners);
  await ctx.write({ table: 'mdm.mdm_practitioner_fees', conflict: ['id'] }, fees);
}

// ── the service catalogue ───────────────────────────────────────────────────

/** code, name, group, department, SAC, GST %, procedure?, appointable?, minutes. */
const SERVICES: readonly (readonly [
  string,
  string,
  string,
  string,
  string,
  number,
  boolean,
  boolean,
  number,
])[] = [
  ['REG', 'Registration charge', 'administrative', 'ADMIN', '999319', 0, false, false, 0],
  ['REG_CARD', 'UHID card (duplicate)', 'administrative', 'ADMIN', '999319', 18, false, false, 0],
  ['CONS_OPD', 'OPD consultation', 'consultation', 'GENMED', '999312', 0, false, true, 15],
  ['CONS_TELE', 'Teleconsultation', 'consultation', 'GENMED', '999312', 0, false, true, 15],
  ['CONS_SPEC', 'Specialist consultation', 'consultation', 'GENMED', '999312', 0, false, true, 20],
  ['DRESS', 'Wound dressing', 'procedure', 'GENSURG', '999312', 0, true, true, 20],
  ['PLASTER', 'Plaster of Paris cast application', 'procedure', 'ORTHO', '999312', 0, true, true, 30],
  ['INJ', 'Injection administration', 'procedure', 'NURS', '999312', 0, true, false, 10],
  ['ECG', 'Electrocardiogram', 'diagnostic', 'GENMED', '999312', 0, true, true, 15],
  ['HC_BASIC', 'Basic health check-up package', 'package', 'GENMED', '999312', 0, false, true, 120],
];

async function seedServices(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const rows: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    for (const [code, name, group, dept, sac, gst, isProcedure, appointable, minutes] of SERVICES) {
      rows.push(
        master('mdm-service', h.id, seedId('mdm-service-key', h.code, code), null, {
          code,
          name,
          group_key: group,
          department_key: seedId('mdm-department-key', h.code, dept),
          speciality_key: null,
          sac_code: sac,
          // Healthcare services by a clinical establishment are GST-exempt
          // (Notification 12/2017 CT-R, entry 74); a card reprint is not.
          gst_rate: gst.toFixed(2),
          is_procedure: isProcedure,
          requires_consent: isProcedure,
          consent_type_key: null,
          default_duration_min: minutes,
          prerequisites: null,
          patient_instructions: null,
          is_appointable: appointable,
          active_branches: h.branches.map((b) => b.id),
        }),
      );
    }
  }
  await ctx.write({ table: 'mdm.mdm_services', conflict: ['id'] }, rows);
}

// ── rooms ───────────────────────────────────────────────────────────────────

/** code, name, display, kind. */
const ROOMS: readonly (readonly [string, string, string, string])[] = [
  ['OPD-101', 'Consultation Room 101', 'Room 101', 'consult'],
  ['OPD-102', 'Consultation Room 102', 'Room 102', 'consult'],
  ['OPD-103', 'Consultation Room 103', 'Room 103', 'consult'],
  ['OPD-104', 'Consultation Room 104', 'Room 104', 'consult'],
  ['VITALS-1', 'Vitals & Triage Room', 'Vitals', 'vitals'],
  ['PROC-1', 'Minor Procedure Room', 'Procedure', 'procedure'],
  ['CASH-1', 'Cash Counter 1', 'Counter 1', 'counter'],
  ['CASH-2', 'Cash Counter 2', 'Counter 2', 'counter'],
  ['REG-1', 'Registration Desk 1', 'Reg 1', 'counter'],
  ['SAMPLE-1', 'Sample Collection', 'Sample', 'sample_collection'],
  ['WAIT-A', 'Outpatient Waiting Hall A', 'Waiting A', 'waiting'],
];

async function seedRooms(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const rows: SeedRow[] = [];
  for (const h of tenancy.hospitals) {
    for (const b of h.branches) {
      for (const [code, name, display, kind] of ROOMS) {
        // A satellite polyclinic has no procedure room or sample point.
        if (!b.isMain && !['consult', 'counter', 'waiting'].includes(kind)) continue;
        rows.push(
          master('mdm-room', h.id, seedId('mdm-room-key', h.code, b.code, code), b.id, {
            code,
            name,
            display_name: display,
            kind,
            department_key: null,
            block: 'BLK-A',
            floor: kind === 'counter' ? 'Ground' : '1',
            capacity: 1,
            display_board_id: null,
            wheelchair_accessible: true,
          }),
        );
      }
    }
  }
  await ctx.write({ table: 'mdm.mdm_rooms', conflict: ['id'] }, rows);
}

// ── the demographic lookups a registration form is drawn from ───────────────

/**
 * OP-001 §5 and the Aadhaar Act. `retention: hash_last4` on AADHAAR is the
 * whole point of this master: it makes "never store the full number" a property
 * of the ID type that the registration service reads, rather than a rule a
 * developer has to remember. There is no ID type in this list whose retention
 * is `full` and which is also an Aadhaar.
 */
const ID_TYPES: readonly (readonly [string, string, string, string, string | null, boolean])[] = [
  ['AADHAAR', 'Aadhaar', 'government', 'hash_last4', '^[0-9]{12}$', true],
  ['PAN', 'PAN', 'government', 'last4', '^[A-Z]{5}[0-9]{4}[A-Z]$', true],
  ['PASSPORT', 'Passport', 'government', 'full', '^[A-Z][0-9]{7}$', true],
  ['VOTER', 'Voter ID (EPIC)', 'government', 'full', '^[A-Z]{3}[0-9]{7}$', true],
  ['DL', 'Driving licence', 'government', 'full', null, true],
  ['RATION', 'Ration card', 'government', 'last4', null, false],
  ['ABHA', 'ABHA number', 'government', 'full', '^[0-9]{2}-[0-9]{4}-[0-9]{4}-[0-9]{4}$', false],
  ['EMP_ID', 'Employer ID card', 'employer', 'full', null, false],
  ['INSURANCE', 'Insurance / TPA card', 'insurance', 'full', null, false],
  ['AYUSHMAN', 'Ayushman Bharat (PMJAY) card', 'scheme', 'full', null, true],
  ['FRRO', 'FRRO / visa document', 'foreign', 'full', null, true],
];

/** code, name, inverse, gender hint, guardian capable, next-of-kin capable. */
const RELATIONSHIPS: readonly (readonly [string, string, string, string | null, boolean, boolean])[] = [
  ['FATHER', 'Father', 'CHILD', 'male', true, true],
  ['MOTHER', 'Mother', 'CHILD', 'female', true, true],
  ['CHILD', 'Son / Daughter', 'PARENT', null, false, true],
  ['PARENT', 'Parent', 'CHILD', null, true, true],
  ['SPOUSE', 'Spouse', 'SPOUSE', null, false, true],
  ['BROTHER', 'Brother', 'SIBLING', 'male', false, true],
  ['SISTER', 'Sister', 'SIBLING', 'female', false, true],
  ['SIBLING', 'Sibling', 'SIBLING', null, false, true],
  ['GUARDIAN', 'Legal guardian', 'WARD', null, true, true],
  ['WARD', 'Ward', 'GUARDIAN', null, false, false],
  ['GRANDPARENT', 'Grandparent', 'GRANDCHILD', null, true, true],
  ['GRANDCHILD', 'Grandchild', 'GRANDPARENT', null, false, false],
  ['FRIEND', 'Friend', 'FRIEND', null, false, false],
  ['ATTENDANT', 'Attendant', 'ATTENDANT', null, false, false],
  ['EMPLOYER', 'Employer', 'EMPLOYEE', null, false, false],
  ['EMPLOYEE', 'Employee', 'EMPLOYER', null, false, false],
  ['SELF', 'Self', 'SELF', null, false, false],
];

const OCCUPATIONS: readonly (readonly [string, string, string | null, string | null])[] = [
  ['FARMER', 'Farmer / agricultural worker', '6111', 'pesticide'],
  ['LABOUR', 'Daily wage / construction labour', '9313', 'silica'],
  ['DRIVER', 'Driver', '8322', 'night_shift'],
  ['TEACHER', 'Teacher', '2330', null],
  ['CLERK', 'Clerical / office', '4110', null],
  ['ENGINEER', 'Engineer / IT professional', '2512', null],
  ['DOCTOR', 'Healthcare professional', '2211', 'biological'],
  ['BUSINESS', 'Self-employed / business', '5221', null],
  ['HOMEMAKER', 'Homemaker', null, null],
  ['STUDENT', 'Student', null, null],
  ['RETIRED', 'Retired', null, null],
  ['UNEMPLOYED', 'Unemployed', null, null],
  ['FACTORY', 'Factory / industrial worker', '8121', 'lead'],
  ['MINER', 'Mining worker', '8111', 'silica'],
];

const RELIGIONS: readonly (readonly [string, string, Record<string, unknown>])[] = [
  ['HINDU', 'Hindu', { vegetarianDefault: false, avoids: ['beef'] }],
  ['MUSLIM', 'Muslim', { halalRequired: true, avoids: ['pork'] }],
  ['CHRISTIAN', 'Christian', {}],
  ['SIKH', 'Sikh', { avoids: ['halal'] }],
  ['JAIN', 'Jain', { vegetarianDefault: true, avoids: ['root_vegetables', 'egg'] }],
  ['BUDDHIST', 'Buddhist', { vegetarianDefault: true }],
  ['PARSI', 'Parsi / Zoroastrian', {}],
  ['OTHER', 'Other', {}],
  ['NOT_STATED', 'Not stated', {}],
];

const TITLES: readonly (readonly [string, string, string | null, boolean])[] = [
  ['MR', 'Mr', 'male', false],
  ['MRS', 'Mrs', 'female', false],
  ['MS', 'Ms', 'female', false],
  ['DR', 'Dr', null, false],
  ['PROF', 'Prof', null, false],
  ['MASTER', 'Master', 'male', true],
  ['BABY', 'Baby', null, true],
  ['BABY_OF', 'Baby of', null, true],
  ['CAPT', 'Capt', null, false],
  ['REV', 'Rev', null, false],
];

/** `CLAUDE.md §4`: `en-IN` plus eleven. A hospital enables a subset. */
const LANGUAGES: readonly (readonly [string, string, string, string, boolean, boolean])[] = [
  ['en-IN', 'English (India)', 'English', 'Latn', false, true],
  ['hi', 'Hindi', 'हिन्दी', 'Deva', false, true],
  ['ta', 'Tamil', 'தமிழ்', 'Taml', false, true],
  ['te', 'Telugu', 'తెలుగు', 'Telu', false, false],
  ['ml', 'Malayalam', 'മലയാളം', 'Mlym', false, false],
  ['kn', 'Kannada', 'ಕನ್ನಡ', 'Knda', false, true],
  ['mr', 'Marathi', 'मराठी', 'Deva', false, false],
  ['bn', 'Bengali', 'বাংলা', 'Beng', false, false],
  ['gu', 'Gujarati', 'ગુજરાતી', 'Gujr', false, false],
  ['or', 'Odia', 'ଓଡ଼ିଆ', 'Orya', false, false],
  ['pa', 'Punjabi', 'ਪੰਜਾਬੀ', 'Guru', false, false],
  ['ar', 'Arabic', 'العربية', 'Arab', true, false],
];

const NATIONALITIES: readonly (readonly [string, string, string, string, boolean])[] = [
  ['IND', 'IN', 'Indian', '+91', false],
  ['NPL', 'NP', 'Nepali', '+977', true],
  ['BGD', 'BD', 'Bangladeshi', '+880', true],
  ['LKA', 'LK', 'Sri Lankan', '+94', true],
  ['ARE', 'AE', 'Emirati', '+971', true],
  ['OMN', 'OM', 'Omani', '+968', true],
  ['GBR', 'GB', 'British', '+44', true],
  ['USA', 'US', 'American', '+1', true],
  ['NGA', 'NG', 'Nigerian', '+234', true],
  ['KEN', 'KE', 'Kenyan', '+254', true],
  // ISO 3166-1 reserves the `ZZ`/`ZZZ` range for user assignment, which is
  // what a hospital needs for a stateless patient or an unlisted nationality.
  ['ZZZ', 'ZZ', 'Other / not listed', null as unknown as string, true],
];

const REFERRAL_SOURCES: readonly (readonly [string, string, string, boolean])[] = [
  ['SELF', 'Self / walk-in', 'self', false],
  ['DOCTOR', 'Referring doctor', 'doctor', true],
  ['CAMP', 'Health camp', 'camp', false],
  ['WEBSITE', 'Website', 'website', false],
  ['CORPORATE', 'Corporate tie-up', 'corporate', true],
  ['INSURER', 'Insurer / TPA', 'insurer', true],
  ['AMBULANCE', 'Ambulance / 108', 'ambulance', false],
  ['HOSPITAL', 'Referring hospital', 'doctor', true],
  ['ONLINE_AD', 'Online advertisement', 'other', false],
  ['WORD_OF_MOUTH', 'Word of mouth', 'other', false],
];

/** The India Post slice around the demo branches (OP-001 §9, seeded offline). */
const AREAS: readonly (readonly [string, string, string, string, string, string, boolean])[] = [
  ['560001', 'Bengaluru GPO', 'Bengaluru North', 'Bengaluru', 'Bengaluru Urban', 'Karnataka', true],
  ['560025', 'Richmond Town', 'Bengaluru South', 'Bengaluru', 'Bengaluru Urban', 'Karnataka', true],
  ['560034', 'Koramangala', 'Bengaluru South', 'Bengaluru', 'Bengaluru Urban', 'Karnataka', true],
  ['560066', 'Whitefield', 'Bengaluru East', 'Bengaluru', 'Bengaluru Urban', 'Karnataka', true],
  ['560076', 'Bannerghatta Road', 'Bengaluru South', 'Bengaluru', 'Bengaluru Urban', 'Karnataka', true],
  ['560103', 'Bellandur', 'Bengaluru East', 'Bengaluru', 'Bengaluru Urban', 'Karnataka', true],
  ['562107', 'Anekal', 'Anekal', 'Anekal', 'Bengaluru Urban', 'Karnataka', false],
  ['570001', 'Mysuru GPO', 'Mysuru', 'Mysuru', 'Mysuru', 'Karnataka', true],
  ['570008', 'Vijayanagar (Mysuru)', 'Mysuru', 'Mysuru', 'Mysuru', 'Karnataka', true],
  ['570023', 'Hebbal (Mysuru)', 'Mysuru', 'Mysuru', 'Mysuru', 'Karnataka', true],
  ['571301', 'Nanjangud', 'Nanjangud', 'Nanjangud', 'Mysuru', 'Karnataka', false],
  ['571114', 'Hunsur', 'Hunsur', 'Hunsur', 'Mysuru', 'Karnataka', false],
];

async function seedDemographicLookups(ctx: SeedContext, tenancy: SeededTenancy): Promise<void> {
  const idTypes: SeedRow[] = [];
  const relationships: SeedRow[] = [];
  const occupations: SeedRow[] = [];
  const religions: SeedRow[] = [];
  const titles: SeedRow[] = [];
  const languages: SeedRow[] = [];
  const nationalities: SeedRow[] = [];
  const referralSources: SeedRow[] = [];
  const areas: SeedRow[] = [];

  for (const h of tenancy.hospitals) {
    ID_TYPES.forEach(([code, name, category, retention, regex, isPhotoId], i) => {
      idTypes.push(
        master('mdm-id-type', h.id, seedId('mdm-id-type-key', h.code, code), null, {
          code,
          name,
          category,
          country_code: code === 'FRRO' ? 'ZZ' : 'IN',
          validation_regex: regex,
          retention,
          is_photo_id: isPhotoId,
          counts_as_identity: category === 'government',
          sort_order: i,
        }),
      );
    });

    RELATIONSHIPS.forEach(([code, name, inverse, genderHint, guardian, nok], i) => {
      relationships.push(
        master('mdm-relationship', h.id, seedId('mdm-relationship-key', h.code, code), null, {
          code,
          name,
          inverse_code: inverse,
          gender_hint: genderHint,
          guardian_capable: guardian,
          next_of_kin_capable: nok,
          sort_order: i,
        }),
      );
    });

    OCCUPATIONS.forEach(([code, name, nco, hazard], i) => {
      occupations.push(
        master('mdm-occupation', h.id, seedId('mdm-occupation-key', h.code, code), null, {
          code,
          name,
          nco_code: nco,
          hazard_class: hazard,
          sort_order: i,
        }),
      );
    });

    RELIGIONS.forEach(([code, name, dietary], i) => {
      religions.push(
        master('mdm-religion', h.id, seedId('mdm-religion-key', h.code, code), null, {
          code,
          name,
          dietary_defaults: jsonb(dietary),
          sort_order: i,
        }),
      );
    });

    TITLES.forEach(([code, name, genderHint, minor], i) => {
      titles.push(
        master('mdm-title', h.id, seedId('mdm-title-key', h.code, code), null, {
          code,
          name,
          gender_hint: genderHint,
          implies_minor: minor,
          sort_order: i,
        }),
      );
    });

    LANGUAGES.forEach(([code, name, nativeName, script, rtl, forDisplays], i) => {
      languages.push(
        master('mdm-language', h.id, seedId('mdm-language-key', h.code, code), null, {
          code,
          name,
          native_name: nativeName,
          script,
          is_rtl: rtl,
          tts_voice: null,
          // The demo tenant enables the three `core.hospitals.languages` lists;
          // the rest exist so an admin can switch one on without a deployment.
          used_for_patient_comms: ['en-IN', 'hi', 'kn'].includes(code),
          used_for_displays: forDisplays,
          sort_order: i,
        }),
      );
    });

    NATIONALITIES.forEach(([code, alpha2, name, calling, passport], i) => {
      nationalities.push(
        master('mdm-nationality', h.id, seedId('mdm-nationality-key', h.code, code), null, {
          code,
          alpha2,
          name,
          calling_code: calling ?? null,
          requires_passport: passport,
          sort_order: i,
        }),
      );
    });

    REFERRAL_SOURCES.forEach(([code, name, kind, requiresReferrer], i) => {
      referralSources.push(
        master('mdm-referral-source', h.id, seedId('mdm-referral-source-key', h.code, code), null, {
          code,
          name,
          kind,
          requires_referrer: requiresReferrer,
          sort_order: i,
        }),
      );
    });

    for (const [pincode, areaName, taluk, city, district, state, urban] of AREAS) {
      areas.push(
        master('mdm-area', h.id, seedId('mdm-area-key', h.code, pincode, areaName), null, {
          pincode,
          area_name: areaName,
          taluk,
          city,
          district,
          state,
          state_code: '29',
          country_code: 'IN',
          catchment_zone: city === 'Bengaluru' ? 'BLR-METRO' : 'MYS-REGION',
          is_urban: urban,
        }),
      );
    }
  }

  await ctx.write({ table: 'mdm.mdm_id_types', conflict: ['id'] }, idTypes);
  await ctx.write({ table: 'mdm.mdm_relationship_types', conflict: ['id'] }, relationships);
  await ctx.write({ table: 'mdm.mdm_occupations', conflict: ['id'] }, occupations);
  await ctx.write({ table: 'mdm.mdm_religions', conflict: ['id'] }, religions);
  await ctx.write({ table: 'mdm.mdm_titles', conflict: ['id'] }, titles);
  await ctx.write({ table: 'mdm.mdm_languages', conflict: ['id'] }, languages);
  await ctx.write({ table: 'mdm.mdm_nationalities', conflict: ['id'] }, nationalities);
  await ctx.write({ table: 'mdm.mdm_referral_sources', conflict: ['id'] }, referralSources);
  await ctx.write({ table: 'mdm.mdm_areas', conflict: ['id'] }, areas);
}
