/**
 * What the oncology console returns.
 *
 * Every number that can kill somebody is derived and appears here only: the
 * body surface area, the clearance, the calculated and final dose, whether an
 * absolute cap bit, the lifetime total. Nothing sends them, and there is no
 * route on an order line at all.
 */

export interface CumulativeRow {
  readonly drugName: string;
  readonly drugClass: string;
  readonly totalDose: number;
  readonly unit: string;
  readonly totalPerM2: number | null;
  readonly cap: number | null;
  readonly capFraction: number | null;
  readonly approachingCap: boolean;
  readonly lastAt: string | null;
}

export interface OncoCaseRow {
  readonly id: string;
  readonly patientId: string;
  readonly caseNo: string;
  readonly primarySiteIcdo3: string;
  readonly ecog: number | null;
  readonly intent: string;
  readonly status: string;
  readonly cumulative: readonly CumulativeRow[];
  readonly worstToxicityGrade: number | null;
}

export interface ChemoCycleRow {
  readonly id: string;
  readonly planId: string;
  readonly cycleNo: number;
  readonly dayNo: number;
  readonly scheduledAt: string;
  readonly status: string;
  readonly fitnessFailures: readonly string[];
  readonly signedAt: string | null;
  readonly secondSignerId: string | null;
  readonly overrideReason: string | null;
  readonly blockedBy: readonly string[];
  readonly linesPending: number;
  readonly linesApproved: number;
}

export interface OrderLineRow {
  readonly id: string;
  readonly seq: number;
  readonly drugName: string;
  readonly drugClass: string;
  readonly doseBasis: string;
  readonly basisValue: number;
  readonly calcDose: number | null;
  readonly reductionPct: number;
  readonly reductionReason: string | null;
  readonly finalDose: number | null;
  readonly unit: string;
  /** True when an absolute ceiling bit — vincristine's two milligrams. */
  readonly capApplied: boolean;
  readonly route: string;
  readonly vesicant: boolean;
  readonly cumulativeAfter: number | null;
  readonly pharmStatus: string;
  readonly pharmNotes: string | null;
  readonly administered: boolean;
}

export interface TreatmentPlanRow {
  readonly id: string;
  readonly caseId: string;
  readonly regimenName: string;
  readonly regimenVersion: number;
  readonly heightCm: number;
  readonly weightKg: number;
  readonly bsaMethod: string;
  readonly bsa: number | null;
  readonly crcl: number | null;
  readonly status: string;
}

export interface AdministrationRow {
  readonly id: string;
  readonly orderLineId: string;
  readonly drugName: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly completed: boolean;
  readonly extravasation: Record<string, unknown> | null;
}

export interface CycleDetail {
  readonly cycle: ChemoCycleRow;
  readonly plan: TreatmentPlanRow;
  readonly lines: readonly OrderLineRow[];
  readonly administrations: readonly AdministrationRow[];
}
