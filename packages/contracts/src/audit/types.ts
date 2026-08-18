/**
 * Audit contract (EN-024).
 *
 * `EN-024 §3.1.2`: "Writing audit is **not optional and not asynchronous** for
 * clinical/financial mutations — if the audit insert fails, the transaction fails."
 * `EN-024 §5`: "**No audit, no mutation.**"
 *
 * The types here are what the in-transaction audit helper takes, so a developer
 * cannot construct a valid audit write without supplying an actor, an entity and
 * a diff.
 */
import { z } from 'zod';

/** `EN-024 §4` `audit_log.action`. */
export const auditActionSchema = z.enum([
  'insert',
  'update',
  'delete',
  'read_phi',
  'export',
  'print',
  'login',
  'logout',
  'approve',
  'reject',
  'sign',
  'override',
  'break_glass',
  'config_change',
]);

export type AuditAction = z.infer<typeof auditActionSchema>;

export const actorTypeSchema = z.enum(['user', 'service', 'device', 'system', 'patient', 'external_app']);
export type ActorType = z.infer<typeof actorTypeSchema>;

export const dataClassSchema = z.enum(['phi', 'financial', 'hr', 'operational']);
export const sensitivitySchema = z.enum(['normal', 'sensitive', 'vip']);
export const auditResultSchema = z.enum(['success', 'denied', 'error']);

/**
 * `EN-024 §5`: "Reason is **mandatory** for: break-glass access, PHI export/print,
 * deletion/cancellation of clinical or financial records, discount/refund approval
 * beyond policy, override of a hard-stop, impersonation, and configuration changes
 * flagged sensitive."
 */
export const REASON_REQUIRED_ACTIONS: readonly AuditAction[] = Object.freeze([
  'break_glass',
  'export',
  'delete',
  'override',
]);

/** Structured reason codes so the register is analysable, not a free-text swamp. */
export const breakGlassReasonCodeSchema = z.enum([
  'emergency_cross_cover',
  'on_call_consult',
  'code_blue',
  'patient_request',
  'second_opinion',
  'quality_review',
  'medico_legal',
  'other',
]);

export type BreakGlassReasonCode = z.infer<typeof breakGlassReasonCodeSchema>;

/** What the in-transaction helper needs. Nothing here is optional by accident. */
export interface AuditWriteInput {
  readonly action: AuditAction;
  /** `schema.table` — the physical entity, so a diff can always be located. */
  readonly entity: string;
  readonly rowId: string | null;
  /** Human-facing key (UHID, bill no, order no) so an investigator can search it. */
  readonly businessKey: string | null;
  readonly dataClass: z.infer<typeof dataClassSchema>;
  /** Changed columns only, already masked per `audit_field_policies`. */
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly patientId?: string | null;
  readonly encounterId?: string | null;
  readonly reasonCode?: string | null;
  readonly reasonText?: string | null;
  readonly sensitivity?: z.infer<typeof sensitivitySchema>;
  readonly result?: z.infer<typeof auditResultSchema>;
  readonly denialReason?: string | null;
  /** For exports and list reads: the count and filter, not every identifier. */
  readonly rowCount?: number | null;
  readonly artifactSha256?: string | null;
}

/**
 * `EN-024 §3.1.4`: "Sensitive values are **masked in the diff** by column policy
 * (passwords, tokens, API keys → `«redacted»`; Aadhaar/ABHA → masked; biometric
 * templates never appear at all)."
 *
 * The seed set below is applied by the diff builder before anything is written,
 * so a developer who forgets cannot leak a secret into the audit table — which is
 * the one table nobody can go back and clean up.
 */
export type MaskMode = 'none' | 'redact' | 'mask_partial' | 'exclude';

export interface AuditFieldPolicy {
  /** `schema.table` or `*` for every table. */
  readonly entity: string;
  readonly column: string;
  readonly mask: MaskMode;
  readonly dataClass: z.infer<typeof dataClassSchema>;
  readonly reasonRequired: boolean;
  readonly note?: string;
}

export const REDACTION_PLACEHOLDER = '«redacted»';

export const DEFAULT_AUDIT_FIELD_POLICIES: readonly AuditFieldPolicy[] = Object.freeze([
  // Secrets — never recorded, not even masked.
  { entity: '*', column: 'password_hash', mask: 'exclude', dataClass: 'operational', reasonRequired: false },
  { entity: '*', column: 'pin_hash', mask: 'exclude', dataClass: 'operational', reasonRequired: false },
  { entity: '*', column: 'recovery_codes_hash', mask: 'exclude', dataClass: 'operational', reasonRequired: false },
  { entity: '*', column: 'token_hash', mask: 'exclude', dataClass: 'operational', reasonRequired: false },
  { entity: '*', column: 'refresh_token', mask: 'exclude', dataClass: 'operational', reasonRequired: false },
  { entity: '*', column: 'client_secret', mask: 'exclude', dataClass: 'operational', reasonRequired: false },
  { entity: '*', column: 'private_key', mask: 'exclude', dataClass: 'operational', reasonRequired: false },
  { entity: '*', column: 'credentials_ref', mask: 'redact', dataClass: 'operational', reasonRequired: false },
  { entity: '*', column: 'api_key', mask: 'exclude', dataClass: 'operational', reasonRequired: false },
  {
    entity: '*',
    column: 'biometric_template',
    mask: 'exclude',
    dataClass: 'phi',
    reasonRequired: false,
    note: 'EN-024 §3.1.4: biometric templates never appear in a diff, even masked.',
  },
  // Statutory identifiers — partial only.
  {
    entity: '*',
    column: 'aadhaar',
    mask: 'mask_partial',
    dataClass: 'phi',
    reasonRequired: true,
    note: 'docs/04 §4: store masked last-4 + hash only; never the full number.',
  },
  { entity: '*', column: 'aadhaar_last4', mask: 'mask_partial', dataClass: 'phi', reasonRequired: true },
  { entity: '*', column: 'abha_token', mask: 'redact', dataClass: 'phi', reasonRequired: true },
  { entity: '*', column: 'abha_number', mask: 'mask_partial', dataClass: 'phi', reasonRequired: true },
  { entity: '*', column: 'bank_account_no', mask: 'mask_partial', dataClass: 'financial', reasonRequired: true },
  { entity: '*', column: 'pan', mask: 'mask_partial', dataClass: 'financial', reasonRequired: false },
  // Contact details — masked for non-care roles by ABAC, masked in diffs always.
  { entity: '*', column: 'mobile', mask: 'mask_partial', dataClass: 'phi', reasonRequired: false },
  { entity: '*', column: 'email', mask: 'mask_partial', dataClass: 'phi', reasonRequired: false },
]);

/**
 * `EN-024 §3.4`: the chain. `row_hash = sha256(canonical_json(entry))`, with
 * `prev_hash` from the previous entry, terminating in a per-day `day_root`.
 *
 * Canonicalisation must be deterministic — sorted keys, no insignificant
 * whitespace, explicit nulls — or the chain will fail to verify on a different
 * Node version and produce a false tamper alarm, which is worse than no alarm at
 * all because it destroys trust in the real ones.
 */
export interface AuditChainLink {
  readonly seq: bigint;
  readonly rowHash: Uint8Array;
  readonly prevHash: Uint8Array | null;
}

export const AUDIT_CHAIN_GENESIS_HASH = new Uint8Array(32); // 32 zero bytes

/**
 * The canonical JSON form hashed into the chain. Field order here IS the wire
 * format — changing it invalidates every existing chain, so it is frozen.
 */
export const AUDIT_CHAIN_HASHED_FIELDS: readonly string[] = Object.freeze([
  'seq',
  'hospital_id',
  'occurred_at',
  'actor_user_id',
  'actor_type',
  'actor_role',
  'impersonator_user_id',
  'entity',
  'row_id',
  'action',
  'patient_id',
  'changed_fields',
  'before',
  'after',
  'reason_code',
  'reason_text',
  'result',
  'prev_hash',
]);

/**
 * Retention floors, in days. `EN-024 §5`: "Retention floors are enforced in code:
 * any policy below the statutory floor is rejected with the specific regulation
 * cited." These are floors, not defaults — a hospital may keep data longer.
 */
export interface RetentionFloor {
  readonly dataClass: string;
  readonly actionClass: string;
  readonly floorDays: number;
  readonly regulation: string;
}

export const RETENTION_FLOORS: readonly RetentionFloor[] = Object.freeze([
  {
    dataClass: 'phi',
    actionClass: 'clinical_mutation',
    floorDays: 2920,
    regulation: 'EN-024 §3.3 (clinical 8 years); MLC and minors longer per NC-003',
  },
  {
    dataClass: 'financial',
    actionClass: 'financial_mutation',
    floorDays: 2920,
    regulation: 'Companies Act §128 and Income Tax / GST record retention (6–8 years)',
  },
  {
    dataClass: 'phi',
    actionClass: 'read_phi',
    floorDays: 1095,
    regulation: 'DPDP Act 2023 accountability and NABH record-access evidence (3 years)',
  },
  {
    dataClass: 'operational',
    actionClass: 'authentication',
    floorDays: 180,
    regulation: 'CERT-In Directions 2022 — logs retained 180 days within India',
  },
  {
    dataClass: 'operational',
    actionClass: 'config_change',
    floorDays: 2920,
    regulation: 'EN-024 §3.3 (admin/config change 8 years)',
  },
  {
    dataClass: 'security',
    actionClass: 'breach_evidence',
    floorDays: 1095,
    regulation: 'DPDP Rules 2025 — breach evidence retained at least 3 years',
  },
]);

export function retentionFloorFor(dataClass: string, actionClass: string): RetentionFloor | undefined {
  return RETENTION_FLOORS.find((f) => f.dataClass === dataClass && f.actionClass === actionClass);
}

/**
 * `docs/04 §5` / `docs/07 §5`: rows under legal hold are exempt from archival
 * compaction and stay in hot partitions indefinitely. The retention job checks
 * this row by row before detaching a partition and **aborts** rather than
 * archiving silently.
 */
export const LEGAL_HOLD_REASONS = [
  'mlc',
  'forensic',
  'litigation',
  'consumer_court',
  'open_insurance_dispute',
  'regulator_request',
  'minor_patient',
] as const;

export type LegalHoldReason = (typeof LEGAL_HOLD_REASONS)[number];
