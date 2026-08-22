/**
 * The front office's view of `services/api`'s `/api/v1/patients` responses
 * (OP-001 §6).
 *
 * These mirror `services/api/src/modules/opd/patient/patient.types.ts` with one
 * systematic difference, the same one `features/admin/api/types.ts` documents:
 * every `Date` there arrives here as an ISO string, because it crossed JSON.
 * Typing them as `Date` would compile and then fail at the first `.getTime()`.
 *
 * Column names stay `snake_case` where the API returns them that way; the
 * conversion to counter vocabulary happens in the cell renderer.
 *
 * **There is no Aadhaar field anywhere in this file.** The register schema
 * accepts none, the detail carries only `aadhaar_last4` for a record that was
 * e-KYC'd by EN-011 elsewhere, and this desk never sends one — see
 * `registration-form.ts`.
 */

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export type Gender = 'male' | 'female' | 'other' | 'unknown';

/**
 * The four-arm allergy statement, exactly as `patient.PatientAllergyStatement`
 * declares it. `docs/06` §10: an empty allergy area that could mean "none" or
 * "not asked" is the defect this enum exists to prevent, so the UI never
 * collapses these four into a boolean.
 */
export type AllergyStatementCode = 'not_recorded' | 'unable_to_assess' | 'none_known' | 'known';

export interface PatientListItem {
  readonly id: string;
  readonly uhid: string;
  readonly full_name: string;
  readonly gender: string;
  readonly dob: string | null;
  readonly dob_is_estimated: boolean;
  readonly age_years: number | null;
  readonly mobile: string;
  readonly category: string;
  readonly status: string;
  /** Non-null on a merged record: follow it (OP-001 §3.8, the UHID alias). */
  readonly merged_into_id: string | null;
  readonly branch_id: string;
  readonly last_visit_at: string | null;
  readonly registered_at: string;
  readonly created_at: string;
}

export interface PatientIdentifierRow {
  readonly id: string;
  readonly type: string;
  readonly id_type_code: string | null;
  readonly value_masked: string;
  readonly issued_by: string | null;
  readonly verified_at: string | null;
  readonly source: string;
  readonly is_primary: boolean;
}

export interface PatientContactRow {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly relationship_code: string | null;
  readonly phone: string;
  readonly is_guardian: boolean;
  readonly is_primary: boolean;
}

export interface PatientAlertRow {
  readonly id: string;
  readonly type: string;
  readonly severity: string;
  readonly label: string;
  readonly detail: string | null;
  readonly acknowledged_at: string | null;
}

export interface PatientAllergyRow {
  readonly id: string;
  readonly category: string;
  readonly substance_text: string;
  readonly criticality: string;
  readonly severity: string;
  readonly status: string;
}

export interface PatientBannerData {
  readonly uhid: string;
  readonly full_name: string;
  readonly gender: string;
  readonly age_display: string;
  readonly blood_group: string;
  readonly photo_file_id: string | null;
  readonly allergy_statement: AllergyStatementCode;
  readonly allergy_asserted_at: string | null;
  readonly allergy_unable_reason: string | null;
  readonly allergies: readonly PatientAllergyRow[];
  readonly alerts: readonly PatientAlertRow[];
  readonly is_vip: boolean;
  readonly is_deceased: boolean;
  readonly status: string;
  readonly merged_into_id: string | null;
}

export interface PatientDetail extends PatientListItem {
  readonly mpi_group_id: string | null;
  readonly title_code: string | null;
  readonly first_name: string;
  readonly middle_name: string | null;
  readonly last_name: string | null;
  readonly local_name: string | null;
  readonly age_months: number | null;
  readonly age_days: number | null;
  readonly blood_group: string;
  readonly marital_status: string | null;
  readonly allergy_statement: AllergyStatementCode;
  readonly allergy_asserted_by: string | null;
  readonly allergy_asserted_at: string | null;
  readonly allergy_unable_reason: string | null;
  readonly mobile_verified_at: string | null;
  readonly alt_phone: string | null;
  readonly email: string | null;
  readonly whatsapp_opt_in: boolean;
  readonly preferred_language: string;
  readonly nationality_code: string;
  readonly religion_code: string | null;
  readonly occupation_code: string | null;
  readonly id_type_code: string | null;
  readonly id_last4: string | null;
  /**
   * Set only by EN-011's licensed e-KYC path, never by this desk. Rendered as
   * provenance on Patient 360; there is no input anywhere that can write it.
   */
  readonly aadhaar_last4: string | null;
  readonly aadhaar_kyc_verified_at: string | null;
  readonly abha_number: string | null;
  readonly abha_address: string | null;
  readonly abha_linked_at: string | null;
  readonly photo_file_id: string | null;
  readonly address_line1: string | null;
  readonly address_line2: string | null;
  readonly city: string | null;
  readonly district: string | null;
  readonly state: string | null;
  readonly country_code: string;
  readonly pincode: string | null;
  readonly payer_type: string;
  readonly payer_ref: string | null;
  readonly referral_source_code: string | null;
  readonly referred_by_text: string | null;
  readonly is_vip: boolean;
  readonly is_staff: boolean;
  readonly is_differently_abled: boolean;
  readonly is_pregnant: boolean;
  readonly is_deceased: boolean;
  readonly deceased_at: string | null;
  readonly source_channel: string;
  readonly created_override_reason: string | null;
  readonly merged_at: string | null;
  readonly version: number;

  readonly identifiers: readonly PatientIdentifierRow[];
  readonly contacts: readonly PatientContactRow[];
  readonly banner: PatientBannerData;
}

export interface DemographicHistoryItem {
  readonly id: string;
  readonly changed_fields: readonly string[];
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string;
  readonly channel: string;
  readonly changed_by: string | null;
  readonly changed_at: string;
  readonly audit_id: string | null;
}

export interface DedupeCandidateItem {
  readonly id: string;
  readonly patient_a_id: string;
  readonly patient_a_uhid: string;
  readonly patient_a_name: string;
  readonly patient_b_id: string;
  readonly patient_b_uhid: string;
  readonly patient_b_name: string;
  /** `numeric(4,3)` crosses JSON as a string; parse it, never `Number(row)` blindly. */
  readonly score: string;
  readonly rule_hits: unknown;
  readonly detected_by: string;
  readonly status: string;
  readonly reviewed_by: string | null;
  readonly reviewed_at: string | null;
  readonly merge_id: string | null;
  readonly created_at: string;
}

export interface MergeImpactRow {
  readonly table: string;
  readonly rows: number;
}

/** What step one of the merge produces, and step two consumes (OP-001 §5). */
export interface MergePreview {
  readonly mergeId: string;
  readonly status: string;
  readonly survivorId: string;
  readonly survivorUhid: string;
  readonly victimId: string;
  readonly victimUhid: string;
  readonly reason: string;
  readonly unmergeDeadline: string;
  readonly impact: readonly MergeImpactRow[];
}

export interface MergeResult extends MergePreview {
  readonly mergedAt: string;
  readonly repointed: readonly MergeImpactRow[];
}

export interface UnmergeResult {
  readonly mergeId: string;
  readonly survivorId: string;
  readonly victimId: string;
  readonly victimUhid: string;
  readonly unmergedAt: string;
  readonly restored: readonly MergeImpactRow[];
}

/** `GET /visits?patientId=` — OP-001 §6, permission `visit.list`. */
export interface VisitListItem {
  readonly id: string;
  readonly visit_no: string;
  readonly patient_id: string;
  readonly appointment_id: string | null;
  readonly practitioner_key: string | null;
  readonly department_key: string | null;
  readonly visit_type: string;
  readonly payer_type: string;
  readonly status: string;
  readonly token_display: string | null;
  readonly source_channel: string;
  readonly checked_in_at: string;
  readonly consult_started_at: string | null;
  readonly closed_at: string | null;
  readonly cancelled_at: string | null;
}
