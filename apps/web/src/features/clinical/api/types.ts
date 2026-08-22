/**
 * The wire shapes of the Phase-2 clinical API, as the browser receives them.
 *
 * Mirrored here rather than imported for the reason `features/frontoffice/api/types.ts`
 * gives and for the reason the API's own schema files give: the request and
 * response contracts still live inside `services/api/src/modules/opd/**`, and
 * those files say so themselves ("they live here … when the vitals station
 * screen is built they should move"). `packages/*` is outside this change's
 * remit, so the shapes are mirrored **verbatim**, including the `snake_case`
 * column names the API returns unchanged. Lifting them into
 * `packages/contracts` and deleting this file is the follow-up.
 *
 * Two conventions kept from the API:
 *
 *  - **Timestamps arrive as ISO-8601 strings.** The service types say `Date`;
 *    JSON has no date type, so what `fetch` yields is a string. Typing them as
 *    `Date` compiles and then produces `undefined` at every `.getTime()`.
 *  - **Decimals arrive as strings** (`temperature_c`, `weight_kg`, `bmi`,
 *    `dosing_weight_kg`). `pg` returns `numeric` as text so that 36.6 is not
 *    rounded through IEEE-754 on the way to a chart axis. Every one of them is
 *    parsed exactly once, in `lib/numbers.ts`.
 */

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

// ── vitals (OP-007 §6) ───────────────────────────────────────────────────────

export type VitalFlag = 'normal' | 'abnormal' | 'critical';

export const VITALS_CONTEXTS = [
  'opd_vitals_room',
  'er_triage',
  'ward',
  'icu',
  'daycare',
  'ot',
  'home',
  'kiosk',
  'telemed_self',
] as const;
export type VitalsContext = (typeof VITALS_CONTEXTS)[number];

export const GLUCOSE_TYPES = ['rbs', 'fbs', 'ppbs', 'hba1c_poc'] as const;
export type GlucoseType = (typeof GLUCOSE_TYPES)[number];

export const AVPU_LEVELS = ['alert', 'confusion', 'voice', 'pain', 'unresponsive'] as const;
export type AvpuLevel = (typeof AVPU_LEVELS)[number];

export const VITALS_ALERT_ACTIONS = ['repeat', 'doctor_informed', 'sent_to_er', 'none'] as const;
export type VitalsAlertAction = (typeof VITALS_ALERT_ACTIONS)[number];

export interface VitalsRow {
  readonly id: string;
  readonly patient_id: string;
  readonly visit_id: string | null;
  readonly encounter_id: string | null;
  readonly context: string;
  readonly recorded_at: string;
  readonly recorded_by: string;
  readonly station_id: string | null;
  readonly systolic: number | null;
  readonly diastolic: number | null;
  readonly pulse: number | null;
  readonly spo2: number | null;
  readonly on_oxygen: boolean;
  readonly copd_scale2: boolean;
  readonly temperature_c: string | null;
  readonly resp_rate: number | null;
  readonly glucose_mgdl: string | null;
  readonly glucose_type: string | null;
  readonly height_cm: string | null;
  readonly weight_kg: string | null;
  readonly bmi: string | null;
  readonly pain_score: number | null;
  readonly avpu: string | null;
  readonly gcs_total: number | null;
  readonly lmp_date: string | null;
  readonly pregnancy_status: string;
  readonly news2_score: number | null;
  readonly news2_band: string | null;
  /** `{parameter: normal|abnormal|critical}` — the server's verdict, never the client's. */
  readonly flags: Readonly<Record<string, string>>;
  readonly overall_flag: string;
  readonly source: string;
  readonly notes: string | null;
  readonly repeat_of_id: string | null;
  readonly corrects_id: string | null;
  readonly corrected_reason: string | null;
  readonly superseded_at: string | null;
  readonly version: number;
}

export interface VitalsAlertView {
  readonly id: string;
  readonly level: string;
  readonly parameters: readonly string[];
  readonly notified_doctor_id: string | null;
  readonly acknowledged_at: string | null;
  readonly acknowledged_by: string | null;
  readonly action_taken: string;
  readonly note: string | null;
}

export interface VitalsDetail extends VitalsRow {
  readonly alerts: readonly VitalsAlertView[];
}

/**
 * One row of `clinical.vitals_reference_ranges`, as `GET /vitals/reference-ranges`
 * returns it.
 *
 * The API types this route as `Page<Record<string, unknown>>` because the
 * service selects columns dynamically. The columns it selects are fixed, so the
 * shape is named here and parsed defensively in `lib/ranges.ts` — an unexpected
 * row is dropped rather than trusted, because a half-parsed band is worse than
 * no band.
 */
export interface ReferenceRangeRow {
  readonly id: string;
  readonly parameter: string;
  readonly age_min_days: number;
  readonly age_max_days: number;
  readonly sex: string;
  readonly pregnancy: string | null;
  readonly scale: number | null;
  readonly low_abnormal: string | number | null;
  readonly high_abnormal: string | number | null;
  readonly low_critical: string | number | null;
  readonly high_critical: string | number | null;
  readonly low_plausible: string | number | null;
  readonly high_plausible: string | number | null;
  readonly unit: string;
}

/** `POST /vitals/records`. Every measurement is optional: a nurse saves what they took. */
export interface CreateVitalsRequest {
  readonly patientId: string;
  readonly visitId?: string;
  readonly encounterId?: string;
  readonly context?: VitalsContext;
  readonly repeatOfId?: string;
  readonly systolic?: number;
  readonly diastolic?: number;
  readonly pulse?: number;
  readonly spo2?: number;
  readonly onOxygen?: boolean;
  readonly copdScale2?: boolean;
  readonly temperatureC?: number;
  readonly respRate?: number;
  readonly glucoseMgdl?: number;
  readonly glucoseType?: GlucoseType;
  readonly heightCm?: number;
  readonly weightKg?: number;
  readonly painScore?: number;
  readonly avpu?: AvpuLevel;
  readonly notes?: string;
  readonly assessment?: {
    readonly allergiesVerified?: boolean;
    readonly medicationsReconciled?: boolean;
    readonly chiefComplaintText?: string;
    readonly remarks?: string;
    readonly notDoneReason?: string;
  };
}

export interface AcknowledgeVitalsAlertRequest {
  readonly actionTaken: VitalsAlertAction;
  readonly note?: string;
  readonly patientInformed?: boolean;
}

export interface RecheckRequest {
  readonly patientId: string;
  readonly visitId?: string;
  readonly vitalsId?: string;
  readonly parameters: readonly string[];
  readonly note?: string;
}

// ── encounters (OP-002 §6) ───────────────────────────────────────────────────

export interface DiagnosisRow {
  readonly id: string;
  readonly code_system_key: string;
  readonly code: string;
  readonly description: string;
  readonly rank: string;
  readonly certainty: string;
  readonly severity: string | null;
  readonly laterality: string;
  readonly is_chronic: boolean;
  readonly is_notifiable: boolean;
  readonly problem_id: string | null;
  readonly coding_status: string;
}

export interface EncounterRow {
  readonly id: string;
  readonly patient_id: string;
  readonly visit_id: string | null;
  readonly practitioner_key: string | null;
  readonly doctor_user_id: string | null;
  readonly department_key: string | null;
  readonly type: string;
  readonly status: string;
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly cancelled_at: string | null;
  readonly cancel_reason: string | null;
  readonly active_seconds: number;
  readonly chief_complaint_text: string | null;
  readonly chief_complaint_codes: readonly string[];
  readonly treatment_plan: string | null;
  readonly advice: string | null;
  readonly follow_up_date: string | null;
  readonly no_diagnosis_reason: string | null;
  readonly dosing_weight_kg: string | null;
  readonly dosing_weight_source: string;
  readonly dosing_weight_at: string | null;
  readonly dosing_weight_by: string | null;
  readonly dosing_weight_vitals_id: string | null;
  readonly cosign_required: boolean;
  readonly signed_document_id: string | null;
  readonly version: number;
}

export interface EncounterDetail extends EncounterRow {
  readonly diagnoses: readonly DiagnosisRow[];
  readonly note: Record<string, unknown> | null;
  readonly note_document_id: string | null;
  readonly note_version: number | null;
  readonly note_status: string | null;
  readonly break_glass: boolean;
}

export interface DocumentVersionView {
  readonly version: number;
  readonly status: string;
  readonly content: Record<string, unknown>;
  readonly content_text: string | null;
  readonly content_sha256: string;
  readonly prev_sha256: string | null;
  readonly signed_by: string | null;
  readonly signed_at: string | null;
  readonly sign_method: string | null;
  readonly signer_registration_no: string | null;
  readonly amendment_reason: string | null;
  readonly superseded_by_version: number | null;
  readonly superseded_at: string | null;
  readonly created_at: string;
  readonly created_by: string | null;
}

export interface ChainVerification {
  readonly valid: boolean;
  readonly versions: readonly {
    readonly version: number;
    readonly status: string;
    readonly hash_matches: boolean;
    readonly link_matches: boolean;
  }[];
}

export interface NoteHistory {
  readonly documentId: string;
  readonly versions: readonly DocumentVersionView[];
  readonly chain: ChainVerification;
}

export interface DosingContext {
  readonly encounterId: string;
  readonly weightKg: number | null;
  readonly source: string;
  readonly assertedAt: string | null;
  readonly assertedBy: string | null;
  readonly vitalsId: string | null;
  readonly doseMg: number;
}

export interface UpdateEncounterRequest {
  /** The optimistic lock. A save that loses is told, never silently discarded. */
  readonly version: number;
  readonly chiefComplaintText?: string;
  readonly treatmentPlan?: string;
  readonly advice?: string;
  readonly followUpDate?: string;
  readonly noDiagnosisReason?: string;
  readonly note?: Record<string, unknown>;
}

export const DIAGNOSIS_RANKS = ['primary', 'secondary'] as const;
export type DiagnosisRank = (typeof DIAGNOSIS_RANKS)[number];

export const DIAGNOSIS_CERTAINTIES = ['provisional', 'confirmed', 'rule_out', 'chronic'] as const;
export type DiagnosisCertainty = (typeof DIAGNOSIS_CERTAINTIES)[number];

export const LATERALITIES = ['left', 'right', 'bilateral', 'not_applicable'] as const;
export type Laterality = (typeof LATERALITIES)[number];

export interface DiagnosisInput {
  readonly codeSystemKey: 'ICD10' | 'ICD11' | 'SNOMEDCT';
  readonly code: string;
  readonly description: string;
  readonly rank: DiagnosisRank;
  readonly certainty: DiagnosisCertainty;
  readonly laterality: Laterality;
  readonly isChronic?: boolean;
}

export interface CompleteEncounterRequest {
  readonly note?: Record<string, unknown>;
  readonly signMethod?: 'system' | 'dsc' | 'aadhaar_esign' | 'webauthn';
  readonly followUpDate?: string;
  readonly noDiagnosisReason?: string;
}

export interface AmendEncounterRequest {
  readonly reason: string;
  readonly note: Record<string, unknown>;
  readonly signMethod?: 'system' | 'dsc' | 'aadhaar_esign' | 'webauthn';
}

// ── patient clinical record (OP-002 §6) ──────────────────────────────────────

export interface TimelineItem {
  readonly id: string;
  readonly kind: string;
  readonly occurred_at: string;
  readonly title: string;
  readonly detail: Record<string, unknown>;
}

export interface ProblemItem {
  readonly id: string;
  readonly code_system_key: string;
  readonly code: string;
  readonly description: string;
  readonly status: string;
  readonly onset_date: string | null;
  readonly is_chronic: boolean;
  readonly source_encounter_id: string | null;
}

export interface MedicationItem {
  readonly id: string;
  readonly drug_key: string | null;
  readonly drug_text: string;
  readonly atc_code: string | null;
  readonly dose_text: string | null;
  readonly frequency_code: string | null;
  readonly route: string | null;
  readonly source: string;
  readonly status: string;
  readonly started_at: string | null;
  readonly stopped_at: string | null;
}

export interface AllergyItem {
  readonly id: string;
  readonly category: string;
  readonly substance_text: string;
  readonly substance_code: string | null;
  readonly reaction: readonly string[];
  readonly criticality: string;
  readonly severity: string;
  readonly status: string;
  readonly verification: string;
  readonly recorded_by: string;
  readonly recorded_at: string;
}

export const ALLERGY_CATEGORIES = ['drug', 'food', 'environment', 'latex', 'biologic', 'other'] as const;
export type AllergyCategory = (typeof ALLERGY_CATEGORIES)[number];

export const ALLERGY_SEVERITIES = ['mild', 'moderate', 'severe', 'anaphylaxis'] as const;
export type AllergySeverityCode = (typeof ALLERGY_SEVERITIES)[number];

export interface RecordAllergyRequest {
  readonly category: AllergyCategory;
  readonly substanceText: string;
  readonly reaction?: readonly string[];
  readonly reactionText?: string;
  readonly severity: AllergySeverityCode;
  readonly criticality?: 'low' | 'high' | 'unable_to_assess';
  readonly informant?: 'patient' | 'family' | 'practitioner' | 'record' | 'unknown';
  readonly verification?: 'unconfirmed' | 'confirmed' | 'refuted';
  readonly notes?: string;
}

// ── prescribing and CDSS (OP-002 §6, EN-029 §6) ──────────────────────────────

export type CdssFamily =
  | 'allergy'
  | 'ddi'
  | 'drug_disease'
  | 'duplicate_therapy'
  | 'dose_range'
  | 'pregnancy'
  | 'geriatric'
  | 'paediatric_weight'
  | 'schedule_guardrail';

export type CdssInterruption = 'passive' | 'soft_stop' | 'hard_stop' | 'shadow';

export type CdssSeverity = 'info' | 'low' | 'moderate' | 'major' | 'contraindicated';

export interface AlertView {
  readonly alertEventId: string;
  readonly firedAt: string;
  readonly lineNo: number;
  readonly family: CdssFamily;
  readonly severity: CdssSeverity;
  readonly interruption: CdssInterruption;
  /** Non-null on a product-level floor rule — the ones configuration can never disable. */
  readonly safetyFloorKey: string | null;
  readonly title: string;
  readonly detail: string;
  readonly suggestedAction: string;
  readonly subjectCode: string;
  readonly overrideReasonCode: string | null;
  /** True for a hard stop a countersignature had already cleared. */
  readonly cleared: boolean;
}

export interface EvaluationView {
  readonly alerts: readonly AlertView[];
  /** Hard stops that are not cleared. While this is non-empty, nothing may be submitted. */
  readonly blocking: readonly AlertView[];
  readonly needsCodedReason: readonly AlertView[];
  readonly degraded: boolean;
  readonly degradedFamilies: readonly string[];
  readonly snapshotDigest: string;
  readonly latencyMs: number;
  readonly ruleLatencyMs: number;
}

export const DOSE_BASES = ['flat', 'per_kg', 'per_m2'] as const;
export type DoseBasis = (typeof DOSE_BASES)[number];

export const TIMINGS = ['before_food', 'after_food', 'with_food', 'empty_stomach', 'bedtime', 'any'] as const;
export type Timing = (typeof TIMINGS)[number];

export const DURATION_UNITS = ['days', 'weeks', 'months', 'continuous'] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

/** A clinician's coded answer to one soft stop, carried on the line it belongs to. */
export interface OverrideInput {
  readonly family: string;
  /** Required. Free text alone is refused by the API, so it is never offered alone. */
  readonly reasonCode: string;
  readonly note?: string;
}

export interface PrescriptionLineRequest {
  readonly drugKey?: string;
  readonly genericName?: string;
  readonly doseQty?: number;
  readonly doseUnit?: string;
  readonly doseBasis?: DoseBasis;
  readonly frequencyCode?: string;
  readonly timing?: Timing;
  readonly durationValue?: number;
  readonly durationUnit?: DurationUnit;
  readonly quantity?: number;
  readonly instructionsText?: string;
  readonly isPrn?: boolean;
  readonly overrides?: readonly OverrideInput[];
}

export interface CreatePrescriptionRequest {
  readonly patientId: string;
  readonly encounterId?: string;
  readonly visitId?: string;
  readonly notes?: string;
  readonly requestCosign?: boolean;
  readonly items: readonly PrescriptionLineRequest[];
}

export interface EvaluateRequest {
  readonly patientId: string;
  readonly encounterId?: string;
  readonly items: readonly PrescriptionLineRequest[];
}

export interface PrescriptionItemView {
  readonly id: string;
  readonly line_no: number;
  readonly drug_key: string | null;
  readonly generic_name: string;
  readonly brand_name: string | null;
  readonly strength_text: string | null;
  readonly dose_qty: number | null;
  readonly dose_unit: string | null;
  readonly dose_basis: string;
  readonly weight_used_kg: number | null;
  readonly computed_dose_qty: number | null;
  readonly frequency_code: string | null;
  readonly timing: string | null;
  readonly duration_value: number | null;
  readonly duration_unit: string | null;
  readonly quantity: number | null;
  readonly is_prn: boolean;
  readonly schedule_class: string | null;
  readonly hard_stop_fired: boolean;
  readonly status: string;
  readonly cdss_alerts: readonly AlertView[];
}

export interface PrescriptionView {
  readonly id: string;
  readonly rx_no: string | null;
  readonly patient_id: string;
  readonly encounter_id: string | null;
  readonly status: string;
  readonly revision: number;
  readonly supersedes_id: string | null;
  readonly superseded_by_id: string | null;
  readonly amendment_reason: string | null;
  readonly is_provisional: boolean;
  readonly cosign_required: boolean;
  readonly cosigned_by: string | null;
  readonly signed_at: string | null;
  readonly signed_by: string | null;
  readonly signer_registration_no: string | null;
  readonly cdss_degraded: boolean;
  readonly cdss_degraded_families: readonly string[];
  readonly emergency_mode: boolean;
  readonly items: readonly PrescriptionItemView[];
}

export interface DrugSearchResult {
  readonly record_key: string;
  readonly code: string;
  readonly generic_name: string;
  readonly brand_name: string | null;
  readonly strength_text: string | null;
  readonly form: string | null;
  readonly route: string | null;
  readonly schedule: string;
  readonly is_high_alert: boolean;
  readonly is_lasa: boolean;
  readonly tall_man_display: string | null;
  readonly in_formulary: boolean;
}

export const ALERT_RESPONSES = ['acknowledged', 'overridden', 'order_changed', 'order_abandoned'] as const;
export type AlertResponseKind = (typeof ALERT_RESPONSES)[number];

export interface AlertResponseRequest {
  /** Both halves of the alert's composite key; the table is partitioned by time. */
  readonly firedAt: string;
  readonly kind: AlertResponseKind;
  readonly reasonCode?: string;
  readonly note?: string;
}

export interface AlertListItem {
  readonly id: string;
  readonly fired_at: string;
  readonly patient_id: string;
  readonly encounter_id: string | null;
  readonly safety_floor_key: string | null;
  readonly family: string;
  readonly severity: string;
  readonly interruption: string;
  readonly outcome: string;
  readonly title: string;
  readonly latency_ms: number | null;
  readonly degraded: boolean;
  readonly context_ref: Record<string, unknown>;
  readonly action_kind: string | null;
  readonly override_reason_code: string | null;
}

export interface AlertFatigueReport {
  readonly windowDays: number;
  readonly fires: number;
  readonly displays: number;
  readonly blocks: number;
  readonly overrides: number;
  readonly acknowledgements: number;
  readonly overrideRatePct: number;
  readonly alertsPer1000Orders: number;
  readonly ordersEvaluated: number;
  readonly overridesByReason: Readonly<Record<string, number>>;
  readonly byFamily: readonly {
    readonly family: string;
    readonly fires: number;
    readonly overrides: number;
    readonly blocks: number;
  }[];
}

// ── CPOE (OP-002 §3.4) ───────────────────────────────────────────────────────

export const ORDER_CATEGORIES = [
  'lab',
  'radiology',
  'procedure',
  'nursing',
  'referral',
  'admission',
  'diet',
  'physio',
  'therapy',
  'other',
] as const;
export type OrderCategory = (typeof ORDER_CATEGORIES)[number];

export const ORDER_PRIORITIES = ['routine', 'urgent', 'stat'] as const;
export type OrderPriority = (typeof ORDER_PRIORITIES)[number];

export interface OrderItemView {
  readonly id: string;
  readonly line_no: number;
  readonly service_key: string | null;
  readonly service_name: string;
  readonly qty: number;
  readonly laterality: string;
  readonly contrast: boolean;
  readonly fasting_required: boolean;
  readonly status: string;
  readonly charge_intent_id: string | null;
  readonly price_snapshot: number | null;
}

export interface OrderView {
  readonly id: string;
  readonly order_no: string | null;
  readonly patient_id: string;
  readonly encounter_id: string | null;
  readonly category: string;
  readonly priority: string;
  readonly status: string;
  readonly billing_status: string;
  readonly clinical_notes: string | null;
  readonly pregnancy_status: string | null;
  readonly placed_at: string | null;
  readonly cancel_reason: string | null;
  readonly items: readonly OrderItemView[];
}

export interface CreateOrderRequest {
  readonly patientId: string;
  readonly encounterId?: string;
  readonly category: OrderCategory;
  readonly priority: OrderPriority;
  readonly clinicalNotes?: string;
  readonly items: readonly {
    readonly serviceName: string;
    readonly qty?: number;
    readonly laterality?: Laterality;
    readonly fastingRequired?: boolean;
  }[];
}
