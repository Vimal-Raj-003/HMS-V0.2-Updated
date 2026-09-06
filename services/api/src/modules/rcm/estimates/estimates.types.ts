/** RC-008 response shapes. */

export interface TemplateLineView {
  readonly id: string;
  readonly serviceId: string | null;
  readonly description: string;
  readonly quantity: string;
  readonly perDay: boolean;
  readonly confidence: string;
}

export interface TemplateView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly specialty: string | null;
  readonly procedureCode: string | null;
  readonly assumedLosDays: number;
  readonly isActive: boolean;
  readonly lineCount: number;
  readonly lines: readonly TemplateLineView[];
}

export interface EstimateLineView {
  readonly id: string;
  readonly serviceId: string | null;
  readonly description: string;
  readonly quantity: string;
  readonly unitRate: string;
  readonly amount: string;
  readonly discount: string;
  /**
   * `firm` | `capped` | `indicative` | `contingent`. A family reads a total;
   * this is what lets the desk say which parts of it could move.
   */
  readonly confidence: string;
  readonly source: string;
  readonly taxTreatment: string;
  readonly gstRate: string;
}

export interface EstimateScenarioView {
  readonly id: string;
  readonly bedClassId: string | null;
  readonly label: string;
  readonly totalPayable: string;
  readonly patientShare: string;
  /** Signed against the chosen class: negative is cheaper. */
  readonly deltaVsChosen: string;
  readonly isChosen: boolean;
}

export interface EstimateEventView {
  readonly id: string;
  readonly kind: string;
  readonly channel: string | null;
  readonly note: string | null;
  readonly at: string;
}

export interface EstimateView {
  readonly id: string;
  readonly estimateNo: string;
  readonly title: string;
  readonly patientId: string | null;
  readonly enquirerName: string | null;
  readonly procedureCode: string | null;
  readonly status: string;
  readonly losDays: number;
  readonly totalGross: string;
  readonly totalDiscount: string;
  readonly totalPayable: string;
  /** What the family will actually be asked for. */
  readonly patientShare: string;
  readonly payerShare: string;
  readonly coPayPct: string;
  readonly deductible: string;
  readonly currency: string;
  readonly validTill: string | null;
  /** Negative once it has lapsed, which is the number that matters. */
  readonly daysLeft: number | null;
  readonly issuedAt: string | null;
  readonly supersedesId: string | null;
  readonly convertedAt: string | null;
  readonly convertedEncounterId: string | null;
  readonly declineReason: string | null;
  readonly createdAt: string;
}

export interface EstimateDetailView extends EstimateView {
  readonly lines: readonly EstimateLineView[];
  readonly scenarios: readonly EstimateScenarioView[];
  readonly events: readonly EstimateEventView[];
  /** Populated once the estimate has been reconciled against a real bill. */
  readonly variance: VarianceSampleView | null;
  /**
   * Lines the desk should talk through, because they are the ones that move.
   * A total made of firm lines and a total made of indicative ones are
   * different promises even when the number is the same.
   */
  readonly softLineCount: number;
  /**
   * Lines the tariff could not price, excluding the ones deliberately marked
   * contingent. Non-zero means the estimate cannot be issued: a silent zero
   * makes the total too low, and the family finds out at discharge.
   */
  readonly unpricedLineCount: number;
}

export interface VarianceSampleView {
  readonly id: string;
  readonly estimateId: string;
  readonly estimateNo: string | null;
  readonly procedureCode: string | null;
  readonly estimatedTotal: string;
  readonly actualTotal: string;
  readonly estimatedPatientShare: string;
  readonly actualPatientShare: string;
  /** Positive means the bill exceeded the quote — the direction that hurts. */
  readonly varianceAmount: string;
  readonly variancePct: string;
  readonly estimatedLos: number;
  readonly actualLos: number | null;
  readonly explanation: string | null;
  readonly recordedAt: string;
}

/** What the samples have taught us, computed on read from the raw samples. */
export interface VarianceSummaryRow {
  readonly procedureCode: string;
  readonly sampleCount: number;
  readonly meanVariancePct: string;
  readonly medianVariancePct: string;
  readonly p90VariancePct: string;
  /** How often the bill came in above the quote at all. */
  readonly overrunRatePct: string;
  readonly worstVariancePct: string;
}
