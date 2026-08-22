/**
 * EN-029 — the deterministic rules engine, as a pure function.
 *
 * Everything in this file is arithmetic and set membership over data the caller
 * has already loaded. There is no database handle, no clock, no logger and no
 * network call, for three reasons that all matter to patient safety:
 *
 *  1. **It cannot fail for an infrastructural reason.** A function that cannot
 *     do I/O cannot throw a timeout, and therefore cannot be wrapped in the
 *     `catch` that quietly lets a prescription through. Whether the inputs could
 *     be *loaded* is `CdssService`'s question, and it answers it by refusing to
 *     prescribe (see `cdss.service.ts`), never by evaluating with less.
 *  2. **It is reproducible.** EN-029 §5 requires that "given the same snapshot
 *     digest and rule version, evaluation must produce identical output", which
 *     is what makes `POST /cdss/replay` and a medico-legal review possible three
 *     years later. A pure function over a hashed snapshot is that property.
 *  3. **The floor has nothing to switch off.** `evaluateSafetyFloor` takes one
 *     parameter — the clinical facts. It has no options argument, no feature
 *     flag, no tenant, no rule set and no tuning, so there is no value a caller
 *     could pass that makes it return fewer alerts. That mirrors, in the type
 *     system, what `clinical.cdss_safety_floor` does in the schema: the way to
 *     prove no configuration can disable the allergy hard stop is to leave no
 *     configuration to write. `phase-02` exit gate 2 is a test over this shape.
 *
 * Tunable families go through `evaluateTunable`, which does take tuning — and
 * which the type system keeps away from floor alerts, because it never sees one.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The vocabulary. These string unions mirror the PostgreSQL enums exactly
// (`clinical."CdssFamily"`, `"CdssInterruption"`, `"CdssSeverity"`); the SQL in
// `cdss.service.ts` casts to them, so a divergence is a failed insert, loudly,
// rather than a mis-filed alert.
// ─────────────────────────────────────────────────────────────────────────────

export type CdssFamily =
  | 'allergy'
  | 'ddi'
  | 'drug_disease'
  | 'duplicate_therapy'
  | 'dose_range'
  | 'pregnancy'
  | 'geriatric'
  | 'paediatric_weight'
  | 'schedule_guardrail';

export type CdssInterruption = 'passive' | 'soft_stop' | 'hard_stop' | 'shadow';

export type CdssSeverity = 'info' | 'low' | 'moderate' | 'major' | 'contraindicated';

export type CdssPopulation =
  | 'neonate'
  | 'infant'
  | 'child'
  | 'adolescent'
  | 'adult'
  | 'geriatric'
  | 'pregnancy'
  | 'lactation'
  | 'dialysis';

export type DoseBasis = 'flat' | 'per_kg' | 'per_m2';

export type DrugSchedule = 'otc' | 'g' | 'h' | 'h1' | 'x' | 'ndps_narcotic' | 'ndps_psychotropic';

export type PregnancyCategory = 'a' | 'b' | 'c' | 'd' | 'x' | 'unknown';

/**
 * The six product-level floor entries seeded into `clinical.cdss_safety_floor`.
 *
 * The keys are repeated here because the engine names them when it fires; the
 * *rows* remain the authority, and `CdssService` refuses to evaluate if the
 * table does not carry all six (a floor that has lost a row is not a floor).
 */
export const FLOOR_KEY = {
  allergy: 'allergy_documented_anaphylaxis',
  interaction: 'interaction_contraindicated',
  pregnancyX: 'pregnancy_category_x',
  ndpsCap: 'ndps_statutory_cap',
  paediatricWeight: 'paediatric_missing_weight',
  doseCeiling: 'dose_above_absolute_ceiling',
} as const;

export type FloorKey = (typeof FLOOR_KEY)[keyof typeof FLOOR_KEY];

export const FLOOR_KEYS: readonly FloorKey[] = Object.freeze(Object.values(FLOOR_KEY));

/**
 * D-9, mirrored from the CHECK constraint `prescriptions_degraded_excludes_floor`.
 *
 * These four families evaluate entirely against locally-held rows — the
 * patient's own allergy list, the shipped cross-sensitivity map, the encounter's
 * dosing weight, the drug master's schedule and pregnancy category — so there is
 * no failure mode in which a *vendor* outage leaves them un-evaluated. The
 * database refuses to store a prescription that claims otherwise; this constant
 * is how the service knows never to try.
 */
export const NEVER_DEGRADING_FAMILIES: readonly CdssFamily[] = Object.freeze([
  'allergy',
  'paediatric_weight',
  'pregnancy',
  'schedule_guardrail',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────

/** One row of `patient.allergies`, reduced to what a rule reads. */
export interface AllergyFact {
  readonly allergyId: string;
  /** `drug`, `food`, `latex`… Only drug/biologic allergies gate a prescription. */
  readonly category: string;
  /** ATC or SNOMED code, when the desk coded it. Often null, and that is legal. */
  readonly substanceCode: string | null;
  readonly substanceText: string;
  readonly criticality: 'low' | 'high' | 'unable_to_assess';
  readonly severity: 'info' | 'low' | 'moderate' | 'high' | 'critical';
  readonly reactions: readonly string[];
}

/** A drug the patient is already on: another Rx line, an IP order, a home med. */
export interface MedicationFact {
  readonly display: string;
  readonly atcCode: string | null;
  /** `rx`, `patient_reported`, `reconciled`, or `this_prescription`. */
  readonly source: string;
}

/** The `mdm_drugs` facts a rule reads, snapshotted at evaluation time. */
export interface DrugFacts {
  readonly drugKey: string | null;
  readonly genericName: string;
  readonly brandName: string | null;
  readonly atcCode: string | null;
  readonly molecules: readonly string[];
  readonly route: string | null;
  readonly schedule: DrugSchedule;
  readonly pregnancyCategory: PregnancyCategory;
  readonly isWeightBased: boolean;
  readonly beersListed: boolean;
}

/** A candidate prescription line, before it is persisted. */
export interface CandidateLine {
  readonly lineNo: number;
  readonly drug: DrugFacts;
  readonly doseQty: number | null;
  readonly doseUnit: string | null;
  readonly doseBasis: DoseBasis;
  /** Resolved from `mdm_dose_frequencies.times_per_day`. Null for PRN. */
  readonly timesPerDay: number | null;
  readonly durationDays: number | null;
  readonly isPrn: boolean;
}

/** The evaluation context: the patient, as EN-029 §3.2 step 2 assembles it. */
export interface PatientFacts {
  readonly patientId: string;
  /** Null only when the record carries no date of birth, which registration forbids. */
  readonly ageYears: number | null;
  /** `docs/06` §10's four-arm statement, so "no rows" is never read as "no allergies". */
  readonly allergyStatement: 'not_recorded' | 'none_known' | 'known' | 'unable_to_assess';
  readonly allergies: readonly AllergyFact[];
  readonly activeMedications: readonly MedicationFact[];
  /** Confirmed pregnancy. `possible` and `unknown` are not confirmations. */
  readonly pregnancyConfirmed: boolean;
  readonly weightKg: number | null;
  readonly bsaM2: number | null;
  readonly egfr: number | null;
  /** The prescriber's registration number, snapshotted onto the Rx at signing. */
  readonly prescriberRegistrationNo: string | null;
}

/** One `clinical.cdss_allergy_cross_map` row. */
export interface CrossMapEntry {
  readonly allergenClass: string;
  readonly memberSubstance: string;
  readonly memberDisplay: string | null;
  readonly crossClasses: readonly string[];
}

/** One `clinical.cdss_kb_interactions` row. */
export interface InteractionFact {
  readonly subjectAKind: string;
  readonly subjectACode: string;
  readonly subjectADisplay: string | null;
  readonly subjectBKind: string;
  readonly subjectBCode: string;
  readonly subjectBDisplay: string | null;
  readonly severity: CdssSeverity;
  readonly managementMd: string | null;
}

/** One `clinical.cdss_kb_dose_rules` row. */
export interface DoseBand {
  readonly drugKey: string;
  readonly drugKeyKind: string;
  readonly route: string | null;
  readonly population: CdssPopulation;
  readonly basis: DoseBasis;
  readonly minDose: number | null;
  readonly maxDose: number | null;
  readonly unit: string;
  readonly maxDaily: number | null;
  readonly absoluteCeiling: number | null;
  readonly maxCourseDays: number | null;
}

/**
 * The locally-held knowledge the floor evaluates against.
 *
 * "Local" is D-9's distinction, not a deployment detail: every one of these is
 * either the patient's own record or content the product ships in the
 * `local_formulary` knowledge-base release, so none of it can be taken away by a
 * vendor licence lapsing or a remote service being unreachable.
 */
export interface LocalKnowledge {
  readonly crossMap: readonly CrossMapEntry[];
  /**
   * The interaction pairs the shipped `local_formulary` release carries.
   *
   * D-9's distinction is about *which tier of them the floor reads*, not about
   * which rows are present: `interactionFloor` hard-stops only the
   * contraindicated tier — the small, stable, well-agreed core that the offline
   * subset carries — while the major and moderate pairs in the same release feed
   * the tunable families. The wider grading and management text a licensed
   * vendor adds arrive separately, and only those may degrade.
   */
  readonly interactions: readonly InteractionFact[];
  readonly doseBands: readonly DoseBand[];
}

/** The wider, vendor-dependent content. Absent means "less detail", never "skip". */
export interface VendorKnowledge {
  readonly interactions: readonly InteractionFact[];
}

export interface FloorInput {
  readonly patient: PatientFacts;
  readonly lines: readonly CandidateLine[];
  readonly knowledge: LocalKnowledge;
}

export interface TunableInput {
  readonly patient: PatientFacts;
  readonly lines: readonly CandidateLine[];
  readonly knowledge: LocalKnowledge;
  readonly vendor: VendorKnowledge;
}

/**
 * What a tenant may tune.
 *
 * Every field here is applied by `applyTuning`, which is only ever called on
 * alerts produced by `evaluateTunable`. A floor alert never passes through it —
 * not because a branch says so, but because `evaluateSafetyFloor` has no tuning
 * parameter to be given in the first place.
 */
export interface CdssTuning {
  /** Per-family interruption override, from the tenant's published rule versions. */
  readonly familyInterruption: Readonly<Partial<Record<CdssFamily, CdssInterruption>>>;
  /** Families the tenant has disabled outright (EN-029 §3.4.5). */
  readonly disabledFamilies: readonly CdssFamily[];
  /** EN-029 §3.8: an open emergency window renders soft stops passive. */
  readonly emergencyModeOpen: boolean;
}

export const NO_TUNING: CdssTuning = Object.freeze({
  familyInterruption: Object.freeze({}),
  disabledFamilies: Object.freeze([]),
  emergencyModeOpen: false,
});

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────

export interface CdssAlert {
  readonly lineNo: number;
  readonly family: CdssFamily;
  readonly severity: CdssSeverity;
  readonly interruption: CdssInterruption;
  /** Non-null exactly when this alert is a product floor entry. */
  readonly floorKey: FloorKey | null;
  /** Short, non-PHI: it is stored on `cdss_alert_events.title` and reported on. */
  readonly title: string;
  readonly detail: string;
  /** At least one constructive action — EN-029 §5's last bullet. */
  readonly suggestedAction: string;
  /** Stable within (patient, floor/family, line): the clearance key for a countersign. */
  readonly subjectCode: string;
  readonly evidence: Readonly<Record<string, string | number | boolean | null>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * ATC containment: `J01C` (the penicillin class) contains `J01CA04`
 * (amoxicillin), and a code always contains itself.
 *
 * A three-character minimum keeps `J` from matching the whole anti-infective
 * chapter — a class-level allergy that broad is not a code, it is a mistake, and
 * treating it as one would fire on hundreds of unrelated molecules.
 */
export function atcContains(broader: string | null, narrower: string | null): boolean {
  if (broader === null || narrower === null) return false;
  const b = broader.trim().toUpperCase();
  const n = narrower.trim().toUpperCase();
  if (b.length < 3 || n.length < 3) return false;
  return n === b || n.startsWith(b);
}

/** Every string that identifies this drug to a matcher. */
function drugTokens(drug: DrugFacts): readonly string[] {
  return [drug.genericName, ...drug.molecules].map(norm).filter((t) => t.length > 2);
}

function textMatchesDrug(text: string, drug: DrugFacts): boolean {
  const needle = norm(text);
  if (needle.length < 3) return false;
  return drugTokens(drug).some((token) => token === needle || token.includes(needle));
}

/** The populations a dose band may be read from, most specific first. */
export function populationChain(ageYears: number | null): readonly CdssPopulation[] {
  if (ageYears === null) return ['adult'];
  if (ageYears < 1 / 12) return ['neonate', 'infant', 'child'];
  if (ageYears < 1) return ['infant', 'child'];
  if (ageYears < 12) return ['child'];
  if (ageYears < 18) return ['adolescent', 'child'];
  if (ageYears < 65) return ['adult'];
  return ['geriatric', 'adult'];
}

function selectBand(
  bands: readonly DoseBand[],
  line: CandidateLine,
  ageYears: number | null,
): DoseBand | null {
  const candidates = bands.filter(
    (band) =>
      atcContains(band.drugKey, line.drug.atcCode) &&
      (band.route === null || line.drug.route === null || band.route === line.drug.route),
  );
  for (const population of populationChain(ageYears)) {
    const match = candidates.find((band) => band.population === population);
    if (match !== undefined) return match;
  }
  return null;
}

/** `mg/kg/day` and `mg/day` express a daily figure; `mg/kg/dose` a single dose. */
function bandIsDaily(band: DoseBand): boolean {
  return band.unit.trim().toLowerCase().endsWith('/day');
}

interface DoseArithmetic {
  /** The per-administration amount, in the band's unit. */
  readonly perDose: number;
  /** The 24-hour total, in the band's unit family. */
  readonly daily: number;
}

/**
 * Puts the prescribed dose into the band's units, or returns null when it cannot
 * be done honestly.
 *
 * Null is never "assume it is fine": the callers treat it as "this band could
 * not be applied", and the paediatric-weight floor has already blocked the one
 * case where the missing input is a weight for a weight-dosed child.
 */
function doseIn(band: DoseBand, line: CandidateLine, weightKg: number | null): DoseArithmetic | null {
  const qty = line.doseQty;
  const perDay = line.timesPerDay;
  if (qty === null || qty <= 0 || perDay === null || perDay <= 0) return null;

  const bandPerKg = band.unit.toLowerCase().includes('/kg');
  let perDose: number;
  if (bandPerKg) {
    if (line.doseBasis === 'per_kg') {
      perDose = qty;
    } else if (weightKg !== null && weightKg > 0) {
      perDose = qty / weightKg;
    } else {
      return null;
    }
  } else if (line.doseBasis === 'per_kg') {
    if (weightKg === null || weightKg <= 0) return null;
    perDose = qty * weightKg;
  } else {
    perDose = qty;
  }

  return { perDose, daily: perDose * perDay };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// The safety floor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The product-level hard stops that no configuration can remove
 * (`docs/04` §7, EN-029 §5, D-9, `phase-02` exit gate 2).
 *
 * **Read the signature.** One parameter, and it carries clinical facts only.
 * There is no options object, no tuning, no rule set, no tenant id and no
 * feature flag — so there is no argument a caller can supply, and no row an
 * administrator can write, that makes this function return fewer alerts. That is
 * the same guarantee `clinical.cdss_safety_floor` gives by having no `active`
 * column, expressed where the code can be read.
 *
 * It is also **called first and unconditionally** by `CdssService`, outside every
 * `try`, so a knowledge-base failure cannot preempt it: the allergy and
 * paediatric-weight arms read only the patient's own record and the shipped
 * cross-sensitivity map.
 */
export function evaluateSafetyFloor(input: FloorInput): readonly CdssAlert[] {
  const alerts: CdssAlert[] = [];
  for (const line of input.lines) {
    alerts.push(...allergyFloor(input.patient, line, input.knowledge.crossMap));
    alerts.push(...paediatricWeightFloor(input.patient, line));
    alerts.push(...pregnancyFloor(input.patient, line));
    alerts.push(...interactionFloor(input.patient, line, input.lines, input.knowledge));
    alerts.push(...doseCeilingFloor(input.patient, line, input.knowledge));
    alerts.push(...scheduleFloor(input.patient, line, input.knowledge));
  }
  return alerts;
}

/**
 * Floor 1 — a documented allergy to the substance, its class, or a
 * cross-reactive class.
 *
 * Two things about this are deliberate. It matches on the **coded** substance
 * (ATC, hierarchically) *and* on the free text a busy desk typed, because
 * `patient.allergies.substance_code` is nullable by design and an uncoded
 * "PENICILLIN" is still a documented allergy. And it consults
 * `cdss_allergy_cross_map` both ways: from the patient's allergy to its class,
 * and from that class's cross-reactive classes to their members — which is what
 * turns a penicillin allergy into a stop on a cephalosporin.
 */
function allergyFloor(
  patient: PatientFacts,
  line: CandidateLine,
  crossMap: readonly CrossMapEntry[],
): readonly CdssAlert[] {
  const alerts: CdssAlert[] = [];

  for (const allergy of patient.allergies) {
    if (allergy.category === 'food' || allergy.category === 'environment') continue;

    const direct =
      atcContains(allergy.substanceCode, line.drug.atcCode) ||
      textMatchesDrug(allergy.substanceText, line.drug);

    const crossClass = direct ? null : crossReactiveClass(allergy, line.drug, crossMap);
    if (!direct && crossClass === null) continue;

    const anaphylaxis = allergy.reactions.some((r) => norm(r).includes('anaphyla'));
    const documented = allergy.criticality === 'high' || allergy.severity === 'critical' || anaphylaxis;

    if (documented) {
      alerts.push({
        lineNo: line.lineNo,
        family: 'allergy',
        severity: 'contraindicated',
        interruption: 'hard_stop',
        floorKey: FLOOR_KEY.allergy,
        title: direct
          ? `Documented allergy to ${line.drug.genericName}`
          : `Cross-sensitivity: documented ${crossClass ?? ''} allergy`.trim(),
        detail: direct
          ? `The patient has an active, high-criticality allergy recorded to "${allergy.substanceText}", which matches this drug.`
          : `The patient has an active, high-criticality allergy recorded to "${allergy.substanceText}". ` +
            `${line.drug.genericName} is cross-reactive with it through the ${crossClass ?? 'recorded'} class.`,
        suggestedAction: 'Prescribe a drug from an unrelated class, or obtain a consultant countersignature.',
        subjectCode: line.drug.atcCode ?? norm(line.drug.genericName),
        evidence: {
          allergyId: allergy.allergyId,
          substance: allergy.substanceText,
          criticality: allergy.criticality,
          anaphylaxis,
          match: direct ? 'substance' : 'cross_class',
          crossClass: crossClass,
        },
      });
      continue;
    }

    // An intolerance is not the floor. It still interrupts, because the
    // prescriber must see it — it simply admits an ordinary coded override.
    alerts.push({
      lineNo: line.lineNo,
      family: 'allergy',
      severity: 'moderate',
      interruption: 'soft_stop',
      floorKey: null,
      title: `Recorded intolerance to ${allergy.substanceText}`,
      detail: `An allergy of ${allergy.criticality} criticality is recorded against "${allergy.substanceText}".`,
      suggestedAction: 'Confirm the reaction with the patient before prescribing.',
      subjectCode: line.drug.atcCode ?? norm(line.drug.genericName),
      evidence: { allergyId: allergy.allergyId, criticality: allergy.criticality },
    });
  }

  return alerts;
}

/** The cross-reactive class linking a recorded allergy to this drug, if any. */
function crossReactiveClass(
  allergy: AllergyFact,
  drug: DrugFacts,
  crossMap: readonly CrossMapEntry[],
): string | null {
  const allergyClasses = new Set<string>();
  for (const entry of crossMap) {
    const matchesAllergy =
      atcContains(entry.memberSubstance, allergy.substanceCode) ||
      atcContains(allergy.substanceCode, entry.memberSubstance) ||
      (entry.memberDisplay !== null && norm(entry.memberDisplay) === norm(allergy.substanceText)) ||
      norm(entry.allergenClass) === norm(allergy.substanceText);
    if (matchesAllergy) allergyClasses.add(entry.allergenClass);
  }
  if (allergyClasses.size === 0) return null;

  const reactive = new Set<string>();
  for (const entry of crossMap) {
    if (!allergyClasses.has(entry.allergenClass)) continue;
    for (const cross of entry.crossClasses) reactive.add(cross);
  }

  for (const entry of crossMap) {
    if (!reactive.has(entry.allergenClass)) continue;
    if (atcContains(entry.memberSubstance, drug.atcCode) || textMatchesDrug(entry.memberSubstance, drug)) {
      return entry.allergenClass;
    }
  }
  return null;
}

/**
 * Floor 2 — a weight-based dose for a patient under 18 with no recorded weight.
 *
 * EN-029 §3.8: "safer to block than to guess". The database says the same thing
 * with `prescription_items_weight_required_per_kg`, so this alert exists to make
 * the refusal *readable* — a clinician told "check constraint violated" learns
 * nothing, and the constraint is what catches the offline replay this service
 * never sees.
 */
function paediatricWeightFloor(patient: PatientFacts, line: CandidateLine): readonly CdssAlert[] {
  const weightBased = line.doseBasis === 'per_kg' || line.drug.isWeightBased;
  if (!weightBased) return [];
  if (patient.ageYears !== null && patient.ageYears >= 18) return [];
  if (patient.weightKg !== null && patient.weightKg > 0) return [];

  return [
    {
      lineNo: line.lineNo,
      family: 'paediatric_weight',
      severity: 'contraindicated',
      interruption: 'hard_stop',
      floorKey: FLOOR_KEY.paediatricWeight,
      title: `${line.drug.genericName} is weight-dosed and no weight is recorded`,
      detail:
        'This drug is dosed by body weight and the encounter carries no measured weight, ' +
        'so the dose cannot be computed or checked.',
      suggestedAction: 'Record the weight in the vitals room, then prescribe.',
      subjectCode: line.drug.atcCode ?? norm(line.drug.genericName),
      evidence: {
        ageYears: patient.ageYears,
        doseBasis: line.doseBasis,
        weightBased: line.drug.isWeightBased,
      },
    },
  ];
}

/** Floor 3 — pregnancy category X in a confirmed pregnancy. */
function pregnancyFloor(patient: PatientFacts, line: CandidateLine): readonly CdssAlert[] {
  if (!patient.pregnancyConfirmed) return [];
  if (line.drug.pregnancyCategory === 'x') {
    return [
      {
        lineNo: line.lineNo,
        family: 'pregnancy',
        severity: 'contraindicated',
        interruption: 'hard_stop',
        floorKey: FLOOR_KEY.pregnancyX,
        title: `${line.drug.genericName} is pregnancy category X`,
        detail: 'The pregnancy is confirmed and this drug is category X: the risk outweighs any benefit.',
        suggestedAction: 'Choose a category A or B alternative.',
        subjectCode: line.drug.atcCode ?? norm(line.drug.genericName),
        evidence: { pregnancyCategory: 'x' },
      },
    ];
  }
  if (line.drug.pregnancyCategory === 'd') {
    return [
      {
        lineNo: line.lineNo,
        family: 'pregnancy',
        severity: 'major',
        interruption: 'soft_stop',
        floorKey: null,
        title: `${line.drug.genericName} is pregnancy category D`,
        detail: 'There is positive evidence of human foetal risk; use only if the benefit is clear.',
        suggestedAction: 'Document the indication, or choose a safer alternative.',
        subjectCode: line.drug.atcCode ?? norm(line.drug.genericName),
        evidence: { pregnancyCategory: 'd' },
      },
    ];
  }
  return [];
}

/**
 * Floor 4 — a contraindicated interaction pair.
 *
 * The counterparts are the other lines of the same prescription *and* the
 * patient's active medication list, because a pair split across two
 * prescriptions is the same pair.
 */
function interactionFloor(
  patient: PatientFacts,
  line: CandidateLine,
  allLines: readonly CandidateLine[],
  knowledge: LocalKnowledge,
): readonly CdssAlert[] {
  const alerts: CdssAlert[] = [];
  for (const counterpart of counterpartsFor(line, allLines, patient)) {
    const pair = findPair(knowledge.interactions, line.drug.atcCode, counterpart.atcCode);
    if (pair === null || pair.severity !== 'contraindicated') continue;
    alerts.push({
      lineNo: line.lineNo,
      family: 'ddi',
      severity: 'contraindicated',
      interruption: 'hard_stop',
      floorKey: FLOOR_KEY.interaction,
      title: `Contraindicated with ${counterpart.display}`,
      detail: pair.managementMd ?? 'This pair is graded contraindicated and must not be co-prescribed.',
      suggestedAction: 'Stop or replace one of the two drugs.',
      subjectCode: `${line.drug.atcCode ?? norm(line.drug.genericName)}|${counterpart.atcCode ?? norm(counterpart.display)}`,
      evidence: { counterpart: counterpart.display, source: counterpart.source, severity: pair.severity },
    });
  }
  return alerts;
}

/**
 * Floor 5 — more than 200 % of the absolute ceiling.
 *
 * `docs/04` §7 puts the line at twice the ceiling because that is no longer a
 * dosing decision: it is the decimal point in the wrong place. The band comes
 * from `cdss_kb_dose_rules`, which the shipped local formulary populates, so the
 * check survives a vendor licence lapsing.
 */
function doseCeilingFloor(
  patient: PatientFacts,
  line: CandidateLine,
  knowledge: LocalKnowledge,
): readonly CdssAlert[] {
  const band = selectBand(knowledge.doseBands, line, patient.ageYears);
  if (band === null || band.absoluteCeiling === null) return [];
  const dose = doseIn(band, line, patient.weightKg);
  if (dose === null) return [];

  // The ceiling is always a 24-hour figure (`mg/day`, `mg/kg/day`), whatever the
  // band's own unit expresses, so the comparison is against the daily total.
  const observed = dose.daily;
  const ceiling = band.absoluteCeiling;
  if (observed <= ceiling * 2) return [];

  return [
    {
      lineNo: line.lineNo,
      family: 'dose_range',
      severity: 'contraindicated',
      interruption: 'hard_stop',
      floorKey: FLOOR_KEY.doseCeiling,
      title: `Dose is ${Math.round((observed / ceiling) * 100)} % of the absolute ceiling`,
      detail:
        `The prescribed regimen works out at ${round(observed)} ${dailyUnit(band)}, against an absolute ` +
        `ceiling of ${ceiling} ${dailyUnit(band)} for this drug, route and age band.`,
      suggestedAction: 'Check the dose and the units — this is an order of magnitude above the ceiling.',
      subjectCode: line.drug.atcCode ?? norm(line.drug.genericName),
      evidence: {
        observedDaily: round(observed),
        absoluteCeiling: ceiling,
        unit: dailyUnit(band),
        population: band.population,
      },
    },
  ];
}

function dailyUnit(band: DoseBand): string {
  return bandIsDaily(band) ? band.unit : band.unit.replace(/\/dose$/i, '/day');
}

/**
 * Floor 6 — Schedule X / NDPS statutory guardrails.
 *
 * Three refusals, and the third is the uncomfortable one.
 *
 *  1. No prescriber registration number → blocked. A narcotic prescription
 *     without the prescriber's registration is not a valid prescription.
 *  2. Duration beyond the statutory cap → blocked. A statutory cap is not a
 *     clinical judgement a hospital may tune.
 *  3. **No cap configured for the drug → also blocked.** The NDPS quantity and
 *     duration limits are statute, and they are not in `docs/`; inventing "7
 *     days" here would be exactly the guessing `CLAUDE.md` §0.1 forbids, and
 *     defaulting to "no cap" would silently delete the floor. So the engine
 *     refuses and names the missing configuration
 *     (`cdss_kb_dose_rules.max_course_days`). The shipped local formulary does
 *     not carry these caps yet — see this module's README note — so Schedule X
 *     and NDPS prescribing is blocked until EN-027 loads them. That is a
 *     configuration task with a clear message, which is the safe direction.
 */
function scheduleFloor(
  patient: PatientFacts,
  line: CandidateLine,
  knowledge: LocalKnowledge,
): readonly CdssAlert[] {
  const controlled = line.drug.schedule === 'x' || line.drug.schedule.startsWith('ndps');
  if (!controlled) return [];

  const alerts: CdssAlert[] = [];
  const subject = line.drug.atcCode ?? norm(line.drug.genericName);

  if (patient.prescriberRegistrationNo === null || patient.prescriberRegistrationNo.trim().length === 0) {
    alerts.push({
      lineNo: line.lineNo,
      family: 'schedule_guardrail',
      severity: 'contraindicated',
      interruption: 'hard_stop',
      floorKey: FLOOR_KEY.ndpsCap,
      title: `${line.drug.genericName} is a controlled drug and the prescriber has no registration number`,
      detail:
        'A Schedule X / NDPS prescription must carry the prescriber’s registration number; ' +
        'this user profile has none recorded.',
      suggestedAction: 'Record the registration number on the prescriber’s profile.',
      subjectCode: subject,
      evidence: { schedule: line.drug.schedule, reason: 'missing_registration' },
    });
  }

  const band = selectBand(knowledge.doseBands, line, patient.ageYears);
  const cap = band?.maxCourseDays ?? null;
  if (cap === null) {
    alerts.push({
      lineNo: line.lineNo,
      family: 'schedule_guardrail',
      severity: 'contraindicated',
      interruption: 'hard_stop',
      floorKey: FLOOR_KEY.ndpsCap,
      title: `No statutory cap is configured for ${line.drug.genericName}`,
      detail:
        'The NDPS quantity and duration cap for this drug is not present in the knowledge base, so the ' +
        'statutory guardrail cannot be evaluated. A controlled drug is not prescribed on an unchecked cap.',
      suggestedAction: 'Ask the pharmacy to load the statutory cap (max course days) for this drug.',
      subjectCode: subject,
      evidence: { schedule: line.drug.schedule, reason: 'cap_not_configured' },
    });
  } else if (line.durationDays !== null && line.durationDays > cap) {
    alerts.push({
      lineNo: line.lineNo,
      family: 'schedule_guardrail',
      severity: 'contraindicated',
      interruption: 'hard_stop',
      floorKey: FLOOR_KEY.ndpsCap,
      title: `${line.durationDays} days exceeds the ${cap}-day statutory cap`,
      detail: `The statutory maximum course for ${line.drug.genericName} is ${cap} days.`,
      suggestedAction: `Reduce the duration to ${cap} days or fewer.`,
      subjectCode: subject,
      evidence: { schedule: line.drug.schedule, durationDays: line.durationDays, capDays: cap },
    });
  }

  return alerts;
}

// ─────────────────────────────────────────────────────────────────────────────
// The tunable families
// ─────────────────────────────────────────────────────────────────────────────

interface Counterpart {
  readonly display: string;
  readonly atcCode: string | null;
  readonly source: string;
}

function counterpartsFor(
  line: CandidateLine,
  allLines: readonly CandidateLine[],
  patient: PatientFacts,
): readonly Counterpart[] {
  const fromLines = allLines
    .filter((other) => other.lineNo !== line.lineNo)
    .map<Counterpart>((other) => ({
      display: other.drug.genericName,
      atcCode: other.drug.atcCode,
      source: 'this_prescription',
    }));
  const fromList = patient.activeMedications.map<Counterpart>((med) => ({
    display: med.display,
    atcCode: med.atcCode,
    source: med.source,
  }));
  return [...fromLines, ...fromList];
}

const SEVERITY_ORDER: readonly CdssSeverity[] = ['info', 'low', 'moderate', 'major', 'contraindicated'];

/**
 * The interaction between two drugs, at the **highest** severity any loaded
 * release grades it.
 *
 * Taking the first match would make the answer depend on the order rows came
 * back in — so a local `major` row could mask a vendor `contraindicated` one and
 * silently turn a hard stop into a warning. EN-029 §3.8 already says the higher
 * severity wins where rules disagree; this is the same rule for facts.
 */
function findPair(
  pairs: readonly InteractionFact[],
  a: string | null,
  b: string | null,
): InteractionFact | null {
  if (a === null || b === null) return null;
  let best: InteractionFact | null = null;
  for (const pair of pairs) {
    if (pair.subjectAKind === 'condition' || pair.subjectBKind === 'condition') continue;
    const forward = atcContains(pair.subjectACode, a) && atcContains(pair.subjectBCode, b);
    const reverse = atcContains(pair.subjectACode, b) && atcContains(pair.subjectBCode, a);
    if (!forward && !reverse) continue;
    if (best === null || SEVERITY_ORDER.indexOf(pair.severity) > SEVERITY_ORDER.indexOf(best.severity)) {
      best = pair;
    }
  }
  return best;
}

/**
 * The families a hospital may tune: interaction grading above the contraindicated
 * tier, duplicate therapy, dose bands, drug–disease and the Beers cautions.
 *
 * Every alert this returns carries `floorKey: null`, and `applyTuning` asserts
 * it — so a future edit that moved a floor check in here would fail its own
 * invariant rather than quietly become configurable.
 */
export function evaluateTunable(input: TunableInput, tuning: CdssTuning): readonly CdssAlert[] {
  const raw: CdssAlert[] = [];
  const interactions = [...input.knowledge.interactions, ...input.vendor.interactions];

  for (const line of input.lines) {
    // Interaction grading below contraindicated.
    for (const counterpart of counterpartsFor(line, input.lines, input.patient)) {
      const pair = findPair(interactions, line.drug.atcCode, counterpart.atcCode);
      if (pair === null || pair.severity === 'contraindicated') continue;
      const interruption: CdssInterruption =
        pair.severity === 'major' ? 'soft_stop' : pair.severity === 'moderate' ? 'passive' : 'shadow';
      raw.push({
        lineNo: line.lineNo,
        family: 'ddi',
        severity: pair.severity,
        interruption,
        floorKey: null,
        title: `${pair.severity === 'major' ? 'Major' : 'Moderate'} interaction with ${counterpart.display}`,
        detail: pair.managementMd ?? 'Interacting pair.',
        suggestedAction: pair.managementMd ?? 'Review the pair and monitor.',
        subjectCode: `${line.drug.atcCode ?? norm(line.drug.genericName)}|${counterpart.atcCode ?? norm(counterpart.display)}`,
        evidence: { counterpart: counterpart.display, severity: pair.severity, source: counterpart.source },
      });
    }

    // Drug–disease, carried in the interaction table with a `condition` subject.
    raw.push(...drugDisease(input, line, interactions));

    // Duplicate therapy: the same molecule or the same ATC-5 chemical subgroup.
    for (const counterpart of counterpartsFor(line, input.lines, input.patient)) {
      const sameMolecule = textMatchesDrug(counterpart.display, line.drug);
      const sameClass =
        line.drug.atcCode !== null &&
        counterpart.atcCode !== null &&
        line.drug.atcCode.slice(0, 5) === counterpart.atcCode.slice(0, 5) &&
        line.drug.atcCode.length >= 5;
      if (!sameMolecule && !sameClass) continue;
      raw.push({
        lineNo: line.lineNo,
        family: 'duplicate_therapy',
        severity: 'moderate',
        interruption: 'soft_stop',
        floorKey: null,
        title: `Duplicate therapy with ${counterpart.display}`,
        detail: sameMolecule
          ? 'The same molecule is already prescribed or recorded as active.'
          : 'A drug of the same ATC chemical subgroup is already prescribed or recorded as active.',
        suggestedAction: 'Stop one of the two, or record why both are intended.',
        subjectCode: `${line.drug.atcCode ?? norm(line.drug.genericName)}|dup`,
        evidence: { counterpart: counterpart.display, basis: sameMolecule ? 'molecule' : 'atc5' },
      });
    }

    // Dose band, below the floor's ceiling.
    raw.push(...doseBandAlerts(input, line));

    // Beers: a caution, never a block.
    if (input.patient.ageYears !== null && input.patient.ageYears >= 65 && line.drug.beersListed) {
      raw.push({
        lineNo: line.lineNo,
        family: 'geriatric',
        severity: 'low',
        interruption: 'passive',
        floorKey: null,
        title: `${line.drug.genericName} is on the Beers list`,
        detail: 'Potentially inappropriate in patients aged 65 and over.',
        suggestedAction: 'Consider an alternative, or review the risk with the patient.',
        subjectCode: line.drug.atcCode ?? norm(line.drug.genericName),
        evidence: { ageYears: input.patient.ageYears },
      });
    }
  }

  if (input.patient.allergyStatement === 'not_recorded' && input.lines.length > 0) {
    raw.push({
      lineNo: input.lines[0]?.lineNo ?? 1,
      family: 'allergy',
      severity: 'info',
      interruption: 'passive',
      floorKey: null,
      title: 'No allergy status has been recorded for this patient',
      detail:
        'The allergy question has not been asked, which is not the same as "no allergies". ' +
        'The allergy check therefore has nothing to match against.',
      suggestedAction: 'Ask the patient and record the allergy status.',
      subjectCode: 'allergy_statement',
      evidence: { allergyStatement: input.patient.allergyStatement },
    });
  }

  return raw.map((alert) => applyTuning(alert, tuning)).filter((alert) => alert.interruption !== 'shadow');
}

function drugDisease(
  input: TunableInput,
  line: CandidateLine,
  interactions: readonly InteractionFact[],
): readonly CdssAlert[] {
  const alerts: CdssAlert[] = [];
  for (const pair of interactions) {
    const drugSide = pair.subjectBKind === 'condition' ? pair.subjectACode : pair.subjectBCode;
    const conditionSide = pair.subjectBKind === 'condition' ? pair.subjectBCode : pair.subjectACode;
    const isCondition = pair.subjectAKind === 'condition' || pair.subjectBKind === 'condition';
    if (!isCondition) continue;
    if (!atcContains(drugSide, line.drug.atcCode)) continue;
    if (!conditionHolds(conditionSide, input.patient)) continue;

    alerts.push({
      lineNo: line.lineNo,
      family: 'drug_disease',
      severity: pair.severity,
      interruption: 'soft_stop',
      floorKey: null,
      title: `${line.drug.genericName} against a recorded condition`,
      detail: pair.managementMd ?? `The condition "${conditionSide}" applies to this patient.`,
      suggestedAction: pair.managementMd ?? 'Review the choice against the patient’s organ function.',
      subjectCode: `${line.drug.atcCode ?? norm(line.drug.genericName)}|${conditionSide}`,
      evidence: { condition: conditionSide, egfr: input.patient.egfr },
    });
  }
  return alerts;
}

/**
 * The condition vocabulary the shipped knowledge base uses.
 *
 * Deliberately tiny and explicit: `egfr_lt_<n>` is the only shape the seeded
 * content carries, and an unrecognised condition code returns `false` rather
 * than being guessed at. An unrecognised code is a knowledge-base coverage gap
 * (EN-029 §3.5), and it is surfaced as such, not silently treated as a match.
 */
function conditionHolds(code: string, patient: PatientFacts): boolean {
  const match = /^egfr_lt_(\d+)$/.exec(code.trim().toLowerCase());
  if (match !== null) {
    const threshold = Number(match[1]);
    return patient.egfr !== null && patient.egfr < threshold;
  }
  return false;
}

function doseBandAlerts(input: TunableInput, line: CandidateLine): readonly CdssAlert[] {
  const band = selectBand(input.knowledge.doseBands, line, input.patient.ageYears);
  if (band === null) return [];
  const dose = doseIn(band, line, input.patient.weightKg);
  if (dose === null) return [];

  const observed = bandIsDaily(band) ? dose.daily : dose.perDose;
  const above = band.maxDose !== null && observed > band.maxDose;
  const below = band.minDose !== null && observed < band.minDose;
  const overDaily = band.maxDaily !== null && dose.daily > band.maxDaily;
  if (!above && !below && !overDaily) return [];

  // The floor has already fired if this is above twice the ceiling; this is the
  // ordinary out-of-band case, and it is a soft stop the hospital may tune.
  return [
    {
      lineNo: line.lineNo,
      family: 'dose_range',
      severity: above || overDaily ? 'major' : 'moderate',
      interruption: 'soft_stop',
      floorKey: null,
      title: overDaily
        ? 'Daily dose above the recommended maximum'
        : above
          ? 'Dose above the recommended range'
          : 'Dose below the recommended range',
      detail:
        `Prescribed ${round(observed)} ${band.unit} (${round(dose.daily)} ${dailyUnit(band)} in total) against a ` +
        `band of ${band.minDose ?? '—'}–${band.maxDose ?? '—'} ${band.unit}` +
        (band.maxDaily === null ? '.' : ` and a daily maximum of ${band.maxDaily} ${dailyUnit(band)}.`),
      suggestedAction: 'Adjust the dose or the frequency, or record why this regimen is intended.',
      subjectCode: line.drug.atcCode ?? norm(line.drug.genericName),
      evidence: {
        observed: round(observed),
        daily: round(dose.daily),
        minDose: band.minDose,
        maxDose: band.maxDose,
        maxDaily: band.maxDaily,
        population: band.population,
      },
    },
  ];
}

/**
 * Applies the tenant's tuning to one alert.
 *
 * The first line is the invariant: a floor alert must never reach here. It is an
 * assertion rather than a silent pass-through because "the floor was tuned away"
 * is precisely the defect this module exists to make impossible, and a defect
 * that returns a plausible value is one nobody finds.
 */
export function applyTuning(alert: CdssAlert, tuning: CdssTuning): CdssAlert {
  if (alert.floorKey !== null) {
    throw new Error(
      `CDSS: a safety-floor alert (${alert.floorKey}) reached the tuning stage. ` +
        'Floor alerts are produced by evaluateSafetyFloor and are not configurable (docs/04 §7, D-9).',
    );
  }

  if (tuning.disabledFamilies.includes(alert.family)) {
    return { ...alert, interruption: 'shadow' };
  }

  const configured = tuning.familyInterruption[alert.family];
  let interruption = configured ?? alert.interruption;

  if (tuning.emergencyModeOpen && interruption === 'soft_stop') {
    interruption = 'passive';
  }

  return { ...alert, interruption };
}

/**
 * The whole evaluation: floor first, then the tunable families.
 *
 * Order is not cosmetic. The floor runs first so that a caller which stops at
 * the first hard stop still has the un-configurable ones, and so that reading the
 * alert list top-down shows the blocking reasons before the advisory ones.
 */
export function evaluate(input: TunableInput, tuning: CdssTuning): readonly CdssAlert[] {
  const floor = evaluateSafetyFloor({
    patient: input.patient,
    lines: input.lines,
    knowledge: input.knowledge,
  });
  return [...floor, ...evaluateTunable(input, tuning)];
}

/** The alerts that stop the action outright. */
export function hardStops(alerts: readonly CdssAlert[]): readonly CdssAlert[] {
  return alerts.filter((a) => a.interruption === 'hard_stop');
}

/** The alerts that need a coded override before the action may proceed. */
export function softStops(alerts: readonly CdssAlert[]): readonly CdssAlert[] {
  return alerts.filter((a) => a.interruption === 'soft_stop');
}
