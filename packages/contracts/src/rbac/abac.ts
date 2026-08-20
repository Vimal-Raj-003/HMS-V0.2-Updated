/**
 * ABAC conditions layered on top of RBAC.
 *
 * `docs/05 §Model: RBAC + ABAC`: "**ABAC conditions** on top: `own_patients_only`,
 * `own_department_only`, `assigned_ward_only`, `amount_limit` (discount ≤ 10 %),
 * `time_window` (night shift), `requires_second_person` (blood issue, narcotics),
 * `care_team_only`."
 * `EN-007 §3.3.3` adds: `branch_ids`, `department_ids`, `ward_ids`, `unit_ids`,
 * `ip_allowlist`, `device_bound`, `data_class_masks`.
 *
 * Evaluated server-side by the policy service and mirrored to the UI so a control
 * the user could never successfully use is never rendered (docs/06 §4.1:
 * "never render an item the user cannot use").
 */
import { z } from 'zod';

/** Money limits are decimal strings, never numbers — see primitives/money.ts. */
export const amountLimitSchema = z.object({
  /** Absolute ceiling as a decimal string, e.g. "5000.00". */
  maxAmount: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/)
    .optional(),
  /** Percentage ceiling as a decimal string, e.g. "10" or "12.5". */
  maxPercent: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/)
    .optional(),
  /**
   * `EN-038 §3.2`: "'25 % **or** ₹25 000, whichever is lower, triggers the next
   * tier' — both expressible". When both are set, the *lower* effective ceiling wins.
   */
  combine: z
    .enum(['whichever_is_lower', 'whichever_is_higher', 'both_must_pass'])
    .default('whichever_is_lower'),
});

export type AmountLimit = z.infer<typeof amountLimitSchema>;

export const timeWindowSchema = z.object({
  /** ISO weekdays, 1 = Monday. Empty means every day. */
  daysOfWeek: z.array(z.number().int().min(1).max(7)).max(7).default([]),
  /** `HH:mm` in the hospital's timezone. */
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** True when the window crosses midnight (22:00 → 06:00 night shift). */
  crossesMidnight: z.boolean().default(false),
});

export type TimeWindow = z.infer<typeof timeWindowSchema>;

export const abacConditionsSchema = z.object({
  // ── scope narrowing ──────────────────────────────────────────────────────
  branchIds: z.array(z.string().uuid()).optional(),
  departmentIds: z.array(z.string().uuid()).optional(),
  wardIds: z.array(z.string().uuid()).optional(),
  unitIds: z.array(z.string().uuid()).optional(),

  // ── relationship gates ───────────────────────────────────────────────────
  /** Only patients where this user is the treating/ordering clinician. */
  ownPatientsOnly: z.boolean().optional(),
  /** Only patients whose care team this user belongs to. Break-glass bypasses with a reason. */
  careTeamOnly: z.boolean().optional(),
  ownDepartmentOnly: z.boolean().optional(),
  /** Only wards this user is rostered to (NC-030 in Phase 9; roster-less fallback is all granted wards). */
  assignedWardOnly: z.boolean().optional(),
  /** EN-006: a queue caller may only call their own queues. */
  ownQueueOnly: z.boolean().optional(),

  // ── value and time ceilings ──────────────────────────────────────────────
  amountLimit: amountLimitSchema.optional(),
  timeWindow: timeWindowSchema.optional(),

  // ── extra friction ───────────────────────────────────────────────────────
  /** Blood issue, narcotics, high-alert doses: a second distinct user must authenticate. */
  requiresSecondPerson: z.boolean().optional(),
  /** Restrict to hospital networks. Applied to break-glass and admin roles. */
  ipAllowlist: z.array(z.string()).optional(),
  /** Session must be bound to a registered device. */
  deviceBound: z.boolean().optional(),

  /**
   * `EN-007 §3.3.3` `data_class_masks`: mask identifiers for roles that do not
   * need them (docs/04 §4: "patient identifiers masked by default in non-care
   * roles; full reveal is an audited action").
   */
  dataClassMasks: z
    .array(z.enum(['mobile', 'address', 'aadhaar', 'abha', 'email', 'photo', 'diagnosis', 'full_name']))
    .optional(),
});

export type AbacConditions = z.infer<typeof abacConditionsSchema>;

/** The context a policy decision is made against. */
export interface PolicyContext {
  readonly hospitalId: string;
  readonly branchId: string | null;
  /** Branches this session may touch — becomes `app.branch_ids` in the transaction. */
  readonly grantedBranchIds: readonly string[];
  readonly scope: 'branch' | 'entity' | 'group';
  readonly userId: string;
  readonly roleKeys: readonly string[];
  readonly permissions: ReadonlySet<string>;
  readonly conditions: readonly AbacConditions[];
  /** From the session: how strongly and how recently the user authenticated (EN-025 §3.5). */
  readonly authContext: {
    readonly acr: string;
    readonly amr: readonly string[];
    readonly authTimeMs: number;
    readonly method: 'password' | 'sso' | 'otp' | 'device' | 'impersonation' | 'break_glass';
  };
  readonly impersonatorUserId: string | null;
  readonly nowMs: number;
  /** Hospital timezone, for `timeWindow` evaluation. */
  readonly timezone: string;
}

/** What the caller is trying to do. */
export interface PolicyResource {
  readonly type: string;
  readonly id?: string;
  readonly hospitalId?: string;
  readonly branchId?: string | null;
  readonly departmentId?: string | null;
  readonly wardId?: string | null;
  readonly patientId?: string | null;
  /** For amount-limited actions: decimal string in minor-unit-safe form. */
  readonly amount?: string;
  readonly percent?: string;
  /** Populated by the caller when it already knows care-team membership. */
  readonly isCareTeamMember?: boolean;
  readonly isOwnPatient?: boolean;
  readonly ownerUserId?: string | null;
  readonly queueOwnerUserId?: string | null;
}

export type PolicyDecision =
  | {
      readonly allowed: true;
      readonly obligations: readonly PolicyObligation[];
      readonly trace: readonly string[];
    }
  | {
      readonly allowed: false;
      readonly reason: PolicyDenialReason;
      readonly message: string;
      readonly requiredPermission?: string;
      readonly trace: readonly string[];
    };

export type PolicyDenialReason =
  | 'missing_permission'
  | 'unregistered_permission'
  | 'tenant_mismatch'
  | 'branch_not_granted'
  | 'department_out_of_scope'
  | 'ward_out_of_scope'
  | 'not_own_patient'
  | 'not_care_team'
  | 'not_own_queue'
  | 'amount_limit_exceeded'
  | 'outside_time_window'
  | 'ip_not_allowed'
  | 'device_not_bound'
  | 'step_up_required'
  | 'second_person_required'
  | 'reason_required'
  | 'not_licensed'
  | 'segregation_of_duties';

/**
 * Things the caller must *also* do for the action to be legitimate. The policy
 * service returns these rather than performing them, so a controller cannot
 * accidentally satisfy an obligation by ignoring it — the interceptor chain
 * asserts each one was discharged.
 */
export type PolicyObligation =
  | { readonly kind: 'write_audit'; readonly action: string }
  | { readonly kind: 'write_phi_read_audit'; readonly patientId: string | null }
  | { readonly kind: 'capture_reason' }
  | { readonly kind: 'require_second_person' }
  | { readonly kind: 'require_step_up'; readonly acr: string; readonly maxAgeSeconds: number }
  | { readonly kind: 'mask_fields'; readonly fields: readonly string[] }
  | { readonly kind: 'break_glass'; readonly patientId: string };
