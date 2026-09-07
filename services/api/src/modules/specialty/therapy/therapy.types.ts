/**
 * What the therapy consoles return.
 *
 * The same asymmetry as everywhere else in Phase 8: every derived number comes
 * back and none of them goes out. `areaCm2`, `areaReductionPct`, `trajectory`,
 * a diet plan's `totals`, an episode's `closedAt` and a session count against
 * an authorisation are all read-only facts the database produced.
 */

export interface EpisodeRow {
  readonly id: string;
  readonly patientId: string;
  readonly discipline: string;
  readonly setting: string;
  readonly status: string;
  readonly diagnosisIcd10: string | null;
  readonly precautions: Record<string, unknown>;
  readonly sessionsAuthorised: number | null;
  readonly leadTherapistId: string | null;
  readonly slaDueAt: string | null;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly outcome: string | null;

  /** Counted, not stored. Attendances only — a cancelled slot used nobody's package. */
  readonly sessionsDelivered: number;
  /** Null when the course is open-ended, which is a decision rather than an absence. */
  readonly sessionsRemaining: number | null;
  /** True when the next session will be refused until somebody extends it. */
  readonly authorisationExhausted: boolean;
  readonly goalsOpen: number;
  readonly goalsTotal: number;
  /** What a discharge is currently blocked on, in the words the refusal uses. */
  readonly dischargeBlockedBy: string | null;
}

export interface AssessmentRow {
  readonly id: string;
  readonly episodeId: string;
  readonly kind: string;
  readonly findings: Record<string, unknown>;
  readonly scores: Record<string, unknown>;
  readonly impression: string | null;
  readonly therapistId: string;
  readonly signedBy: string | null;
  readonly signedAt: string | null;
  readonly createdAt: string;
}

export interface GoalRow {
  readonly id: string;
  readonly episodeId: string;
  readonly description: string;
  readonly metric: string;
  readonly baseline: string;
  readonly target: string;
  readonly targetDate: string | null;
  readonly status: string;
  readonly outcomeNote: string | null;
  readonly resolvedAt: string | null;
}

export interface PlanRow {
  readonly id: string;
  readonly episodeId: string;
  readonly assessmentId: string;
  readonly version: number;
  readonly items: readonly Record<string, unknown>[];
  readonly frequencyPerWeek: number | null;
  readonly sessionsPlanned: number | null;
  readonly status: string;
  readonly signedBy: string | null;
  readonly signedAt: string | null;
}

export interface SessionRow {
  readonly id: string;
  readonly episodeId: string;
  readonly planId: string;
  readonly seq: number;
  readonly setting: string;
  readonly status: string;
  readonly scheduledAt: string;
  readonly startedAt: string | null;
  readonly durationMin: number | null;
  readonly painPre: number | null;
  readonly painPost: number | null;
  readonly therapistId: string;
  readonly chargeIntentId: string | null;
  readonly units: number | null;
}

export interface EpisodeDetail {
  readonly episode: EpisodeRow;
  readonly assessments: readonly AssessmentRow[];
  readonly goals: readonly GoalRow[];
  readonly plans: readonly PlanRow[];
  readonly sessions: readonly SessionRow[];
}

export interface WoundRow {
  readonly id: string;
  readonly patientId: string;
  readonly episodeId: string | null;
  readonly woundNo: number;
  readonly locationText: string;
  readonly side: string;
  readonly aetiology: string;
  readonly onsetDate: string | null;
  readonly classification: Record<string, unknown>;
  readonly status: string;
  readonly hospitalAcquired: boolean;
  readonly healedAt: string | null;
  readonly healingDays: number | null;

  /** The latest measurement, so a list can be read without opening every row. */
  readonly latestAreaCm2: number | null;
  readonly latestReductionPct: number | null;
  readonly latestTrajectory: string | null;
  readonly lastAssessedAt: string | null;
  readonly weeksOpen: number | null;
  /** True once the trajectory says the current plan is not working. */
  readonly needsReview: boolean;
}

export interface WoundAssessmentRow {
  readonly id: string;
  readonly woundId: string;
  readonly assessedAt: string;
  readonly assessedBy: string;
  readonly lengthCm: number | null;
  readonly widthCm: number | null;
  readonly depthCm: number | null;
  /** All three derived from the ruler. */
  readonly areaCm2: number | null;
  readonly areaReductionPct: number | null;
  readonly trajectory: string | null;
  readonly tissuePct: Record<string, unknown>;
  readonly exudate: Record<string, unknown>;
  readonly painNrs: number | null;
  readonly probeToBone: boolean;
  readonly notes: string | null;
}

export interface WoundPhotoRow {
  readonly id: string;
  readonly woundId: string;
  readonly assessmentId: string | null;
  readonly s3Key: string;
  readonly thumbKey: string | null;
  readonly takenAt: string;
  readonly stage: string;
  readonly hasScaleMarker: boolean;
  /** Whether this photograph can be the source of a measurement. */
  readonly measurable: boolean;
}

export interface WoundDetail {
  readonly wound: WoundRow;
  readonly assessments: readonly WoundAssessmentRow[];
  readonly photos: readonly WoundPhotoRow[];
}

export interface NutritionAssessmentRow {
  readonly id: string;
  readonly patientId: string;
  readonly bmi: number | null;
  readonly bmr: number | null;
  readonly tdee: number | null;
  readonly malnutritionClass: string;
  readonly sga: string | null;
  readonly nrs2002: number | null;
  readonly pesStatement: string | null;
  readonly foodAllergies: readonly string[];
  readonly signedBy: string | null;
  readonly signedAt: string | null;
  readonly createdAt: string;
}

export interface DietPlanRow {
  readonly id: string;
  readonly patientId: string;
  readonly assessmentId: string;
  readonly name: string;
  readonly meals: readonly Record<string, unknown>[];
  /** Summed from the meals by a trigger. Never sent. */
  readonly totals: Record<string, unknown>;
  readonly kcalTarget: number | null;
  readonly restrictions: Record<string, unknown>;
  readonly costPerDay: number | null;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly status: string;
  readonly signedBy: string | null;
  readonly signedAt: string | null;
  /** How far the summed energy sits from the stated target, as a percentage. */
  readonly kcalVariancePct: number | null;
}

export interface SlpAssessmentRow {
  readonly id: string;
  readonly patientId: string;
  readonly episodeId: string;
  readonly domains: readonly string[];
  readonly kind: string;
  readonly swallow: Record<string, unknown>;
  readonly severity: string | null;
  readonly dxCodes: readonly string[];
  readonly signedBy: string | null;
  readonly signedAt: string | null;
  readonly createdAt: string;
}

export interface SwallowOrderRow {
  readonly id: string;
  readonly patientId: string;
  readonly episodeId: string;
  readonly assessmentId: string;
  readonly admissionId: string | null;
  readonly npo: boolean;
  readonly foodLevel: number | null;
  readonly fluidLevel: number | null;
  readonly strategies: Record<string, unknown>;
  readonly status: string;
  readonly effectiveFrom: string;
  readonly endedAt: string | null;
  readonly orderedBy: string;
  readonly ackKitchenAt: string | null;
  readonly ackWardAt: string | null;
  readonly changeReason: string | null;

  /** What is still outstanding, so a worklist can say so rather than show a tick. */
  readonly awaitingKitchen: boolean;
  readonly awaitingWard: boolean;
  /** True only when both have acknowledged. The tray changes here and nowhere else. */
  readonly inForce: boolean;
  /** A plain sentence for the banner on the patient's chart. */
  readonly summary: string;
}
