/** TR-008 shapes, mirroring `services/api/.../mlc/mlc.types.ts`. */

export interface MlcCaseView {
  readonly id: string;
  readonly mlcNo: string;
  readonly category: string;
  readonly subCategory: string | null;
  readonly status: string;

  readonly erVisitId: string | null;
  readonly admissionId: string | null;
  readonly patientId: string | null;
  readonly tempTagId: string | null;
  /** From the ER visit, so the register reads without a second call. */
  readonly erNo: string | null;
  readonly displayName: string | null;

  readonly openedAt: string;
  readonly openedBy: string | null;
  readonly suggestedFrom: string | null;

  readonly broughtBy: unknown;
  readonly informant: unknown;
  readonly historyAsStated: string | null;
  readonly identificationMarks: readonly string[];
  readonly allegedIncidentAt: string | null;
  readonly incidentPlace: string | null;
  readonly consent: unknown;
  readonly intoxicationAssessment: unknown;

  readonly isSensitive: boolean;

  readonly unflagReason: string | null;
  readonly unflaggedBy: string | null;
  readonly unflaggedAt: string | null;

  readonly moId: string | null;
  readonly closedAt: string | null;

  readonly gateOverrideBy: string | null;
  readonly gateOverrideReason: string | null;
  readonly gateOverriddenAt: string | null;

  /** Minutes from the case opening to the first dispatched intimation. */
  readonly minutesToIntimation: number | null;
  readonly intimationCount: number;
  readonly injuryCount: number;
  readonly evidenceCount: number;
  readonly reportCount: number;
}

export interface MlcIntimationView {
  readonly id: string;
  readonly caseId: string;
  readonly type: string;
  readonly psName: string;
  readonly jurisdiction: string | null;
  readonly addressedTo: string | null;
  readonly status: string;
  readonly generatedAt: string;
  readonly dispatchedAt: string | null;
  readonly channels: unknown;
  readonly ackOfficerName: string | null;
  readonly ackOfficerBadge: string | null;
  readonly ackAt: string | null;
  readonly ackDueAt: string | null;
  readonly failureReason: string | null;
  /** Positive means it is late. The KPI is one hour from the case opening. */
  readonly minutesOverdue: number | null;
}

export interface MlcInjuryView {
  readonly id: string;
  readonly caseId: string;
  readonly seq: number;
  readonly kind: string;
  readonly bodyView: string;
  readonly xPct: string;
  readonly yPct: string;
  readonly side: string | null;
  readonly siteDescription: string;
  readonly lengthCm: string | null;
  readonly breadthCm: string | null;
  readonly depthCm: string | null;
  readonly shape: string | null;
  readonly edges: string | null;
  readonly direction: string | null;
  readonly colourStage: string | null;
  readonly ageEstimate: string | null;
  readonly foreignBody: string | null;
  readonly firearmFeatures: unknown;
  readonly bnsClass: string;
  readonly grievousReason: string | null;
  readonly weaponOpinion: string;
  readonly consistentWithHistory: string;
  readonly traumaInjuryId: string | null;
  readonly recordedAt: string;
  readonly recordedBy: string | null;
}

export interface MlcCustodyEntryView {
  readonly seq: number;
  readonly at: string;
  readonly fromUserId: string | null;
  readonly toUserId: string | null;
  readonly toExternal: unknown;
  readonly locationFrom: string;
  readonly locationTo: string;
  readonly purpose: string;
  readonly sealIntact: boolean;
  readonly witnessUserId: string | null;
  readonly conditionNotes: string | null;
  readonly temperatureC: string | null;
  readonly prevHash: string;
  readonly hash: string;
  /**
   * Whether this entry's `prevHash` matches the previous entry's `hash` —
   * recomputed on read rather than trusted. The point of a chain is that
   * somebody checks it.
   */
  readonly linkIntact: boolean;
}

export interface MlcEvidenceView {
  readonly id: string;
  readonly caseId: string;
  readonly itemNo: number;
  readonly kind: string;
  readonly description: string;
  readonly collectedAt: string;
  readonly collectedBy: string | null;
  readonly sealNo: string | null;
  readonly bagLabelRef: string | null;
  readonly sampleId: string | null;
  readonly fileRef: string | null;
  readonly sha256: string | null;
  readonly deviceId: string | null;
  readonly currentCustodianId: string | null;
  readonly currentLocation: string;
  readonly status: string;
  readonly notes: string | null;
  readonly custody: readonly MlcCustodyEntryView[];
  /** False when any link in the chain fails to verify. Never silently true. */
  readonly chainIntact: boolean;
}

export interface MlcReportView {
  readonly id: string;
  readonly caseId: string;
  readonly kind: string;
  readonly versionNo: number;
  readonly status: string;
  readonly templateRef: string | null;
  readonly documentRef: string | null;
  readonly sha256: string | null;
  readonly content: unknown;
  readonly signedBy: string | null;
  readonly dscRef: string | null;
  readonly signedAt: string | null;
  readonly addendumOf: string | null;
  readonly addendumReason: string | null;
  readonly dispatches: unknown;
  readonly copyRegisterNo: string | null;
  readonly createdAt: string;
}

export interface MlcRequestView {
  readonly id: string;
  readonly caseId: string;
  readonly kind: string;
  readonly requester: unknown;
  readonly authorityRef: string | null;
  readonly receivedAt: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly providedAt: string | null;
  readonly providedDocRefs: readonly string[];
  readonly deniedReason: string | null;
}

export interface MlcSexualAssaultView {
  readonly id: string;
  readonly caseId: string;
  readonly survivorAgeBand: string;
  readonly isPocso: boolean;
  readonly consentMatrix: unknown;
  readonly chaperoneId: string | null;
  readonly examProforma: unknown;
  readonly safeKitChecklist: unknown;
  readonly prophylaxis: unknown;
  readonly pregnancyTest: string | null;
  readonly referrals: unknown;
  readonly followups: unknown;
  readonly policeInformed: string;
  readonly sjpuCwcIntimation: unknown;
  /** Always true. BNSS §397 is not a discount somebody applies. */
  readonly treatmentWaived: boolean;
  readonly createdAt: string;
}

export interface MlcDeathView {
  readonly id: string;
  readonly caseId: string;
  readonly kind: string;
  readonly declaredAt: string;
  readonly declaredBy: string | null;
  readonly provisionalCause: string | null;
  readonly mannerSuspected: string;
  readonly pmRequired: string;
  readonly bodyCustody: string;
  readonly nocNo: string | null;
  readonly mortuaryCaseId: string | null;
  readonly mccdStatus: string;
}

export interface MlcDyingDeclarationView {
  readonly id: string;
  readonly caseId: string;
  readonly requestedAt: string;
  readonly magistrate: unknown;
  readonly fitnessCertifiedBy: string | null;
  readonly fitnessAt: string | null;
  readonly fitnessOpinion: string | null;
  readonly recordedAt: string | null;
  readonly recordedByExternal: string | null;
}

/** The whole case, as the MLC panel renders it. */
export interface MlcCaseDetailView {
  readonly mlcCase: MlcCaseView;
  readonly intimations: readonly MlcIntimationView[];
  readonly injuries: readonly MlcInjuryView[];
  readonly evidence: readonly MlcEvidenceView[];
  readonly reports: readonly MlcReportView[];
  readonly requests: readonly MlcRequestView[];
  readonly dyingDeclarations: readonly MlcDyingDeclarationView[];
  readonly death: MlcDeathView | null;
  /** Only ever populated for a caller holding `mlc.sensitive.read`. */
  readonly sexualAssault: MlcSexualAssaultView | null;
  readonly gate: MlcDischargeGateView;
}

/**
 * What is still holding this patient in the department.
 *
 * The same three conditions the database trigger checks, computed here so the
 * screen can show them before somebody presses a button and is refused. The
 * trigger remains the enforcement; this is the courtesy.
 */
export interface MlcDischargeGateView {
  readonly caseId: string;
  readonly mlcNo: string;
  readonly blocked: boolean;
  readonly outstanding: readonly string[];
  readonly overriddenBy: string | null;
  readonly overrideReason: string | null;
  readonly overriddenAt: string | null;
}

export interface MlcWorklistRow {
  readonly caseId: string;
  readonly mlcNo: string;
  readonly category: string;
  readonly openedAt: string;
  readonly detail: string;
  /** Minutes past the target, when there is one. */
  readonly minutesOverdue: number | null;
}
