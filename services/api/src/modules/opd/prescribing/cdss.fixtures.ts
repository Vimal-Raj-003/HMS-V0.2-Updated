import type {
  AllergyFact,
  CandidateLine,
  CrossMapEntry,
  DoseBand,
  DrugFacts,
  InteractionFact,
  LocalKnowledge,
  PatientFacts,
} from './cdss.engine.js';

/**
 * The fixtures the rule tests are written against.
 *
 * They mirror `packages/db/src/seed/clinical.ts` deliberately: the same ATC
 * codes, the same cross-sensitivity classes and the same dose bands the product
 * ships, so a unit test that passes here is testing the content a hospital will
 * actually run with rather than a convenient invention.
 */

export function drug(overrides: Partial<DrugFacts> = {}): DrugFacts {
  return {
    drugKey: null,
    genericName: 'Amoxicillin',
    brandName: null,
    atcCode: 'J01CA04',
    molecules: ['Amoxicillin'],
    route: 'oral',
    schedule: 'h',
    pregnancyCategory: 'b',
    isWeightBased: false,
    beersListed: false,
    ...overrides,
  };
}

export function line(overrides: Partial<CandidateLine> = {}): CandidateLine {
  return {
    lineNo: 1,
    drug: drug(),
    doseQty: 500,
    doseUnit: 'mg',
    doseBasis: 'flat',
    timesPerDay: 3,
    durationDays: 5,
    isPrn: false,
    ...overrides,
  };
}

export function allergy(overrides: Partial<AllergyFact> = {}): AllergyFact {
  return {
    allergyId: '11111111-1111-7111-8111-111111111111',
    category: 'drug',
    substanceCode: 'J01CA04',
    substanceText: 'Amoxicillin',
    criticality: 'high',
    severity: 'critical',
    reactions: ['anaphylaxis'],
    ...overrides,
  };
}

export function patient(overrides: Partial<PatientFacts> = {}): PatientFacts {
  return {
    patientId: '22222222-2222-7222-8222-222222222222',
    ageYears: 35,
    allergyStatement: 'known',
    allergies: [],
    activeMedications: [],
    pregnancyConfirmed: false,
    weightKg: 70,
    bsaM2: null,
    egfr: null,
    prescriberRegistrationNo: 'KMC-12345',
    ...overrides,
  };
}

/** The shipped penicillin ↔ cephalosporin classes, verbatim from the seed. */
export const CROSS_MAP: readonly CrossMapEntry[] = [
  {
    allergenClass: 'penicillin',
    memberSubstance: 'J01C',
    memberDisplay: 'Penicillins',
    crossClasses: ['cephalosporin'],
  },
  {
    allergenClass: 'penicillin',
    memberSubstance: 'J01CA04',
    memberDisplay: 'Amoxicillin',
    crossClasses: ['cephalosporin'],
  },
  {
    allergenClass: 'cephalosporin',
    memberSubstance: 'J01DD04',
    memberDisplay: 'Ceftriaxone',
    crossClasses: ['penicillin'],
  },
  {
    allergenClass: 'nsaid',
    memberSubstance: 'M01AB05',
    memberDisplay: 'Diclofenac',
    crossClasses: ['salicylate'],
  },
  {
    allergenClass: 'salicylate',
    memberSubstance: 'B01AC06',
    memberDisplay: 'Acetylsalicylic acid',
    crossClasses: ['nsaid'],
  },
];

export const CONTRAINDICATED: readonly InteractionFact[] = [
  {
    subjectAKind: 'atc',
    subjectACode: 'C01DA02',
    subjectADisplay: 'Glyceryl trinitrate',
    subjectBKind: 'atc',
    subjectBCode: 'G04BE03',
    subjectBDisplay: 'Sildenafil',
    severity: 'contraindicated',
    managementMd: 'Do not co-prescribe. Nitrates are contraindicated within 24 hours of sildenafil.',
  },
];

export const VENDOR_PAIRS: readonly InteractionFact[] = [
  {
    subjectAKind: 'atc',
    subjectACode: 'B01AA03',
    subjectADisplay: 'Warfarin',
    subjectBKind: 'atc',
    subjectBCode: 'J01EE01',
    subjectBDisplay: 'Co-trimoxazole',
    severity: 'major',
    managementMd: 'Choose another antibacterial. If unavoidable, recheck INR within 3 days.',
  },
  {
    subjectAKind: 'atc',
    subjectACode: 'A10BA02',
    subjectADisplay: 'Metformin',
    subjectBKind: 'condition',
    subjectBCode: 'egfr_lt_30',
    subjectBDisplay: null,
    severity: 'contraindicated',
    managementMd: 'Stop metformin below eGFR 30 mL/min/1.73m2.',
  },
];

/** The paracetamol bands `phase-02` exit gate 3 fires on. */
export const DOSE_BANDS: readonly DoseBand[] = [
  {
    drugKey: 'N02BE01',
    drugKeyKind: 'atc',
    route: 'oral',
    population: 'child',
    basis: 'per_kg',
    minDose: 10,
    maxDose: 15,
    unit: 'mg/kg/dose',
    maxDaily: 60,
    absoluteCeiling: 75,
    maxCourseDays: null,
  },
  {
    drugKey: 'N02BE01',
    drugKeyKind: 'atc',
    route: 'oral',
    population: 'adult',
    basis: 'flat',
    minDose: 500,
    maxDose: 1000,
    unit: 'mg/dose',
    maxDaily: 4000,
    absoluteCeiling: 4000,
    maxCourseDays: null,
  },
];

export function knowledge(overrides: Partial<LocalKnowledge> = {}): LocalKnowledge {
  return {
    crossMap: CROSS_MAP,
    interactions: CONTRAINDICATED,
    doseBands: DOSE_BANDS,
    ...overrides,
  };
}

export const PARACETAMOL = drug({
  genericName: 'Paracetamol',
  atcCode: 'N02BE01',
  molecules: ['Paracetamol'],
  isWeightBased: true,
});

export const CEFTRIAXONE = drug({
  genericName: 'Ceftriaxone',
  atcCode: 'J01DD04',
  molecules: ['Ceftriaxone'],
  route: 'intravenous',
});

export const MORPHINE = drug({
  genericName: 'Morphine',
  atcCode: 'N02AA01',
  molecules: ['Morphine'],
  route: 'intravenous',
  schedule: 'ndps_narcotic',
});
