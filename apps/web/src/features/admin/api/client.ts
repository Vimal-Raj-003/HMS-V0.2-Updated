import { apiFetch } from '@/lib/api';
import type {
  AuditFilters,
  AuditRow,
  BranchDetail,
  BranchListItem,
  EffectiveSetting,
  LicenceState,
  Page,
  PermissionCatalogue,
  ResolvedFlag,
  RoleDetail,
  RoleListItem,
  UserDetail,
  UserFilters,
  UserListItem,
  UserRoleAssignment,
} from './types';

/**
 * The admin console's calls into `/api/v1/admin/**`.
 *
 * Every one goes through the same-origin proxy in `app/api/v1/[...path]`, so the
 * bearer token stays in an httpOnly cookie the browser cannot read.
 *
 * `reason` appears on exactly the calls whose permission key is marked
 * `requiresReason` in the catalogue (`admin.user.deactivate`,
 * `admin.user.reset`, `admin.role.assign`). For those the policy engine returns
 * 403 `reason_required` when the `x-reason` header is absent, so the parameter
 * is required here rather than optional: a caller cannot forget it and discover
 * the omission as a permission error in production.
 */

const BASE = '/api/v1/admin';

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered === '' ? '' : `?${rendered}`;
}

interface Signal {
  readonly signal?: AbortSignal;
}

function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

// ── users ────────────────────────────────────────────────────────────────────

export async function listUsers(
  filters: UserFilters,
  cursor: string | undefined,
  options: Signal = {},
): Promise<Page<UserListItem>> {
  return apiFetch<Page<UserListItem>>(
    `${BASE}/users${query({ ...filters, cursor, limit: 25 })}`,
    withSignal(options),
  );
}

export async function getUser(id: string, options: Signal = {}): Promise<UserDetail> {
  return apiFetch<UserDetail>(`${BASE}/users/${id}`, withSignal(options));
}

export interface CreateUserInput {
  readonly username: string;
  readonly email?: string;
  readonly mobile?: string;
  readonly name: { readonly family: string; readonly given: string };
  readonly employeeId?: string;
  readonly type: 'staff' | 'external' | 'partner' | 'device' | 'service';
  readonly roleAssignments: readonly {
    readonly roleId: string;
    readonly branchId: string | null;
  }[];
  readonly inviteVia: 'email' | 'sms' | 'none';
}

export async function createUser(input: CreateUserInput): Promise<UserDetail> {
  return apiFetch<UserDetail>(`${BASE}/users`, { method: 'POST', body: input });
}

export async function deactivateUser(
  id: string,
  reason: string,
): Promise<{ readonly sessionsRevoked: number }> {
  // The reason travels twice on purpose. The header is what the policy engine
  // reads before the handler runs; the body is what lands in the audit row and
  // the domain event. They are deliberately the same string.
  return apiFetch(`${BASE}/users/${id}/deactivate`, {
    method: 'POST',
    body: { reason },
    reason,
  });
}

export async function resetUserPassword(
  id: string,
  newPassword: string,
  reason: string,
): Promise<{ readonly mustChangePassword: boolean }> {
  return apiFetch(`${BASE}/users/${id}/reset-password`, {
    method: 'POST',
    body: { newPassword, mustChangePassword: true },
    reason,
  });
}

export async function assignRole(
  userId: string,
  input: { readonly roleId: string; readonly branchId: string | null; readonly justification: string },
): Promise<{ readonly items: readonly UserRoleAssignment[] }> {
  return apiFetch(`${BASE}/users/${userId}/roles`, {
    method: 'POST',
    body: input,
    reason: input.justification,
  });
}

export async function revokeRole(
  userId: string,
  userRoleId: string,
  reason: string,
): Promise<{ readonly items: readonly UserRoleAssignment[] }> {
  return apiFetch(`${BASE}/users/${userId}/roles/${userRoleId}`, { method: 'DELETE', reason });
}

// ── roles & permissions ──────────────────────────────────────────────────────

export async function listRoles(options: Signal = {}): Promise<Page<RoleListItem>> {
  // 64 seeded templates plus the hospital's own clones fit inside the 100-row
  // interactive ceiling, so the matrix editor never has to paginate its columns.
  return apiFetch<Page<RoleListItem>>(`${BASE}/roles?limit=100`, withSignal(options));
}

export async function getRole(id: string, options: Signal = {}): Promise<RoleDetail> {
  return apiFetch<RoleDetail>(`${BASE}/roles/${id}`, withSignal(options));
}

export async function getPermissionCatalogue(options: Signal = {}): Promise<PermissionCatalogue> {
  return apiFetch<PermissionCatalogue>(`${BASE}/permissions`, withSignal(options));
}

export async function updateRolePermissions(input: {
  readonly id: string;
  readonly version: number;
  readonly permissions: readonly string[];
  readonly reason: string;
}): Promise<RoleDetail> {
  return apiFetch<RoleDetail>(`${BASE}/roles/${input.id}`, {
    method: 'PATCH',
    body: { version: input.version, permissions: input.permissions, reason: input.reason },
    reason: input.reason,
  });
}

export async function cloneRole(input: {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly templateKey: string;
  readonly permissions: readonly string[];
  readonly homeWorkspace: string;
}): Promise<RoleDetail> {
  return apiFetch<RoleDetail>(`${BASE}/roles`, { method: 'POST', body: input });
}

// ── branches ─────────────────────────────────────────────────────────────────

export async function listBranches(options: Signal = {}): Promise<Page<BranchListItem>> {
  return apiFetch<Page<BranchListItem>>(`${BASE}/branches?limit=100`, withSignal(options));
}

export async function getBranch(id: string, options: Signal = {}): Promise<BranchDetail> {
  return apiFetch<BranchDetail>(`${BASE}/branches/${id}`, withSignal(options));
}

// ── settings ─────────────────────────────────────────────────────────────────

export async function listSettings(
  filters: { readonly module?: string; readonly q?: string },
  options: Signal = {},
): Promise<{ readonly items: readonly EffectiveSetting[] }> {
  return apiFetch(`${BASE}/settings${query(filters)}`, withSignal(options));
}

export async function putSetting(input: {
  readonly key: string;
  readonly scope: 'hospital' | 'branch' | 'department' | 'user';
  readonly scopeId: string | null;
  readonly value: unknown;
  readonly reason: string;
}): Promise<EffectiveSetting> {
  return apiFetch<EffectiveSetting>(`${BASE}/settings`, {
    method: 'PUT',
    body: input,
    reason: input.reason,
  });
}

// ── feature flags & licence ──────────────────────────────────────────────────

export async function listFlags(options: Signal = {}): Promise<{ readonly items: readonly ResolvedFlag[] }> {
  return apiFetch(`${BASE}/flags`, withSignal(options));
}

export async function putFlag(input: {
  readonly key: string;
  readonly enabled: boolean;
  readonly note: string;
}): Promise<ResolvedFlag> {
  return apiFetch<ResolvedFlag>(`${BASE}/flags/${encodeURIComponent(input.key)}`, {
    method: 'PUT',
    body: { enabled: input.enabled, note: input.note },
    reason: input.note,
  });
}

export async function getLicence(options: Signal = {}): Promise<LicenceState> {
  return apiFetch<LicenceState>(`${BASE}/licence`, withSignal(options));
}

// ── audit ────────────────────────────────────────────────────────────────────

export async function searchAudit(
  filters: AuditFilters,
  cursor: string | undefined,
  options: Signal = {},
): Promise<Page<AuditRow>> {
  return apiFetch<Page<AuditRow>>(
    `${BASE}/audit${query({ ...filters, cursor, limit: 50 })}`,
    withSignal(options),
  );
}
