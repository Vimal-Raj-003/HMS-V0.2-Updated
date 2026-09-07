/**
 * What the pain clinic returns.
 *
 * The derived numbers are here and nowhere in a request: `mme`, `endDate`,
 * `agreementId`, the annual steroid total, and the two threshold flags computed
 * from the MME. A screen shows them; nothing sends them.
 */

export interface PainEpisodeRow {
  readonly id: string;
  readonly patientId: string;
  readonly type: string;
  readonly mechanism: string | null;
  readonly primaryDxIcd10: string | null;
  readonly sites: readonly Record<string, unknown>[];
  readonly leadPhysicianId: string;
  readonly opioidTherapy: boolean;
  readonly riskScores: Record<string, unknown>;
  readonly status: string;
  readonly openedAt: string;

  /** The sum of every live prescription on this episode, in morphine equivalents. */
  readonly currentDailyMme: number | null;
  /** True once that sum is at or above the review threshold. */
  readonly aboveReviewThreshold: boolean;
  /** The live agreement's expiry, and how long is left. */
  readonly agreementValidTo: string | null;
  readonly agreementDaysRemaining: number | null;
  /** True when there is no agreement in force and this episode needs one. */
  readonly agreementMissing: boolean;
  /** This calendar year's triamcinolone-equivalent total, and what is left of it. */
  readonly steroidMgThisYear: number;
  readonly steroidMgRemaining: number;
}

export interface PainAssessmentRow {
  readonly id: string;
  readonly episodeId: string;
  readonly kind: string;
  readonly nrsNow: number | null;
  readonly nrsAvg: number | null;
  readonly nrsWorst: number | null;
  readonly nrsLeast: number | null;
  readonly scale: string;
  readonly instruments: Record<string, unknown>;
  readonly pgic: number | null;
  readonly recordedAt: string;
  readonly recordedBy: string;
}

export interface AgreementRow {
  readonly id: string;
  readonly patientId: string;
  readonly episodeId: string;
  readonly termsVersion: string;
  readonly signedAt: string;
  readonly validTo: string;
  readonly status: string;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
  readonly daysRemaining: number | null;
  /** True while it is live but close enough to expiry to matter. */
  readonly expiringSoon: boolean;
}

export interface OpioidRow {
  readonly id: string;
  readonly patientId: string;
  readonly episodeId: string;
  readonly drugKey: string;
  readonly drugName: string;
  readonly route: string;
  readonly strength: string;
  readonly dailyDose: number;
  readonly doseUnit: string;
  /** Derived from the dose and the dated conversion factor. Never sent. */
  readonly mme: number | null;
  readonly conversionFactorId: string | null;
  readonly daysSupply: number;
  readonly quantity: number;
  readonly startDate: string;
  /** Derived: start plus the days supplied. What an overlap is measured against. */
  readonly endDate: string | null;
  readonly agreementId: string | null;
  readonly justification: string | null;
  readonly secondReviewerId: string | null;
  readonly secondReviewedAt: string | null;
  readonly naloxonePrescribed: boolean;
  readonly naloxoneDeclined: string | null;
  readonly prescriberId: string;
  readonly createdAt: string;

  /** Both computed from the stored MME, so a chip and a refusal agree. */
  readonly aboveNaloxoneThreshold: boolean;
  readonly aboveReviewThreshold: boolean;
  /** Live on the day it is read: started, and not yet run out. */
  readonly active: boolean;
}

export interface InterventionRow {
  readonly id: string;
  readonly patientId: string;
  readonly episodeId: string;
  readonly interventionCode: string;
  readonly name: string;
  readonly levels: readonly string[];
  readonly side: string;
  readonly guidance: string;
  readonly steroidMgEquiv: number | null;
  readonly nrsPre: number | null;
  readonly nrsPost30min: number | null;
  readonly outcome: string | null;
  readonly performedBy: string;
  readonly performedAt: string;
  /** Points off the numeric scale. The number a pain clinic is judged on. */
  readonly reliefPoints: number | null;
}

export interface PainEpisodeDetail {
  readonly episode: PainEpisodeRow;
  readonly assessments: readonly PainAssessmentRow[];
  readonly agreements: readonly AgreementRow[];
  readonly opioids: readonly OpioidRow[];
  readonly interventions: readonly InterventionRow[];
}

/** The thresholds, read from the database so nothing carries a second copy. */
export interface PainThresholds {
  readonly naloxoneMme: number;
  readonly secondReviewMme: number;
  readonly annualSteroidCeilingMg: number;
}
