import type { CdssFamily, CdssInterruption, CdssSeverity } from './cdss.engine.js';

/** One alert as the client renders it, and as it is snapshotted onto the line. */
export interface AlertView {
  readonly alertEventId: string;
  readonly firedAt: string;
  readonly lineNo: number;
  readonly family: CdssFamily;
  readonly severity: CdssSeverity;
  readonly interruption: CdssInterruption;
  readonly safetyFloorKey: string | null;
  readonly title: string;
  readonly detail: string;
  readonly suggestedAction: string;
  readonly subjectCode: string;
  /** Set when the alert was answered inline with a coded reason. */
  readonly overrideReasonCode: string | null;
  /** True for a hard stop that a countersignature had already cleared. */
  readonly cleared: boolean;
}

export interface EvaluationView {
  readonly alerts: readonly AlertView[];
  readonly blocking: readonly AlertView[];
  readonly needsCodedReason: readonly AlertView[];
  readonly degraded: boolean;
  readonly degradedFamilies: readonly string[];
  readonly snapshotDigest: string;
  readonly latencyMs: number;
  readonly ruleLatencyMs: number;
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

/** Exit gate 8: the fatigue numbers a governance committee can act on. */
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
