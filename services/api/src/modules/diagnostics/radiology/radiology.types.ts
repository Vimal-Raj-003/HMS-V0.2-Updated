/**
 * The view shapes this module returns.
 *
 * Every one of them is a deliberate projection rather than the row: a radiology
 * order row carries an MRI implant questionnaire and a masked identity
 * reference, and a report row carries a hash chain. Returning the row would put
 * both on the wire for every worklist refresh.
 *
 * **There is no field here, and there is no field anywhere in this module, that
 * could carry a foetal sex.** `migration.sql §C.7` asserts that of the schema by
 * reading `information_schema`; this file is the same promise on the way out.
 */

export interface RadOrderItemView {
  readonly id: string;
  readonly lineNo: number;
  readonly procedureKey: string;
  readonly procedureCode: string;
  readonly procedureName: string;
  readonly modality: string;
  readonly laterality: string;
  readonly contrast: boolean;
  readonly status: string;
  readonly studyInstanceUid: string | null;
  readonly scheduledProcedureStepId: string | null;
  readonly isPcpndt: boolean;
  readonly isIonising: boolean;
}

export interface RadOrderView {
  readonly id: string;
  readonly accessionNo: string;
  readonly patientId: string;
  readonly branchId: string;
  readonly source: string;
  readonly priority: string;
  readonly status: string;
  readonly billingStatus: string;
  readonly clinicalIndication: string;
  readonly isMlc: boolean;
  readonly pregnancyStatus: string | null;
  readonly contrastRequired: boolean;
  readonly contrastAllergyKnown: boolean;
  readonly mriUnsafeImplant: boolean;
  readonly orderedAt: string;
  readonly cancelReason: string | null;
  readonly items: readonly RadOrderItemView[];
}

export interface RadExamView {
  readonly id: string;
  readonly orderItemId: string;
  readonly patientId: string;
  readonly accessionNo: string;
  readonly modality: string;
  readonly status: string;
  readonly roomId: string | null;
  readonly studyInstanceUid: string | null;
  readonly repeatCount: number;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly doseRecorded: boolean;
}

export interface RadReportVersionView {
  readonly version: number;
  readonly status: string;
  readonly findingLevel: string;
  readonly impressionText: string | null;
  readonly findingsText: string | null;
  readonly authorUserId: string | null;
  readonly cosignerUserId: string | null;
  readonly signedBy: string | null;
  readonly signedAt: string | null;
  readonly amendmentReason: string | null;
  readonly contentSha256: string;
  readonly prevSha256: string | null;
}

export interface RadReportView {
  readonly id: string;
  readonly orderItemId: string;
  readonly patientId: string;
  readonly accessionNo: string;
  readonly currentVersion: number;
  readonly currentStatus: string;
  readonly highestFindingLevel: string;
  /** True while the order is released but not closed, because a critical is open. */
  readonly awaitingCriticalCallback: boolean;
  readonly versions: readonly RadReportVersionView[];
}

export interface CriticalFindingView {
  readonly id: string;
  readonly reportId: string;
  readonly patientId: string;
  readonly level: string;
  readonly status: string;
  readonly findingText: string;
  readonly detectedAt: string;
  readonly dueBy: string | null;
  readonly firstCommunicatedAt: string | null;
  readonly escalationLevel: number;
  readonly callbackCount: number;
}

export interface PacsStudyView {
  readonly id: string;
  readonly studyInstanceUid: string;
  readonly patientId: string | null;
  readonly accessionNo: string | null;
  readonly orderItemId: string | null;
  readonly modality: string | null;
  readonly status: string;
  readonly tier: string;
  readonly matchedBy: string;
  readonly reconciliationStatus: string;
  readonly seriesCount: number;
  readonly instanceCount: number;
  readonly sizeBytes: string;
  readonly isMlc: boolean;
  readonly legalHold: boolean;
}

export interface ViewerGrantView {
  readonly studyId: string;
  readonly studyInstanceUid: string;
  readonly tokenId: string;
  /** The opaque token; the archive gateway verifies its hash. Never stored in clear. */
  readonly token: string;
  readonly scope: string;
  readonly purpose: string;
  readonly expiresAt: string;
  readonly breakGlass: boolean;
  /** Reference to the archive object, never pixels: EN-008 owns those. */
  readonly orthancId: string | null;
}

export interface DoseSummaryView {
  readonly patientId: string;
  readonly cumulativeMsvLifetime: string;
  readonly msv12m: string;
  readonly ctCount12m: number;
  readonly studyCount12m: number;
  readonly thresholdBreached: boolean;
  readonly lastStudyAt: string | null;
}

export interface InvestigationStudyView {
  readonly id: string;
  readonly accessionNo: string;
  readonly patientId: string;
  readonly serviceKey: string;
  readonly serviceName: string;
  readonly modalityGroup: string;
  readonly priority: string;
  readonly status: string;
  readonly isPcpndt: boolean;
  readonly isIonising: boolean;
  readonly mediaCount: number;
  readonly scheduledAt: string | null;
  readonly performedAt: string | null;
}

export interface InvestigationReportVersionView {
  readonly version: number;
  readonly status: string;
  readonly critical: boolean;
  readonly impression: string | null;
  readonly authorUserId: string;
  readonly cosignerUserId: string | null;
  readonly discrepancy: string | null;
  readonly signedBy: string | null;
  readonly signedAt: string | null;
  readonly pcpndtTextCheckPassed: boolean | null;
  readonly contentSha256: string;
  readonly prevSha256: string | null;
}

export interface InvestigationReportView {
  readonly id: string;
  readonly studyId: string;
  readonly patientId: string;
  readonly reportNo: string;
  readonly currentVersion: number;
  readonly currentStatus: string;
  readonly cosignRequired: boolean;
  readonly everCritical: boolean;
  readonly versions: readonly InvestigationReportVersionView[];
}
