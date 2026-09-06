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

// ─────────────────────────────────────────────────────────────────────────────
// TR-003 + TR-005
// ─────────────────────────────────────────────────────────────────────────────

export interface CatalogueView {
  readonly id: string;
  readonly udiDi: string | null;
  readonly gtin: string | null;
  readonly catalogueNo: string | null;
  readonly manufacturer: string;
  readonly brand: string | null;
  readonly kind: string;
  readonly description: string;
  readonly sizeLabel: string | null;
  readonly laterality: string;
  readonly material: string | null;
  readonly mriConditionality: string;
  readonly mriConditions: unknown;
  readonly shelfLifeMonths: number | null;
  readonly ownership: string;
  readonly consignmentPrice: number | null;
  readonly isActive: boolean;
  readonly available: number;
}

export interface StockView {
  readonly id: string;
  readonly catalogueId: string;
  readonly description: string;
  readonly manufacturer: string;
  readonly udiDi: string | null;
  readonly serialNo: string | null;
  readonly lotNo: string | null;
  readonly udiPi: string | null;
  readonly expiryOn: string | null;
  readonly status: string;
  readonly location: string | null;
  readonly grnRef: string | null;
  readonly receivedAt: string | null;
  readonly daysToExpiry: number | null;
}

export interface UsageView {
  readonly id: string;
  readonly stockItemId: string;
  readonly patientId: string;
  readonly fractureId: string | null;
  readonly procedureName: string;
  readonly side: string | null;
  readonly surgeonId: string;
  readonly implantedAt: string;
  readonly scanned: boolean;
  readonly manualReason: string | null;
  readonly chargedPrice: number | null;
  readonly explantedAt: string | null;
  readonly explantReason: string | null;
  readonly serialNo: string | null;
  readonly lotNo: string | null;
  readonly udiDi: string | null;
  readonly description: string;
  readonly manufacturer: string;
  readonly kind: string;
  readonly mriConditionality: string;
  readonly mriConditions: unknown;
  readonly recalled: boolean;
}

export interface RecallView {
  readonly id: string;
  readonly reference: string;
  readonly catalogueId: string | null;
  readonly udiDi: string | null;
  readonly lotNos: readonly string[];
  readonly manufacturer: string;
  readonly kind: string;
  readonly severity: string;
  readonly summary: string;
  readonly actionRequired: string;
  readonly issuedOn: string;
  readonly receivedAt: string | null;
  readonly patientsIdentifiedAt: string | null;
  readonly closedAt: string | null;
  readonly patients: number;
  readonly pending: number;
  readonly unreachable: number;
}

export interface RecallCaseView {
  readonly id: string;
  readonly recallId: string;
  readonly usageId: string;
  readonly patientId: string;
  readonly surgeonId: string | null;
  readonly notifiedPatientAt: string | null;
  readonly notifiedSurgeonAt: string | null;
  readonly response: string;
  readonly responseAt: string | null;
  readonly contactAttempts: number;
  readonly notes: string | null;
  readonly serialNo: string | null;
  readonly lotNo: string | null;
  readonly implantedAt: string;
  readonly explantedAt: string | null;
}

export interface RecallDetailView extends RecallView {
  readonly cases: readonly RecallCaseView[];
}

export interface TraceRow {
  readonly usageId: string;
  readonly patientId: string;
  readonly surgeonId: string;
  readonly implantedAt: string;
  readonly explantedAt: string | null;
  readonly side: string | null;
  readonly procedureName: string;
  readonly serialNo: string | null;
  readonly lotNo: string | null;
  readonly udiDi: string | null;
  readonly description: string;
  readonly manufacturer: string;
  readonly scanned: boolean;
}

export interface TraceResult {
  readonly rows: readonly TraceRow[];
  readonly total: number;
  readonly manualEntries: number;
  readonly inSitu: number;
}

export interface CastRequestView {
  readonly id: string;
  readonly patientId: string;
  readonly fractureId: string | null;
  readonly kind: string;
  readonly side: string;
  readonly bodyRegion: string;
  readonly position: string | null;
  readonly material: string | null;
  readonly weightBearing: string | null;
  readonly urgency: string;
  readonly instructions: string | null;
  readonly status: string;
  readonly requestedAt: string;
  readonly requestedBy: string | null;
}

export interface CastCheckView {
  readonly id: string;
  readonly applicationId: string;
  readonly at: string;
  readonly byId: string | null;
  readonly kind: string | null;
  readonly painOutOfProportion: boolean;
  readonly painOnPassiveStretch: boolean;
  readonly paraesthesia: boolean;
  readonly pallor: boolean;
  readonly pulselessness: boolean;
  readonly otherFindings: readonly string[];
  readonly capillaryRefillSec: number | null;
  readonly skinIntact: boolean;
  readonly castIntact: boolean;
  readonly neurovascularIntact: boolean;
  readonly redFlag: boolean;
  readonly actionTaken: string | null;
  readonly escalatedTo: string | null;
  readonly notes: string | null;
}

export interface PinSiteView {
  readonly id: string;
  readonly applicationId: string;
  readonly pinLabel: string;
  readonly intervalDays: number;
  readonly lastCareAt: string | null;
  readonly nextDueAt: string;
  readonly infectionGrade: number | null;
  readonly notes: string | null;
  readonly isActive: boolean;
  readonly overdue: boolean;
}

export interface CastApplicationView {
  readonly id: string;
  readonly requestId: string;
  readonly patientId: string;
  readonly kind: string;
  readonly side: string;
  readonly material: string;
  readonly position: string | null;
  readonly padding: string | null;
  readonly appliedIn: string;
  readonly appliedAt: string | null;
  readonly appliedBy: string | null;
  readonly nextCheckDueAt: string | null;
  readonly plannedRemovalAt: string | null;
  readonly removedAt: string | null;
  readonly removedBy: string | null;
  readonly removalNotes: string | null;
  readonly bodyRegion: string;
  readonly fractureId: string | null;
  readonly weightBearing: string | null;
  readonly checkDue: boolean;
  readonly lastCheckRedFlag: boolean;
}

export interface CastDetailView extends CastApplicationView {
  readonly request: CastRequestView;
  readonly checks: readonly CastCheckView[];
  readonly pinSites: readonly PinSiteView[];
}
