/**
 * The shapes this module returns. Read models, deliberately flat: a bench
 * screen, a phlebotomist's tablet and a pathologist's queue all read the same
 * rows, and every one of them is on a class-B or class-C latency budget
 * (`docs/07 §2.1`).
 */

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

/** One label actually printed, so a reprint is visible rather than inferred. */
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

/** One link of the hash chain, re-derived by the database. */
export interface LabResultChainLink {
  readonly version: number;
  readonly status: string;
  readonly hash_matches: boolean;
  readonly link_matches: boolean;
}

export interface LabWorklistItem {
  /** The order line. Named `id` as well so cursor pagination has its key. */
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

export interface LabQcStateView {
  readonly id: string;
  readonly instrument_id: string;
  readonly test_key: string;
  readonly parameter_key: string | null;
  readonly state: string;
  /** `lab.qc_permits_release(state)` — computed by the database, never here. */
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
