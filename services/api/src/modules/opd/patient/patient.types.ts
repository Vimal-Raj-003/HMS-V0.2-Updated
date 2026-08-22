/**
 * The shapes this module returns. Deliberately hand-written rather than
 * generated from Prisma: what an API returns is a contract with the browser and
 * with the other services, and it must not change silently because a column was
 * added to a table.
 *
 * Column names stay `snake_case` here, matching the rest of `services/api` —
 * `docs/03` keeps the database's naming and the API layer maps it once, at the
 * edge, rather than in every query.
 */

export interface PatientListItem {
  readonly id: string;
  readonly uhid: string;
  readonly full_name: string;
  readonly gender: string;
  readonly dob: Date | null;
  readonly dob_is_estimated: boolean;
  readonly age_years: number | null;
  readonly mobile: string;
  readonly category: string;
  readonly status: string;
  /** Non-null on a merged record: follow it (OP-001 §3.8, the UHID alias). */
  readonly merged_into_id: string | null;
  readonly branch_id: string;
  readonly last_visit_at: Date | null;
  readonly registered_at: Date;
  readonly created_at: Date;
}

export interface PatientIdentifierRow {
  readonly id: string;
  readonly type: string;
  readonly id_type_code: string | null;
  readonly value_masked: string;
  readonly issued_by: string | null;
  readonly verified_at: Date | null;
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
  readonly acknowledged_at: Date | null;
}

export interface PatientAllergyRow {
  readonly id: string;
  readonly category: string;
  readonly substance_text: string;
  readonly criticality: string;
  readonly severity: string;
  readonly status: string;
}

/**
 * The safety banner (`docs/06` §PatientBanner). It is assembled server-side and
 * returned with the record so the banner cannot render before the allergy state
 * is known — a banner that appears without its allergy strip, even for one
 * frame, is a prescriber reading "no allergies" off a loading state.
 */
export interface PatientBanner {
  readonly uhid: string;
  readonly full_name: string;
  readonly gender: string;
  readonly age_display: string;
  readonly blood_group: string;
  readonly photo_file_id: string | null;
  readonly allergy_statement: string;
  readonly allergy_asserted_at: Date | null;
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
  readonly allergy_statement: string;
  readonly allergy_asserted_by: string | null;
  readonly allergy_asserted_at: Date | null;
  readonly allergy_unable_reason: string | null;
  readonly mobile_verified_at: Date | null;
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
   * The only two forms of Aadhaar that exist anywhere in this system. The hash
   * itself never leaves the database.
   */
  readonly aadhaar_last4: string | null;
  readonly aadhaar_kyc_verified_at: Date | null;
  readonly abha_number: string | null;
  readonly abha_address: string | null;
  readonly abha_linked_at: Date | null;
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
  readonly deceased_at: Date | null;
  readonly source_channel: string;
  readonly created_override_reason: string | null;
  readonly merged_at: Date | null;
  readonly version: number;

  readonly identifiers: readonly PatientIdentifierRow[];
  readonly contacts: readonly PatientContactRow[];
  readonly banner: PatientBanner;
}

export interface DemographicHistoryItem {
  readonly id: string;
  readonly changed_fields: readonly string[];
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string;
  readonly channel: string;
  readonly changed_by: string | null;
  readonly changed_at: Date;
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
  readonly score: string;
  readonly rule_hits: unknown;
  readonly detected_by: string;
  readonly status: string;
  readonly reviewed_by: string | null;
  readonly reviewed_at: Date | null;
  readonly merge_id: string | null;
  readonly created_at: Date;
}

/** What step one of the merge produces, and step two consumes. */
export interface MergePreview {
  readonly mergeId: string;
  readonly status: string;
  readonly survivorId: string;
  readonly survivorUhid: string;
  readonly victimId: string;
  readonly victimUhid: string;
  readonly reason: string;
  readonly unmergeDeadline: Date;
  /** Rows this module will move, by table. Other modules act on the event. */
  readonly impact: readonly { readonly table: string; readonly rows: number }[];
}

export interface MergeResult extends MergePreview {
  readonly mergedAt: Date;
  readonly repointed: readonly { readonly table: string; readonly rows: number }[];
}

export interface UnmergeResult {
  readonly mergeId: string;
  readonly survivorId: string;
  readonly victimId: string;
  readonly victimUhid: string;
  readonly unmergedAt: Date;
  readonly restored: readonly { readonly table: string; readonly rows: number }[];
}
