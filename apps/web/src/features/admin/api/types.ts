import type { PermissionDefinition, SodRule } from '@vims/contracts';

/**
 * The admin console's view of `services/api`'s responses.
 *
 * These mirror the return types of `services/api/src/modules/platform/admin/*`
 * with one systematic difference: every `Date` there arrives here as an ISO
 * string, because it crossed JSON. Typing them as `Date` would compile and then
 * fail at the first `.getTime()`, which is the kind of bug that only shows up on
 * the screen a user is looking at.
 *
 * Column names stay `snake_case` where the API returns them that way. Renaming
 * them here would mean maintaining a translation table for no benefit — the
 * conversion to ward vocabulary happens in the cell renderer, where the
 * localised label belongs.
 */

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

// ── users (EN-007 §3.2) ──────────────────────────────────────────────────────

export type UserStatus = 'invited' | 'active' | 'locked' | 'suspended' | 'deactivated';

export interface UserListItem {
  readonly id: string;
  readonly username: string;
  readonly display_name: string;
  readonly email: string | null;
  readonly employee_id: string | null;
  readonly type: string;
  readonly status: string;
  readonly mfa_enabled: boolean;
  readonly last_login_at: string | null;
  readonly created_at: string;
  readonly version: number;
}

export interface UserRoleAssignment {
  readonly id: string;
  readonly role_id: string;
  readonly role_key: string;
  readonly role_name: string;
  readonly branch_id: string | null;
  readonly scope: unknown;
  readonly conditions: unknown;
  readonly valid_from: string;
  readonly valid_to: string | null;
  readonly active: boolean;
}

export interface UserDetail extends UserListItem {
  readonly mobile: string | null;
  readonly name: unknown;
  readonly professional: unknown;
  readonly preferences: unknown;
  readonly must_change_password: boolean;
  readonly deactivated_at: string | null;
  readonly deactivation_reason: string | null;
  readonly roles: readonly UserRoleAssignment[];
}

// ── roles & the permission catalogue (EN-007 §3.3) ───────────────────────────

export interface RoleListItem {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly template_key: string | null;
  readonly home_workspace: string;
  readonly category: string;
  readonly is_system: boolean;
  readonly sensitive_grant: boolean;
  readonly version: number;
  readonly active: boolean;
  readonly created_at: string;
  readonly assigned_users: number;
}

export interface RoleDetail extends RoleListItem {
  readonly abac_defaults: unknown;
  readonly permissions: readonly string[];
  readonly segregationOfDuties: readonly SodFinding[];
}

export interface SodFinding {
  readonly permA: string;
  readonly permB: string;
  readonly mode: 'warn' | 'block';
  readonly reason: string;
}

export interface PermissionCatalogueModule {
  readonly module: string;
  readonly permissions: readonly PermissionDefinition[];
}

export interface PermissionCatalogue {
  readonly modules: readonly PermissionCatalogueModule[];
  readonly segregationOfDuties: readonly SodRule[];
  readonly total: number;
}

// ── branches (EN-041 §6) ─────────────────────────────────────────────────────

export interface BranchListItem {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly short_name: string;
  readonly kind: string;
  readonly status: string;
  readonly parent_branch_id: string | null;
  readonly timezone: string;
  readonly currency: string;
  readonly bed_count: number;
  readonly module_profile: string;
  readonly colour_token: string;
  readonly go_live_at: string | null;
  readonly created_at: string;
}

export interface BranchDetail extends BranchListItem {
  readonly address: unknown;
  readonly state_code: string | null;
  readonly gstin: string | null;
  readonly working_hours: unknown;
  readonly hfr_id: string | null;
  readonly rohini_id: string | null;
  readonly residency_zone: string;
  readonly serves_from_branch_id: string | null;
  readonly version: number;
  readonly granted_to_caller: boolean;
}

// ── settings (EN-007 §3.1.2) ─────────────────────────────────────────────────

export type SettingScope = 'hospital' | 'branch' | 'department' | 'user';

export interface EffectiveSetting {
  readonly key: string;
  readonly module: string;
  readonly label: string;
  readonly description: string;
  readonly scopes: readonly SettingScope[];
  readonly sensitivity: string;
  readonly requiresApproval: boolean;
  readonly dualControl: boolean;
  readonly defaultValue: unknown;
  readonly value: unknown;
  readonly source: SettingScope | 'default';
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly masked: boolean;
}

// ── feature flags & licence (EN-007 §3.7, EN-040) ────────────────────────────

export interface ResolvedFlag {
  readonly key: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly licensed: boolean;
  readonly clinicalSafetyExempt: boolean;
  readonly rolloutPct: number | null;
  readonly expiresAt: string | null;
  readonly note: string | null;
  readonly scope: 'hospital' | 'branch' | 'role' | 'user' | 'global';
  readonly upgradeCta: string | null;
  readonly message: string;
}

export interface ResolvedEntitlement {
  readonly key: string;
  readonly family: string;
  readonly guard: string;
  readonly description: string;
  readonly allowed: boolean;
  readonly limitValue: string | null;
  readonly degradeMode: number;
  readonly source: string;
  readonly clinicalSafetyExempt: boolean;
  readonly failOpen: boolean;
  readonly message: string;
  readonly upgradeCta: string | null;
  readonly effectiveTo: string | null;
}

export interface SubscriptionSummary {
  readonly id: string;
  readonly status: string;
  readonly degradeTier: number;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly graceUntil: string | null;
  readonly renewalMode: string;
  readonly currency: string;
}

export interface DegradationTier {
  readonly tier: number;
  readonly status: string;
  readonly label: string;
  readonly stillWorks: string;
  readonly restricted: string;
  readonly restrictedCapabilities: readonly string[];
}

export interface LicenceState {
  readonly subscription: SubscriptionSummary | null;
  readonly tier: DegradationTier;
  readonly entitlements: readonly ResolvedEntitlement[];
  readonly clinicalSafetyExemptKeys: readonly string[];
  readonly usingDefaults: boolean;
}

// ── audit viewer (EN-024 §6) ─────────────────────────────────────────────────

export interface AuditRow {
  readonly id: string;
  readonly occurred_at: string;
  readonly actor_user_id: string | null;
  readonly actor_role: string | null;
  readonly impersonator_user_id: string | null;
  readonly entity: string;
  readonly row_id: string | null;
  readonly business_key: string | null;
  readonly action: string;
  readonly patient_id: string | null;
  readonly data_class: string;
  readonly sensitivity: string;
  readonly result: string;
  readonly denial_reason: string | null;
  readonly reason_code: string | null;
  readonly reason_text: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly changed_fields: readonly string[];
  readonly row_count: number | null;
  readonly trace_id: string | null;
  readonly api_route: string | null;
  readonly sealed_at: string | null;
}

/**
 * Filter shapes carry `| undefined` explicitly because the repo compiles with
 * `exactOptionalPropertyTypes`: under that flag `q?: string` accepts a *missing*
 * property but not an assigned `undefined`, and a filter form clears a field by
 * assigning `undefined` to it.
 */
export interface AuditFilters {
  readonly userId?: string | undefined;
  readonly patientId?: string | undefined;
  readonly entity?: string | undefined;
  readonly action?: string | undefined;
  readonly businessKey?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly breakGlassOnly?: boolean | undefined;
  readonly deniedOnly?: boolean | undefined;
  readonly impersonatedOnly?: boolean | undefined;
  readonly q?: string | undefined;
}

export interface UserFilters {
  readonly q?: string | undefined;
  readonly status?: UserStatus | undefined;
  readonly roleKey?: string | undefined;
}

export type { PermissionDefinition, SodRule };
