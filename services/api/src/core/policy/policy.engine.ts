import {
  CLINICAL_SAFETY_EXEMPT_PERMISSIONS,
  PHI_READ_PERMISSIONS,
  REASON_REQUIRED_PERMISSIONS,
  SECOND_PERSON_PERMISSIONS,
  STEP_UP_PERMISSIONS,
  getPermission,
  type AbacConditions,
  type PolicyContext,
  type PolicyDecision,
  type PolicyObligation,
  type PolicyResource,
} from '@vims/contracts';

/**
 * The authorisation engine — step 6 of `docs/01` §3.
 *
 * Pure functions with no Nest, no database and no clock of their own, because
 * this is the code most worth testing exhaustively and least worth mocking a
 * framework to reach. Time arrives as `ctx.nowMs`.
 *
 * Three properties are deliberate:
 *
 * **Deny by default.** Every path that is not an explicit allow returns a denial
 * with a machine-readable reason. There is no fall-through.
 *
 * **Role grants are additive, conditions are not.** A user may hold the same
 * permission through several roles, each carrying its own ABAC conditions — a
 * doctor who is also an HOD, for instance. The correct semantics is that the
 * user may act if **any one** grant permits it: narrowing to the intersection
 * would mean adding a role could take away access the user already had, which is
 * both surprising and, in a hospital, dangerous. Within a single grant, every
 * condition must hold.
 *
 * **Obligations are returned, not performed.** The engine says "this also
 * requires a reason / a second person / a PHI-read audit row"; the interceptor
 * chain asserts each was discharged. If the engine performed them itself, a
 * controller could satisfy an obligation by ignoring it.
 */

export interface LicenceState {
  /**
   * Whether the hospital currently holds the module that owns a permission.
   * A function rather than a set so the caller can consult a cache, a degraded
   * tier or a feature flag without this engine knowing which.
   */
  isModuleEnabled(moduleId: string): boolean;
}

export interface EvaluateInput {
  readonly permission: string;
  readonly context: PolicyContext;
  readonly resource: PolicyResource;
  readonly licence?: LicenceState;
  /** Set when the caller supplied a reason (break-glass, reason-required actions). */
  readonly reason?: string | null;
  /** Set when a second distinct user has authenticated for this action. */
  readonly secondPersonUserId?: string | null;
  /** Client IP, for `ipAllowlist`. */
  readonly ip?: string | null;
  /** True when the session is bound to a registered device. */
  readonly deviceBound?: boolean;
}

function denial(
  reason: Extract<PolicyDecision, { allowed: false }>['reason'],
  message: string,
  trace: readonly string[],
  requiredPermission?: string,
): PolicyDecision {
  return requiredPermission === undefined
    ? { allowed: false, reason, message, trace }
    : { allowed: false, reason, message, requiredPermission, trace };
}

/** Minutes since midnight, in the hospital's timezone. */
export function minutesOfDay(nowMs: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(nowMs));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/** ISO weekday (1 = Monday) in the hospital's timezone. */
export function isoWeekday(nowMs: number, timezone: string): number {
  const name = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short' }).format(
    new Date(nowMs),
  );
  const index = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(name);
  return index === -1 ? 1 : index + 1;
}

function parseHhMm(value: string): number {
  const [h, m] = value.split(':');
  return Number(h) * 60 + Number(m);
}

export function withinTimeWindow(
  window: NonNullable<AbacConditions['timeWindow']>,
  nowMs: number,
  timezone: string,
): boolean {
  const days = window.daysOfWeek;
  if (days.length > 0 && !days.includes(isoWeekday(nowMs, timezone))) return false;

  const now = minutesOfDay(nowMs, timezone);
  const start = parseHhMm(window.startTime);
  const end = parseHhMm(window.endTime);

  // A night shift is expressed as 22:00 → 06:00. Treating that as a plain
  // `start <= now <= end` comparison would make it never match.
  return window.crossesMidnight || start > end ? now >= start || now <= end : now >= start && now <= end;
}

/** Decimal-string comparison without floats, per `packages/contracts/primitives/money.ts`. */
function decimalToBigInt(value: string, scale = 4): bigint {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const padded = (fraction + '0'.repeat(scale)).slice(0, scale);
  const magnitude = BigInt(whole + padded);
  return negative ? -magnitude : magnitude;
}

export function withinAmountLimit(
  limit: NonNullable<AbacConditions['amountLimit']>,
  resource: PolicyResource,
): boolean {
  const amountOk =
    limit.maxAmount === undefined ||
    resource.amount === undefined ||
    decimalToBigInt(resource.amount) <= decimalToBigInt(limit.maxAmount);

  const percentOk =
    limit.maxPercent === undefined ||
    resource.percent === undefined ||
    decimalToBigInt(resource.percent) <= decimalToBigInt(limit.maxPercent);

  const bothConfigured = limit.maxAmount !== undefined && limit.maxPercent !== undefined;
  if (!bothConfigured) return amountOk && percentOk;

  switch (limit.combine) {
    case 'whichever_is_lower':
      // "25 % or ₹25 000, whichever is lower, triggers the next tier" (EN-038 §3.2):
      // the tighter ceiling governs, so BOTH must pass.
      return amountOk && percentOk;
    case 'whichever_is_higher':
      return amountOk || percentOk;
    case 'both_must_pass':
      return amountOk && percentOk;
    default:
      return false;
  }
}

interface ConditionOutcome {
  readonly ok: boolean;
  readonly reason?: Extract<PolicyDecision, { allowed: false }>['reason'];
  readonly message?: string;
  readonly obligations: readonly PolicyObligation[];
}

function evaluateConditions(input: EvaluateInput, conditions: AbacConditions): ConditionOutcome {
  const { context: ctx, resource } = input;
  const obligations: PolicyObligation[] = [];

  if (conditions.branchIds && resource.branchId != null && !conditions.branchIds.includes(resource.branchId)) {
    return { ok: false, reason: 'branch_not_granted', message: 'This branch is not in your grant.', obligations };
  }
  if (
    conditions.departmentIds &&
    resource.departmentId != null &&
    !conditions.departmentIds.includes(resource.departmentId)
  ) {
    return { ok: false, reason: 'department_out_of_scope', message: 'This department is outside your scope.', obligations };
  }
  if (conditions.wardIds && resource.wardId != null && !conditions.wardIds.includes(resource.wardId)) {
    return { ok: false, reason: 'ward_out_of_scope', message: 'This ward is outside your scope.', obligations };
  }
  if (conditions.assignedWardOnly && resource.wardId != null) {
    const granted = conditions.wardIds ?? [];
    if (granted.length > 0 && !granted.includes(resource.wardId)) {
      return { ok: false, reason: 'ward_out_of_scope', message: 'You are not rostered to this ward.', obligations };
    }
  }
  if (conditions.ownDepartmentOnly && resource.departmentId != null) {
    const granted = conditions.departmentIds ?? [];
    if (granted.length > 0 && !granted.includes(resource.departmentId)) {
      return { ok: false, reason: 'department_out_of_scope', message: 'Only your own department.', obligations };
    }
  }
  if (conditions.ownPatientsOnly && resource.patientId != null && resource.isOwnPatient !== true) {
    return { ok: false, reason: 'not_own_patient', message: 'Only your own patients.', obligations };
  }
  if (conditions.careTeamOnly && resource.patientId != null && resource.isCareTeamMember !== true) {
    // Break-glass is the sanctioned override, and it is never silent: it costs a
    // reason and produces a READ_PHI record the Privacy Officer sees daily
    // (docs/05 §Login model).
    if (input.reason != null && input.reason.trim().length > 0) {
      obligations.push({ kind: 'break_glass', patientId: resource.patientId });
      obligations.push({ kind: 'write_phi_read_audit', patientId: resource.patientId });
    } else {
      return {
        ok: false,
        reason: 'not_care_team',
        message: 'You are not on this patient’s care team. Provide a reason to open the record under break-glass.',
        obligations,
      };
    }
  }
  if (conditions.ownQueueOnly && resource.queueOwnerUserId != null && resource.queueOwnerUserId !== ctx.userId) {
    return { ok: false, reason: 'not_own_queue', message: 'You may only call your own queue.', obligations };
  }
  if (conditions.amountLimit && !withinAmountLimit(conditions.amountLimit, resource)) {
    return { ok: false, reason: 'amount_limit_exceeded', message: 'Above your approval limit.', obligations };
  }
  if (conditions.timeWindow && !withinTimeWindow(conditions.timeWindow, ctx.nowMs, ctx.timezone)) {
    return { ok: false, reason: 'outside_time_window', message: 'Outside the permitted hours for this action.', obligations };
  }
  if (conditions.ipAllowlist && conditions.ipAllowlist.length > 0) {
    const ip = input.ip ?? null;
    if (ip === null || !conditions.ipAllowlist.includes(ip)) {
      return { ok: false, reason: 'ip_not_allowed', message: 'This action is restricted to hospital networks.', obligations };
    }
  }
  if (conditions.deviceBound && input.deviceBound !== true) {
    return { ok: false, reason: 'device_not_bound', message: 'This action requires a registered device.', obligations };
  }
  if (conditions.requiresSecondPerson) {
    const second = input.secondPersonUserId ?? null;
    if (second === null || second === ctx.userId) {
      return {
        ok: false,
        reason: 'second_person_required',
        message: 'A second, different authorised user must confirm this action.',
        obligations,
      };
    }
    obligations.push({ kind: 'require_second_person' });
  }
  if (conditions.dataClassMasks && conditions.dataClassMasks.length > 0) {
    obligations.push({ kind: 'mask_fields', fields: [...conditions.dataClassMasks] });
  }

  return { ok: true, obligations };
}

export function evaluate(input: EvaluateInput): PolicyDecision {
  const { permission, context: ctx, resource } = input;
  const trace: string[] = [];

  // ── the permission must exist in the catalogue ───────────────────────────
  const definition = getPermission(permission);
  if (!definition) {
    return denial(
      'unregistered_permission',
      `Permission "${permission}" is not in the catalogue. A route may not invent one.`,
      [...trace, 'catalogue:miss'],
      permission,
    );
  }
  trace.push('catalogue:hit');

  // ── tenancy, before anything else ────────────────────────────────────────
  if (resource.hospitalId != null && resource.hospitalId !== ctx.hospitalId) {
    const groupScoped = ctx.scope === 'group';
    if (!groupScoped) {
      return denial('tenant_mismatch', 'Not found.', [...trace, 'tenant:mismatch'], permission);
    }
    trace.push('tenant:group-scope');
  }
  trace.push('tenant:ok');

  // ── licence gating, with the clinical-safety carve-out ───────────────────
  //
  // `EN-040 §5`: "Clinical safety is never gated." A permission marked
  // `clinicalSafetyExempt` can never be blocked by licence state, degradation
  // tier or feature flag — an allergy hard-stop must not stop working because an
  // invoice is unpaid. The carve-out is checked here, once, rather than at every
  // call site where it could be forgotten.
  if (input.licence && !input.licence.isModuleEnabled(definition.module)) {
    const exempt =
      definition.clinicalSafetyExempt === true || CLINICAL_SAFETY_EXEMPT_PERMISSIONS.includes(permission);
    if (!exempt) {
      return denial('not_licensed', 'This module is not licensed for your hospital.', [...trace, 'licence:blocked'], permission);
    }
    trace.push('licence:exempt');
  } else if (input.licence) {
    trace.push('licence:ok');
  }

  // ── RBAC ─────────────────────────────────────────────────────────────────
  if (!ctx.permissions.has(permission)) {
    return denial('missing_permission', 'You do not have permission to do this.', [...trace, 'rbac:miss'], permission);
  }
  trace.push('rbac:hit');

  // ── branch scope ─────────────────────────────────────────────────────────
  if (resource.branchId != null && ctx.grantedBranchIds.length > 0 && !ctx.grantedBranchIds.includes(resource.branchId)) {
    return denial('branch_not_granted', 'This branch is not in your grant.', [...trace, 'branch:denied'], permission);
  }
  trace.push('branch:ok');

  // ── ABAC: any single grant may permit ────────────────────────────────────
  const conditionSets = ctx.conditions.length > 0 ? ctx.conditions : [{} as AbacConditions];
  let lastFailure: ConditionOutcome | undefined;
  let passing: ConditionOutcome | undefined;

  for (const set of conditionSets) {
    const outcome = evaluateConditions(input, set);
    if (outcome.ok) {
      passing = outcome;
      break;
    }
    lastFailure = outcome;
  }

  if (!passing) {
    const failure = lastFailure ?? { ok: false as const, obligations: [] };
    return denial(
      failure.reason ?? 'missing_permission',
      failure.message ?? 'You do not have permission to do this.',
      [...trace, 'abac:denied'],
      permission,
    );
  }
  trace.push('abac:ok');

  const obligations: PolicyObligation[] = [...passing.obligations];

  // ── step-up authentication ───────────────────────────────────────────────
  if (definition.requiresStepUp === true || STEP_UP_PERMISSIONS.includes(permission)) {
    const maxAgeSeconds = 300;
    const ageSeconds = (ctx.nowMs - ctx.authContext.authTimeMs) / 1000;
    if (ageSeconds > maxAgeSeconds) {
      return denial(
        'step_up_required',
        'Please re-authenticate to continue.',
        [...trace, 'stepup:stale'],
        permission,
      );
    }
    obligations.push({ kind: 'require_step_up', acr: ctx.authContext.acr, maxAgeSeconds });
  }

  // ── second person, where the permission itself demands it ────────────────
  if (definition.requiresSecondPerson === true || SECOND_PERSON_PERMISSIONS.includes(permission)) {
    const second = input.secondPersonUserId ?? null;
    if (second === null || second === ctx.userId) {
      return denial(
        'second_person_required',
        'A second, different authorised user must confirm this action.',
        [...trace, 'second-person:missing'],
        permission,
      );
    }
    if (!obligations.some((o) => o.kind === 'require_second_person')) {
      obligations.push({ kind: 'require_second_person' });
    }
  }

  // ── reason capture ───────────────────────────────────────────────────────
  if (definition.requiresReason === true || REASON_REQUIRED_PERMISSIONS.includes(permission)) {
    if (input.reason == null || input.reason.trim().length === 0) {
      return denial('reason_required', 'A reason is required for this action.', [...trace, 'reason:missing'], permission);
    }
    obligations.push({ kind: 'capture_reason' });
  }

  // ── audit obligations ────────────────────────────────────────────────────
  obligations.push({ kind: 'write_audit', action: permission });
  if (definition.phiRead === true || PHI_READ_PERMISSIONS.includes(permission)) {
    const patientId = resource.patientId ?? null;
    if (!obligations.some((o) => o.kind === 'write_phi_read_audit')) {
      obligations.push({ kind: 'write_phi_read_audit', patientId });
    }
  }

  return { allowed: true, obligations, trace };
}
