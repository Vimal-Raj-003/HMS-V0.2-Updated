/**
 * What the oncology console returns.
 *
 * Every number that can kill somebody is derived and appears here only: body
 * surface area, creatinine clearance, the calculated and final dose, whether an
 * absolute cap bit, the running lifetime total, and the worst CTCAE grade.
 * Nothing sends them.
 *
 * The forward view is `capFraction`, `blockedBy` and `nextCapAt` — the same
 * arithmetic the triggers refuse on, shown while there is still time to arrange
 * the cardiology opinion that is the actual way past an anthracycline ceiling.
 */

export interface OncoCaseRow {
  readonly id: string;
  readonly patientId: string;
  readonly caseNo: string;
  readonly primarySiteIcdo3: string;
  readonly morphologyIcdo3: string | null;
  readonly laterality: string;
  readonly grade: string | null;
  readonly dxDate: string;
  readonly dxBasis: string;
  readonly biomarkers: Record<string, unknown>;
  readonly tnm: Record<string, unknown>;
  readonly ecog: number | null;
  readonly intent: string;
  readonly oncologistId: string;
  readonly status: string;
  /** What this patient has had for life, and how close each is to its ceiling. */
  readonly cumulative: readonly CumulativeRow[];
  readonly worstToxicityGrade: number | null;
}

export interface CumulativeRow {
  readonly drugName: string;
  readonly drugClass: string;
  readonly totalDose: number;
  readonly unit: string;
  readonly totalPerM2: number | null;
  readonly cap: number | null;
  /** How much of the lifetime ceiling is used, 0 to 1. */
  readonly capFraction: number | null;
  /** True past four-fifths, which is when a cardiology referral has to start. */
  readonly approachingCap: boolean;
  readonly lastAt: string | null;
}

export interface RegimenRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly version: number;
  readonly status: string;
  readonly cycleLengthDays: number;
  readonly plannedCycles: number;
  readonly emetogenicity: string;
  readonly labThresholds: Record<string, unknown>;
  readonly drugs: readonly RegimenDrugRow[];
}

export interface RegimenDrugRow {
  readonly id: string;
  readonly seq: number;
  readonly drugName: string;
  readonly drugClass: string;
  readonly doseBasis: string;
  readonly doseValue: number;
  readonly unit: string;
  readonly route: string;
  readonly days: readonly number[];
  readonly bsaCap: number | null;
  readonly absoluteCap: number | null;
  readonly cumulativeCap: number | null;
  readonly vesicant: boolean;
}

export interface TreatmentPlanRow {
  readonly id: string;
  readonly caseId: string;
  readonly regimenId: string;
  readonly regimenVersion: number;
  readonly regimenName: string;
  readonly intent: string;
  readonly startDate: string;
  readonly plannedCycles: number;
  readonly heightCm: number;
  readonly weightKg: number;
  readonly bsaMethod: string;
  /** Derived. Mosteller unless the unit works in Du Bois. */
  readonly bsa: number | null;
  /** Derived by Cockcroft-Gault, and capped at 125 where Calvert uses it. */
  readonly crcl: number | null;
  readonly status: string;
  readonly signedAt: string | null;
}

export interface ChemoCycleRow {
  readonly id: string;
  readonly planId: string;
  readonly cycleNo: number;
  readonly dayNo: number;
  readonly scheduledAt: string;
  readonly status: string;
  readonly fitness: Record<string, unknown>;
  /** Derived against the regimen's own thresholds. Empty means fit. */
  readonly fitnessFailures: readonly string[];
  readonly deferredReason: string | null;
  readonly signedBy: string | null;
  readonly signedAt: string | null;
  readonly secondSignerId: string | null;
  readonly overrideReason: string | null;
  /** What stands between this cycle and a drug going in. */
  readonly blockedBy: readonly string[];
  readonly linesPending: number;
  readonly linesApproved: number;
}

export interface OrderLineRow {
  readonly id: string;
  readonly cycleId: string;
  readonly seq: number;
  readonly drugName: string;
  readonly drugClass: string;
  readonly doseBasis: string;
  readonly basisValue: number;
  /** Derived from the basis and the patient's own numbers. */
  readonly calcDose: number | null;
  readonly reductionPct: number;
  readonly reductionReason: string | null;
  readonly finalDose: number | null;
  readonly unit: string;
  /** True when an absolute ceiling bit — vincristine's two milligrams. */
  readonly capApplied: boolean;
  readonly route: string;
  readonly infusionMin: number | null;
  readonly vesicant: boolean;
  readonly cumulativeBefore: number | null;
  readonly cumulativeAfter: number | null;
  readonly pharmStatus: string;
  readonly pharmNotes: string | null;
  readonly administered: boolean;
}

export interface AdministrationRow {
  readonly id: string;
  readonly cycleId: string;
  readonly orderLineId: string;
  readonly drugName: string;
  readonly verifyNurse1Id: string;
  readonly verifyNurse2Id: string;
  readonly barcodeVerified: boolean;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly access: string;
  readonly reactions: readonly Record<string, unknown>[];
  readonly extravasation: Record<string, unknown> | null;
  readonly completed: boolean;
}

export interface ToxicityRow {
  readonly id: string;
  readonly caseId: string;
  readonly cycleId: string | null;
  readonly assessedAt: string;
  readonly source: string;
  readonly items: readonly Record<string, unknown>[];
  /** Derived: the worst grade in the list, and what it obliges. */
  readonly maxGrade: number | null;
  readonly action: string | null;
}

export interface CycleDetail {
  readonly cycle: ChemoCycleRow;
  readonly plan: TreatmentPlanRow;
  readonly lines: readonly OrderLineRow[];
  readonly administrations: readonly AdministrationRow[];
}
