/**
 * What the pain clinic returns.
 *
 * The derived facts — `mme`, `endDate`, `agreementId`, the year's steroid, and
 * the threshold flags computed from the MME — all arrive read-only. Nothing
 * here goes back out.
 */

export interface PainThresholds {
  readonly naloxoneMme: number;
  readonly secondReviewMme: number;
  readonly annualSteroidCeilingMg: number;
}

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
  readonly currentDailyMme: number | null;
  readonly aboveReviewThreshold: boolean;
  readonly agreementValidTo: string | null;
  readonly agreementDaysRemaining: number | null;
  readonly agreementMissing: boolean;
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
  readonly mme: number | null;
  readonly conversionFactorId: string | null;
  readonly daysSupply: number;
  readonly quantity: number;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly agreementId: string | null;
  readonly justification: string | null;
  readonly secondReviewerId: string | null;
  readonly secondReviewedAt: string | null;
  readonly naloxonePrescribed: boolean;
  readonly naloxoneDeclined: string | null;
  readonly prescriberId: string;
  readonly createdAt: string;
  readonly aboveNaloxoneThreshold: boolean;
  readonly aboveReviewThreshold: boolean;
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
  readonly reliefPoints: number | null;
}

export interface PainEpisodeDetail {
  readonly episode: PainEpisodeRow;
  readonly assessments: readonly PainAssessmentRow[];
  readonly agreements: readonly AgreementRow[];
  readonly opioids: readonly OpioidRow[];
  readonly interventions: readonly InterventionRow[];
}
