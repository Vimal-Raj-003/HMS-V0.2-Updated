/** TR-002 + OP-009 shapes, mirroring `services/api/.../fracture/fracture.types.ts`. */

export interface FracturePlanView {
  readonly id: string;
  readonly version: number;
  readonly intent: string;
  readonly side: string;
  readonly damageControl: boolean;
  readonly urgency: string;
  readonly plannedProcedureCode: string | null;
  readonly plannedImplantFamily: string | null;
  readonly plannedDate: string | null;
  readonly weightBearing: string;
  readonly pwbPct: number | null;
  readonly wbReviewDate: string | null;
  readonly romRestrictions: string | null;
  readonly dvtProphylaxis: boolean;
  readonly isCurrent: boolean;
  readonly setAt: string;
}

export interface FractureEventView {
  readonly id: string;
  readonly kind: string;
  readonly at: string;
  readonly byId: string | null;
  readonly refType: string | null;
  readonly refId: string | null;
  readonly details: unknown;
  /** Weeks from the injury. What makes the timeline readable at a glance. */
  readonly weeksSinceInjury: string | null;
}

export interface FractureFindingView {
  readonly id: string;
  readonly filmId: string;
  readonly assessedAt: string;
  readonly angulationDeg: string | null;
  readonly translationPct: number | null;
  readonly shorteningMm: number | null;
  readonly rustScore: number | null;
  readonly mrustScore: number | null;
  readonly alignmentMaintained: boolean | null;
  readonly implantStatus: string | null;
  readonly unionStatus: string;
  readonly notes: string | null;
}

export interface FractureFilmView {
  readonly id: string;
  readonly label: string;
  readonly takenAt: string;
  readonly studyUid: string | null;
  readonly weeksSinceInjury: string | null;
  readonly weeksSinceSurgery: string | null;
  readonly autoAttached: boolean;
  readonly isKeyImage: boolean;
  readonly findings: readonly FractureFindingView[];
}

export interface FractureComplicationView {
  readonly id: string;
  readonly kind: string;
  readonly onsetAt: string;
  readonly severity: string;
  readonly clavienDindo: string | null;
  readonly management: string | null;
  readonly resolvedAt: string | null;
}

export interface OpenBundleView {
  readonly arrivedAt: string;
  readonly antibioticAt: string | null;
  readonly tetanusAt: string | null;
  readonly debridementAt: string | null;
  readonly plasticsReferralAt: string | null;
  readonly definitiveCoverAt: string | null;
  /** Recomputed by the database on every write and stored. */
  readonly breaches: readonly string[];
  /** Null until an antibiotic is recorded. Over 60 is the breach. */
  readonly minutesToAntibiotic: number | null;
}

export interface FractureView {
  readonly id: string;
  readonly patientId: string;
  readonly boneCode: string;
  readonly boneDisplay: string;
  readonly side: string;

  readonly aoBone: number | null;
  readonly aoSegment: number | null;
  readonly aoType: string | null;
  readonly aoGroup: number | null;
  readonly aoSubgroup: number | null;
  readonly aoCode: string | null;
  readonly aoVersion: string;

  readonly isOpen: boolean;
  readonly gustilo: string | null;
  readonly tscherne: string | null;
  readonly paediatric: boolean;
  readonly salterHarris: string | null;
  readonly aetiology: string;
  readonly dislocation: boolean;
  readonly associated: unknown;
  readonly regionalClassification: unknown;
  readonly icd10: string | null;
  readonly mechanism: unknown;

  readonly injuryAt: string | null;
  readonly injuryAtEstimated: boolean;
  readonly diagnosedAt: string;
  readonly classificationStatus: string;
  readonly confirmedBy: string | null;
  readonly confirmedAt: string | null;
  readonly cosignRequired: boolean;
  readonly cosignedAt: string | null;

  readonly isMlc: boolean;
  readonly status: string;
  readonly unionAt: string | null;
  readonly timeToUnionWeeks: string | null;
  readonly closedReason: string | null;
  readonly nonunionOverrideReason: string | null;
  readonly version: number;
  readonly notes: string | null;

  /** Weeks since injury. The number every ortho conversation starts with. */
  readonly weeksSinceInjury: string | null;
  /**
   * Whether this row would survive a registry export: bone, side, AO to type
   * level, open/closed, mechanism, injury date and an outcome once closed.
   */
  readonly registryReady: boolean;
  readonly registryGaps: readonly string[];
}

export interface FractureDetailView {
  readonly fracture: FractureView;
  readonly plans: readonly FracturePlanView[];
  readonly events: readonly FractureEventView[];
  readonly films: readonly FractureFilmView[];
  readonly complications: readonly FractureComplicationView[];
  readonly openBundle: OpenBundleView | null;
}

export interface OrthoFollowupView {
  readonly id: string;
  readonly protocolKey: string;
  readonly label: string;
  readonly offsetWeeks: string;
  readonly dueAt: string;
  readonly actions: readonly string[];
  readonly status: string;
  readonly completedAt: string | null;
  /** Negative means it is already due. */
  readonly daysUntilDue: number;
}

export interface OrthoExamView {
  readonly id: string;
  readonly at: string;
  readonly rom: unknown;
  readonly neurovascular: unknown;
  readonly specialTests: unknown;
  readonly notes: string | null;
}

export interface OrthoPromView {
  readonly id: string;
  readonly instrument: string;
  readonly atWeeks: string;
  readonly score: string | null;
  readonly scoreMax: string | null;
  readonly higherIsBetter: boolean;
  readonly collectedAt: string;
}

export interface OrthoEpisodeView {
  readonly id: string;
  readonly patientId: string;
  readonly anchorKind: string;
  readonly anchorAt: string;
  readonly presentingComplaint: string | null;
  readonly xrayFirst: boolean;
  readonly status: string;
  readonly openedAt: string;
  readonly exams: readonly OrthoExamView[];
  readonly followups: readonly OrthoFollowupView[];
  readonly proms: readonly OrthoPromView[];
}
