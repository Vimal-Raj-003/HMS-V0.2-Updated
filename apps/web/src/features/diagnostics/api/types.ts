/**
 * The wire shapes of the Phase-3 diagnostics API, as the browser receives them.
 *
 * Mirrored here rather than imported, for the reason `features/clinical/api/types.ts`
 * gives: the request and response contracts still live inside
 * `services/api/src/modules/diagnostics/**`, and `packages/*` is outside this
 * change's remit. Lifting them into `packages/contracts` and deleting this file
 * is the follow-up, and it is recorded as an API gap rather than worked around.
 *
 * Two conventions are kept from the API **verbatim, including the inconsistency
 * between them**, because inventing a uniform casing here would mean every field
 * silently reading `undefined` at runtime while type-checking perfectly:
 *
 *  - **OP-004 (laboratory) returns `snake_case`** — `lab.types.ts` projects
 *    column names straight out.
 *  - **OP-008 / EN-008 / OP-022 (radiology, PACS, investigations) return
 *    `camelCase`** — `radiology.types.ts` maps them explicitly.
 *
 * Timestamps arrive as ISO-8601 **strings**. The service types say `Date`; JSON
 * has no date type, so what `fetch` yields is a string, and typing it as `Date`
 * compiles and then produces `undefined` at every `.getTime()`.
 *
 * `PacsStudyView.sizeBytes` is a **string** on purpose: it is a `bigint` column
 * and an archive study passes `Number.MAX_SAFE_INTEGER` long before it passes
 * anything a radiologist would call large.
 *
 * ── PC-PNDT ────────────────────────────────────────────────────────────────
 *
 * There is no field in this file, and there is no field anywhere in this
 * feature, that could carry a foetal sex. `radiology.types.ts` makes the same
 * promise on the way out of the API and `migration.sql §C.7` asserts it of the
 * schema by reading `information_schema`. `lib/pcpndt.spec.ts` asserts it of
 * this feature's source by reading the files.
 */

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
// OP-004 — laboratory (snake_case, as the API returns it)
// ═════════════════════════════════════════════════════════════════════════════

export const LAB_PRIORITIES = ['routine', 'urgent', 'stat'] as const;
export type LabPriority = (typeof LAB_PRIORITIES)[number];

export const LAB_DISCIPLINES = [
  'biochemistry',
  'haematology',
  'clinical_pathology',
  'microbiology',
  'serology',
  'immunology',
  'histopathology',
  'cytopathology',
  'molecular',
  'genetics',
  'blood_bank',
  'outsourced',
] as const;
export type LabDiscipline = (typeof LAB_DISCIPLINES)[number];

export const LAB_COLLECTION_SITES = [
  'opd_collection_room',
  'ward',
  'icu',
  'er',
  'ot',
  'home',
  'camp',
  'external',
  'other',
] as const;
export type LabCollectionSite = (typeof LAB_COLLECTION_SITES)[number];

export const LAB_SAMPLE_CONDITIONS = [
  'satisfactory',
  'haemolysed',
  'lipaemic',
  'icteric',
  'clotted',
  'insufficient',
  'leaked',
  'unlabelled',
  'mislabelled',
  'wrong_container',
  'delayed',
  'temperature_excursion',
  'contaminated',
] as const;
export type LabSampleCondition = (typeof LAB_SAMPLE_CONDITIONS)[number];

export const LAB_RESULT_TYPES = [
  'numeric',
  'semi_quantitative',
  'qualitative',
  'coded',
  'text',
  'multiselect',
  'calculated',
] as const;
export type LabResultType = (typeof LAB_RESULT_TYPES)[number];

export const LAB_NOTIFY_METHODS = ['phone', 'in_person', 'secure_message', 'video', 'pager', 'sms'] as const;
export type LabNotifyMethod = (typeof LAB_NOTIFY_METHODS)[number];

/**
 * `result-flags.ts` in the API. Rendered by `lib/result-flags.ts` here, and the
 * two lists must agree: a flag this file does not know is rendered as an unknown
 * verdict rather than silently as "normal".
 */
export const LAB_RESULT_FLAGS = [
  'normal',
  'low',
  'high',
  'critical_low',
  'critical_high',
  'abnormal',
  'positive',
  'negative',
  'reactive',
  'non_reactive',
  'indeterminate',
] as const;
export type LabResultFlag = (typeof LAB_RESULT_FLAGS)[number];

export const QC_LEVELS = ['l1', 'l2', 'l3', 'l4', 'other'] as const;
export type QcLevel = (typeof QC_LEVELS)[number];

export const QC_PATIENT_IMPACTS = [
  'none',
  'retest_all',
  'retest_selected',
  'released_with_authorisation',
] as const;
export type QcPatientImpact = (typeof QC_PATIENT_IMPACTS)[number];

export const LAB_REPORT_TYPES = ['interim', 'departmental', 'final', 'amended', 'cumulative'] as const;
export type LabReportType = (typeof LAB_REPORT_TYPES)[number];

export interface LabOrderTestView {
  readonly id: string;
  readonly line_no: number;
  readonly test_key: string;
  readonly test_code: string;
  readonly test_name: string;
  readonly loinc_code: string | null;
  readonly discipline: string;
  readonly sample_id: string | null;
  readonly priority: string;
  readonly status: string;
  readonly is_addon: boolean;
  readonly is_reflex: boolean;
  readonly is_chargeable: boolean;
  readonly panel_key: string | null;
  readonly recollection_of_order_test_id: string | null;
  readonly tat_due_at: string | null;
  readonly cancel_reason: string | null;
}

export interface LabSampleView {
  readonly id: string;
  readonly sample_no: string;
  readonly barcode: string;
  readonly status: string;
  readonly specimen_type_name: string;
  readonly container_name: string | null;
  readonly cap_colour: string | null;
  readonly collected_at: string | null;
  readonly received_at: string | null;
  readonly accessioned_at: string | null;
  readonly condition_on_receipt: string | null;
  readonly rejection_reason_code: string | null;
  readonly rejection_note: string | null;
  readonly rejected_at: string | null;
  readonly recollection_of_sample_id: string | null;
  readonly patient_scan_verified: boolean;
  readonly container_scan_verified: boolean;
  readonly identity_override_reason: string | null;
}

export interface LabOrderView {
  readonly id: string;
  readonly accession_no: string;
  readonly patient_id: string;
  readonly branch_id: string;
  readonly visit_id: string | null;
  readonly encounter_id: string | null;
  readonly clinical_order_id: string | null;
  readonly source: string;
  readonly priority: string;
  readonly status: string;
  readonly billing_status: string;
  readonly clinical_notes: string | null;
  readonly is_mlc: boolean;
  readonly ordered_at: string;
  readonly cancel_reason: string | null;
  readonly tests: readonly LabOrderTestView[];
  readonly samples: readonly LabSampleView[];
}

export interface LabLabelView {
  readonly id: string;
  readonly sample_id: string;
  readonly barcode: string;
  readonly symbology: string;
  readonly copy_no: number;
  readonly is_reprint: boolean;
  readonly specimen_type_name: string;
  readonly container_name: string | null;
  readonly cap_colour: string | null;
  readonly test_codes: readonly string[];
  readonly printed_at: string;
}

export interface LabResultView {
  readonly id: string;
  readonly order_id: string;
  readonly order_test_id: string;
  readonly patient_id: string;
  readonly test_key: string;
  readonly parameter_key: string | null;
  readonly analyte_name: string;
  readonly loinc_code: string | null;
  readonly result_type: string;
  readonly current_version: number;
  readonly current_status: string;
  readonly current_flag: string | null;
  readonly ever_critical: boolean;
  readonly value_numeric: number | null;
  readonly value_operator: string | null;
  readonly value_coded: string | null;
  readonly value_multi: readonly string[];
  readonly value_text: string | null;
  readonly unit: string | null;
  readonly ref_low: number | null;
  readonly ref_high: number | null;
  readonly ref_critical_low: number | null;
  readonly ref_critical_high: number | null;
  readonly delta_flagged: boolean;
  readonly qc_state_at_release: string;
  readonly amendment_reason: string | null;
  readonly comment: string | null;
  readonly entered_by: string | null;
  readonly verified_by: string | null;
  readonly authorised_by: string | null;
  readonly recorded_at: string;
}

export interface LabResultChainLink {
  readonly version: number;
  readonly status: string;
  readonly hash_matches: boolean;
  readonly link_matches: boolean;
}

export interface LabWorklistItem {
  readonly id: string;
  readonly order_test_id: string;
  readonly order_id: string;
  readonly accession_no: string;
  readonly patient_id: string;
  readonly test_code: string;
  readonly test_name: string;
  readonly discipline: string;
  readonly priority: string;
  readonly status: string;
  readonly sample_id: string | null;
  readonly sample_no: string | null;
  readonly barcode: string | null;
  readonly tat_due_at: string | null;
  readonly received_at: string | null;
}

export interface LabCriticalCallbackView {
  readonly id: string;
  readonly sequence: number;
  readonly notified_by_name: string;
  readonly notified_at: string;
  readonly method: string;
  readonly notified_to_name: string | null;
  readonly notified_to_role: string | null;
  readonly read_back_confirmed: boolean;
  readonly read_back_value: string | null;
  readonly clinician_unreachable: boolean;
  readonly escalated_to_level: number | null;
  readonly escalated_to_role: string | null;
  readonly latency_seconds: number | null;
}

export interface LabCriticalAlertView {
  readonly id: string;
  readonly result_id: string;
  readonly result_version: number;
  readonly order_id: string;
  readonly order_test_id: string;
  readonly patient_id: string;
  readonly analyte_name: string;
  readonly flag: string;
  readonly value_display: string;
  readonly unit: string | null;
  readonly detected_at: string;
  readonly due_by: string | null;
  readonly status: string;
  readonly escalation_level: number;
  readonly first_communicated_at: string | null;
  readonly acknowledged_at: string | null;
  readonly callbacks: readonly LabCriticalCallbackView[];
}

export interface LabQcStateView {
  readonly id: string;
  readonly instrument_id: string;
  readonly test_key: string;
  readonly parameter_key: string | null;
  readonly state: string;
  /** `lab.qc_permits_release(state)` — the database's answer, never recomputed here. */
  readonly permits_release: boolean;
  readonly last_evaluated_at: string | null;
  readonly next_due_at: string | null;
  readonly reason: string | null;
  readonly active_lockout_id: string | null;
}

export interface LabQcRunView {
  readonly id: string;
  readonly instrument_id: string;
  readonly test_key: string;
  readonly level: string;
  readonly value: number;
  readonly z_score: number | null;
  readonly status: string;
  readonly violated_rules: readonly string[];
  readonly has_rejection: boolean;
  readonly lockout_id: string | null;
  readonly state: string;
  readonly permits_release: boolean;
  readonly run_at: string;
}

export interface LabReportView {
  readonly id: string;
  readonly order_id: string;
  readonly patient_id: string;
  readonly report_no: string;
  readonly type: string;
  readonly discipline: string | null;
  readonly current_version: number;
  readonly current_status: string;
  readonly nabl_logo_printed: boolean;
  readonly is_sensitive: boolean;
  readonly contains_outsourced: boolean;
  readonly order_test_ids: readonly string[];
  readonly verify_token: string | null;
  readonly amendment_reason: string | null;
  readonly issued_at: string | null;
}

export interface LabTestCatalogueItem {
  readonly record_key: string;
  readonly code: string;
  readonly name: string;
  readonly short_code: string | null;
  readonly loinc_code: string | null;
  readonly discipline: string;
  readonly result_type: string;
  readonly unit: string | null;
  readonly is_panel: boolean;
  readonly specimen_type_name: string | null;
  readonly container_name: string | null;
  readonly cap_colour: string | null;
  readonly requires_fasting: boolean;
  readonly is_sensitive: boolean;
  readonly is_nabl_scope: boolean;
  readonly is_orderable: boolean;
}

export interface LabRejectionReasonItem {
  readonly record_key: string;
  readonly code: string;
  readonly label: string;
  readonly nabl_category: string | null;
  readonly requires_recollection: boolean;
  readonly recollection_chargeable: boolean;
}

// ── laboratory requests ──────────────────────────────────────────────────────

export interface CollectSampleRequest {
  readonly patientScanVerified: boolean;
  readonly containerScanVerified: boolean;
  /** OP-004 §5's only route past the two scans, and it is audited. */
  readonly identityOverrideReason?: string;
  readonly collectionSite: LabCollectionSite;
  readonly fasting?: boolean;
  readonly fastingHours?: number;
  readonly drawAttempts?: number;
  readonly drawSite?: string;
}

export interface ReceiveSampleRequest {
  readonly conditionOnReceipt: LabSampleCondition;
  readonly receiptTempC?: number;
}

export interface AccessionSampleRequest {
  readonly storageLocation?: string;
}

export interface RejectSampleRequest {
  /** `lab.lab_rejection_reasons.record_key` — never free text; it is a NABL KPI. */
  readonly rejectionReasonKey: string;
  readonly note?: string;
  readonly recollect: boolean;
}

export interface IssueLabelsRequest {
  readonly reprintReason?: string;
  readonly printerId?: string;
  readonly copies: number;
}

export interface ResultEntryRequest {
  readonly orderTestId: string;
  readonly parameterKey?: string;
  readonly resultType: LabResultType;
  readonly valueNumeric?: number;
  readonly valueOperator?: '<' | '>' | '<=' | '>=' | '~';
  readonly valueCoded?: string;
  readonly valueCodedSystem?: string;
  readonly valueMulti: readonly string[];
  readonly valueText?: string;
  readonly unit?: string;
  readonly instrumentId?: string;
  readonly runId?: string;
  readonly instrumentFlags: readonly string[];
  readonly dilutionFactor?: number;
  readonly comment?: string;
}

export interface ReleaseResultsRequest {
  readonly resultIds: readonly string[];
  /** EN-031 §5's single exception, named rather than implied. */
  readonly qcOverrideActionId?: string;
  readonly signMethod: 'system' | 'dsc' | 'aadhaar_esign' | 'webauthn';
}

export interface AmendResultRequest {
  readonly reason: string;
  readonly resultType: LabResultType;
  readonly valueNumeric?: number;
  readonly valueCoded?: string;
  readonly valueMulti: readonly string[];
  readonly valueText?: string;
  readonly unit?: string;
  readonly comment?: string;
}

/**
 * `docs/DECISIONS.md D-10` as a discriminated union: a read-back names the
 * person and repeats the value; an escalation names the tier it went to.
 * Neither-and-both are both unrepresentable, which is the point.
 */
export type LabCriticalCallbackRequest =
  | {
      readonly outcome: 'read_back_confirmed';
      readonly method: LabNotifyMethod;
      readonly notifiedToUserId?: string;
      readonly notifiedToName: string;
      readonly notifiedToRole?: string;
      readonly notifiedToContact?: string;
      readonly readBackValue: string;
      readonly attemptCount: number;
      readonly remarks?: string;
    }
  | {
      readonly outcome: 'clinician_unreachable_escalated';
      readonly method: LabNotifyMethod;
      readonly escalatedToLevel: number;
      readonly escalatedToRole: string;
      readonly escalatedToUserId?: string;
      readonly attemptCount: number;
      readonly remarks?: string;
    };

export interface QcRunRequest {
  readonly instrumentId: string;
  readonly testKey: string;
  readonly parameterKey?: string;
  readonly qcMaterialId: string;
  readonly level: QcLevel;
  readonly value: number;
  readonly unit?: string;
  readonly runNo?: number;
  readonly reagentLot?: string;
  readonly comment?: string;
}

export interface QcActionRequest {
  readonly instrumentId: string;
  readonly testKey: string;
  readonly lockoutId?: string;
  readonly qcRunId?: string;
  readonly causeCode: string;
  readonly causeNote?: string;
  readonly actionCode: string;
  readonly actionNote?: string;
  readonly patientImpact: QcPatientImpact;
  readonly affectedResultCount: number;
  readonly authorisationReason?: string;
}

export interface QcUnlockRequest {
  readonly reason: string;
  readonly unlockQcRunId: string;
  readonly correctiveActionId: string;
}

export interface GenerateLabReportRequest {
  readonly type: LabReportType;
  readonly discipline?: LabDiscipline;
  readonly amendmentReason?: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// OP-008 / EN-008 / OP-022 — radiology, PACS, investigations (camelCase)
// ═════════════════════════════════════════════════════════════════════════════

export const RAD_PRIORITIES = ['routine', 'urgent', 'stat', 'portable_stat'] as const;
export type RadPriority = (typeof RAD_PRIORITIES)[number];

export const RAD_SOURCES = [
  'opd',
  'er',
  'ip',
  'icu',
  'ot',
  'walkin',
  'external',
  'health_checkup',
  'portal',
] as const;
export type RadSource = (typeof RAD_SOURCES)[number];

export const LATERALITIES = ['left', 'right', 'bilateral', 'not_applicable'] as const;
export type Laterality = (typeof LATERALITIES)[number];

/**
 * The pregnancy answers OP-008 §3.1.2 admits. `possible` is a real answer and
 * not a synonym for `unknown`: it is the one that puts an ionising exam behind a
 * justification rather than behind a shrug.
 */
export const PREGNANCY_STATUSES = ['unknown', 'no', 'yes', 'possible'] as const;
export type PregnancyStatus = (typeof PREGNANCY_STATUSES)[number];

export const FINDING_LEVELS = ['none', 'incidental', 'urgent', 'critical'] as const;
export type FindingLevel = (typeof FINDING_LEVELS)[number];

export const RAD_NOTIFY_METHODS = ['phone', 'in_person', 'secure_message', 'video', 'pager', 'sms'] as const;
export type RadNotifyMethod = (typeof RAD_NOTIFY_METHODS)[number];

export const SIGN_METHODS = ['system', 'dsc', 'aadhaar_esign', 'webauthn', 'countersign'] as const;
export type SignMethod = (typeof SIGN_METHODS)[number];

export const RECONCILIATION_STATUSES = ['matched', 'needs_review', 'reconciled', 'rejected'] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export const MODALITY_GROUPS = [
  'usg_non_dicom',
  'ecg',
  'tmt',
  'echo',
  'holter',
  'pft',
  'audiometry',
  'eeg',
  'ncv',
  'emg',
  'endoscopy',
  'colonoscopy',
  'bronchoscopy',
  'fundus',
  'oct',
  'dental_xray',
  'dermatoscopy',
  'clinical_photo',
  'external_report',
  'other',
] as const;
export type ModalityGroup = (typeof MODALITY_GROUPS)[number];

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
  /** True for an obstetric ultrasound: the line that needs Form F before completion. */
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

export interface ReadingWorklistItem {
  readonly orderItemId: string;
  readonly orderId: string;
  readonly reportId: string | null;
  readonly accessionNo: string;
  readonly patientId: string;
  readonly procedureName: string;
  readonly modality: string;
  readonly priority: string;
  readonly status: string;
  readonly clinicalIndication: string;
  readonly tatDueAt: string | null;
  readonly orderedAt: string;
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
  /** How the archive matched it: `accession`, `study_uid`, `fallback`, … */
  readonly matchedBy: string;
  readonly reconciliationStatus: string;
  readonly seriesCount: number;
  readonly instanceCount: number;
  /** `bigint` on the wire — a study outgrows `Number.MAX_SAFE_INTEGER`. */
  readonly sizeBytes: string;
  readonly isMlc: boolean;
  readonly legalHold: boolean;
}

export interface ViewerGrantView {
  readonly studyId: string;
  readonly studyInstanceUid: string;
  readonly tokenId: string;
  readonly token: string;
  readonly scope: string;
  readonly purpose: string;
  readonly expiresAt: string;
  readonly breakGlass: boolean;
  /** A reference to the archive object, never pixels: EN-008 owns those. */
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
  /** The PC-PNDT keyword validator's verdict, recorded per version (OP-022 §5). */
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

// ── radiology requests ───────────────────────────────────────────────────────

export interface RadOrderItemRequest {
  readonly procedureKey: string;
  readonly laterality: Laterality;
  readonly contrast: boolean;
  readonly views: readonly string[];
  readonly bodyPartDicom?: string;
}

export interface CreateRadOrderRequest {
  readonly patientId: string;
  readonly visitId?: string;
  readonly encounterId?: string;
  readonly source: RadSource;
  readonly priority: RadPriority;
  /** OP-008 §5: mandatory. An exposure with no question has no justification. */
  readonly clinicalIndication: string;
  readonly questionsToAnswer?: string;
  readonly icdCodes: readonly string[];
  readonly isMlc: boolean;
  readonly items: readonly RadOrderItemRequest[];
}

export interface SafetyScreenRequest {
  readonly pregnancyStatus?: PregnancyStatus;
  readonly lmpDate?: string;
  readonly radiationJustification?: string;
  readonly contrastRequired?: boolean;
  readonly egfr?: number;
  readonly contrastAllergyKnown?: boolean;
  readonly metforminHoldAdvised?: boolean;
  readonly contrastApprovalReason?: string;
  readonly mriSafetyCompleted?: boolean;
  readonly mriUnsafeImplant?: boolean;
  readonly mriOverrideReason?: string;
  readonly sedationRequired?: boolean;
}

/**
 * PC-PNDT Form F, and nothing beyond Form F.
 *
 * The API's `formFSchema` is `.strict()`, so a field this product has no column
 * for is a 400 that names it rather than a silently discarded value. That is the
 * mechanical half of "no sex-determination field exists anywhere"; the other
 * half is the migration's `information_schema` assertion.
 */
export interface FormFRequest {
  readonly patientName: string;
  readonly patientAgeYears: number;
  readonly husbandOrFatherName: string;
  readonly fullAddress: string;
  readonly identityDocumentType: string;
  /** Masked at the door: the register needs a reference, not the number. */
  readonly identityDocumentRefMasked: string;
  readonly gravida?: number;
  readonly para?: number;
  readonly livingChildren?: number;
  readonly previousAbortions?: number;
  readonly gestationalAgeWeeks?: number;
  readonly lastMenstrualPeriod?: string;
  readonly referringDoctorName: string;
  readonly referringDoctorRegistrationNo?: string;
  /** Rule 10: the Form prescribes the lawful indications. "Routine" is not one. */
  readonly indicationCodes: readonly string[];
  readonly indicationOther?: string;
  readonly proceduresPerformed: readonly string[];
  readonly facilityRegistrationNo: string;
  readonly machineRegistrationNo: string;
  readonly performedByName: string;
  readonly performedByRegistrationNo: string;
  readonly performedAt: string;
  readonly womanDeclarationSigned: boolean;
  readonly womanDeclarationDocId?: string;
  readonly doctorDeclarationSigned: boolean;
  readonly doctorDeclarationDocId?: string;
}

export interface CreateRadReportRequest {
  readonly orderItemId: string;
  readonly findingsText?: string;
  readonly impressionText?: string;
  readonly recommendations?: string;
  readonly findingLevel: FindingLevel;
  readonly requestCosign: boolean;
}

export interface UpdateRadReportRequest {
  readonly findingsText?: string;
  readonly impressionText?: string;
  readonly recommendations?: string;
  readonly findingLevel?: FindingLevel;
}

export interface SignRadReportRequest {
  readonly signMethod: SignMethod;
  readonly impressionText?: string;
  readonly findingLevel?: FindingLevel;
}

export interface AmendRadReportRequest {
  readonly reason: string;
  readonly signMethod: SignMethod;
  readonly findingsText?: string;
  readonly impressionText: string;
  readonly recommendations?: string;
  readonly findingLevel: FindingLevel;
}

export interface CriticalFindingRequest {
  readonly level: 'incidental' | 'urgent' | 'critical';
  readonly findingText: string;
  readonly orderingUserId?: string;
  readonly dueInMinutes: number;
}

/**
 * D-10 for imaging. The API expresses it as one object with a refinement rather
 * than as a union, so this mirror keeps the flags and `lib/callback.ts` is what
 * refuses to build the ambiguous middle.
 */
export interface RadCriticalCallbackRequest {
  readonly method: RadNotifyMethod;
  readonly notifiedToName?: string;
  readonly notifiedToRole?: string;
  readonly notifiedToContact?: string;
  readonly readBackConfirmed: boolean;
  readonly readBackValue?: string;
  readonly clinicianUnreachable: boolean;
  readonly escalatedToLevel?: number;
  readonly escalatedToRole?: string;
  readonly attemptCount: number;
  readonly remarks?: string;
}

export interface ReconcileStudyRequest {
  readonly patientId?: string;
  readonly orderItemId?: string;
  readonly note?: string;
}

export interface ViewerTokenRequest {
  readonly action: 'view' | 'download' | 'export' | 'annotate' | 'print';
  readonly scope: 'view' | 'download';
  readonly expiresInMinutes: number;
}

export interface SignInvestigationReportRequest {
  readonly signMethod: SignMethod;
  readonly impression?: string;
  /** OP-022 §5: only a named authorised doctor may override a failed text check. */
  readonly pcpndtOverrideReason?: string;
}

export interface CosignInvestigationReportRequest {
  readonly signMethod: SignMethod;
  readonly discrepancy: 'none' | 'minor' | 'major';
  readonly impression?: string;
}
