/**
 * RFC 9457 `application/problem+json` — the single error shape of the API.
 *
 * `CLAUDE.md §4`: "map errors to RFC 9457 problem+json".
 * `docs/06 §1.1 heuristic 9`: "Errors say *what happened, what it means
 * clinically/financially, what to do next, and the reference id for the
 * helpdesk*." That sentence is why this type has `clinicalImpact`, `nextAction`
 * and `reference` fields that RFC 9457 itself does not mandate — a bare
 * `{"title": "Bad Request"}` is useless to a nurse at a bedside.
 *
 * `docs/04 §4`: no PHI in error messages. `detail` is written for a human but is
 * also logged, so it must never carry a patient name, UHID or diagnosis.
 */

export const PROBLEM_BASE_URI = 'https://errors.vimshms.com';

/**
 * Machine-readable problem types. The `type` URI is stable forever once shipped —
 * clients switch on it, so renaming one is a breaking API change (docs/09 §4).
 */
export const ProblemType = {
  // 400 family
  VALIDATION_FAILED: 'validation-failed',
  MALFORMED_REQUEST: 'malformed-request',
  IDEMPOTENCY_KEY_REUSED: 'idempotency-key-reused',
  IDEMPOTENCY_KEY_MISSING: 'idempotency-key-missing',
  STALE_CONTEXT: 'stale-context',
  OPTIMISTIC_LOCK_CONFLICT: 'optimistic-lock-conflict',

  // 401 / 403
  UNAUTHENTICATED: 'unauthenticated',
  SESSION_EXPIRED: 'session-expired',
  MFA_REQUIRED: 'mfa-required',
  STEP_UP_REQUIRED: 'step-up-required',
  PERMISSION_DENIED: 'permission-denied',
  ABAC_CONDITION_FAILED: 'abac-condition-failed',
  SEGREGATION_OF_DUTIES: 'segregation-of-duties',
  SECOND_PERSON_REQUIRED: 'second-person-required',
  BREAK_GLASS_REASON_REQUIRED: 'break-glass-reason-required',
  ACCOUNT_LOCKED: 'account-locked',
  TENANT_MISMATCH: 'tenant-mismatch',
  BRANCH_NOT_GRANTED: 'branch-not-granted',

  // 404 / 409 / 410
  NOT_FOUND: 'not-found',
  CONFLICT: 'conflict',
  ALREADY_DECIDED: 'already-decided',
  GONE: 'gone',
  RETIRED_MASTER_RECORD: 'retired-master-record',

  // 422 — semantic refusals, the interesting ones
  BUSINESS_RULE_VIOLATED: 'business-rule-violated',
  CLINICAL_HARD_STOP: 'clinical-hard-stop',
  APPROVAL_REQUIRED: 'approval-required',
  NUMBERING_SERIES_EXHAUSTED: 'numbering-series-exhausted',
  STATUTORY_LIMIT: 'statutory-limit',

  // 402 / 429 / 5xx
  NOT_LICENSED: 'not-licensed',
  QUOTA_EXCEEDED: 'quota-exceeded',
  RATE_LIMITED: 'rate-limited',
  INTERNAL_ERROR: 'internal-error',
  DEPENDENCY_UNAVAILABLE: 'dependency-unavailable',
  READ_ONLY_MODE: 'read-only-mode',
  NOT_IMPLEMENTED: 'not-implemented',
} as const;

export type ProblemTypeKey = (typeof ProblemType)[keyof typeof ProblemType];

export interface ProblemFieldError {
  /** JSON-Pointer-ish path into the request body: `items/0/quantity`. */
  readonly path: string;
  readonly message: string;
  readonly code?: string;
}

export interface ProblemDetails {
  /** RFC 9457 `type` — an absolute URI. */
  readonly type: string;
  /** Short, human-readable summary. Stable per `type`; never contains PHI. */
  readonly title: string;
  readonly status: number;
  /** Explanation specific to this occurrence. Never contains PHI. */
  readonly detail?: string;
  /** URI of the specific occurrence. We use the audit/trace reference. */
  readonly instance?: string;

  // ── Vim's HMS extensions (docs/06 §1.1 heuristic 9) ───────────────────────
  /**
   * The support reference the user reads out on the phone. Always present, always
   * matches the `trace_id` in the logs, so a helpdesk call resolves to one request.
   */
  readonly reference: string;
  /** What this means for the patient or the money, in plain words. */
  readonly clinicalImpact?: string;
  /** What the user should do next. */
  readonly nextAction?: string;
  /** Field-level errors so the UI can attach each message to its input. */
  readonly errors?: readonly ProblemFieldError[];
  /** For `permission-denied`: which key was missing, so the UI can offer "request access". */
  readonly requiredPermission?: string;
  /** For `clinical-hard-stop`: the rule that fired, for the alert log and the policy link. */
  readonly ruleId?: string;
  /** For `approval-required`: the workflow request that was raised. */
  readonly approvalRequestId?: string;
  /** For `rate-limited` / `dependency-unavailable`: seconds to wait. */
  readonly retryAfterSeconds?: number;
  /** For `not-licensed`: the entitlement key and an upgrade path. */
  readonly entitlementKey?: string;
}

export interface BuildProblemInput {
  readonly type: ProblemTypeKey;
  readonly status: number;
  readonly title: string;
  readonly reference: string;
  readonly detail?: string;
  readonly instance?: string;
  readonly clinicalImpact?: string;
  readonly nextAction?: string;
  readonly errors?: readonly ProblemFieldError[];
  readonly requiredPermission?: string;
  readonly ruleId?: string;
  readonly approvalRequestId?: string;
  readonly retryAfterSeconds?: number;
  readonly entitlementKey?: string;
}

export function buildProblem(input: BuildProblemInput): ProblemDetails {
  const out: Record<string, unknown> = {
    type: `${PROBLEM_BASE_URI}/${input.type}`,
    title: input.title,
    status: input.status,
    reference: input.reference,
  };
  // Only serialise fields that are actually set — `exactOptionalPropertyTypes`
  // means an explicit `undefined` is not the same as an absent key.
  const optional: readonly (keyof BuildProblemInput)[] = [
    'detail',
    'instance',
    'clinicalImpact',
    'nextAction',
    'errors',
    'requiredPermission',
    'ruleId',
    'approvalRequestId',
    'retryAfterSeconds',
    'entitlementKey',
  ];
  for (const key of optional) {
    const value = input[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as unknown as ProblemDetails;
}

/**
 * Default titles per problem type. Kept here so every service produces the same
 * wording — docs/06 §1.1 heuristic 4 ("one pattern per job across 177 modules").
 */
export const PROBLEM_TITLES: Readonly<Record<ProblemTypeKey, string>> = Object.freeze({
  [ProblemType.VALIDATION_FAILED]: 'Some details need correcting',
  [ProblemType.MALFORMED_REQUEST]: 'The request could not be read',
  [ProblemType.IDEMPOTENCY_KEY_REUSED]: 'This action was already submitted',
  [ProblemType.IDEMPOTENCY_KEY_MISSING]: 'This action needs an idempotency key',
  [ProblemType.STALE_CONTEXT]: 'The record changed while you were working on it',
  [ProblemType.OPTIMISTIC_LOCK_CONFLICT]: 'Someone else saved this record first',
  [ProblemType.UNAUTHENTICATED]: 'Please sign in',
  [ProblemType.SESSION_EXPIRED]: 'Your session has expired',
  [ProblemType.MFA_REQUIRED]: 'Two-factor authentication is required',
  [ProblemType.STEP_UP_REQUIRED]: 'Please confirm your identity again',
  [ProblemType.PERMISSION_DENIED]: 'You do not have permission for this action',
  [ProblemType.ABAC_CONDITION_FAILED]: 'This is outside your assigned scope',
  [ProblemType.SEGREGATION_OF_DUTIES]: 'You cannot approve your own request',
  [ProblemType.SECOND_PERSON_REQUIRED]: 'A second authorised person is required',
  [ProblemType.BREAK_GLASS_REASON_REQUIRED]: 'A reason is required to open this record',
  [ProblemType.ACCOUNT_LOCKED]: 'This account is locked',
  [ProblemType.TENANT_MISMATCH]: 'Not available',
  [ProblemType.BRANCH_NOT_GRANTED]: 'You do not have access to this branch',
  [ProblemType.NOT_FOUND]: 'Not available',
  [ProblemType.CONFLICT]: 'This conflicts with the current state',
  [ProblemType.ALREADY_DECIDED]: 'This has already been decided',
  [ProblemType.GONE]: 'This is no longer available',
  [ProblemType.RETIRED_MASTER_RECORD]: 'This record has been retired',
  [ProblemType.BUSINESS_RULE_VIOLATED]: 'This is not allowed by hospital policy',
  [ProblemType.CLINICAL_HARD_STOP]: 'Stopped for patient safety',
  [ProblemType.APPROVAL_REQUIRED]: 'This needs approval first',
  [ProblemType.NUMBERING_SERIES_EXHAUSTED]: 'The numbering series needs attention',
  [ProblemType.STATUTORY_LIMIT]: 'A statutory limit prevents this',
  [ProblemType.NOT_LICENSED]: 'Not included in your plan',
  [ProblemType.QUOTA_EXCEEDED]: 'Your plan limit has been reached',
  [ProblemType.RATE_LIMITED]: 'Too many attempts — please wait',
  [ProblemType.INTERNAL_ERROR]: 'Something went wrong on our side',
  [ProblemType.DEPENDENCY_UNAVAILABLE]: 'A system this depends on is unavailable',
  [ProblemType.READ_ONLY_MODE]: 'The system is temporarily read-only',
  [ProblemType.NOT_IMPLEMENTED]: 'Not available yet',
});

export const PROBLEM_STATUS: Readonly<Record<ProblemTypeKey, number>> = Object.freeze({
  [ProblemType.VALIDATION_FAILED]: 400,
  [ProblemType.MALFORMED_REQUEST]: 400,
  [ProblemType.IDEMPOTENCY_KEY_REUSED]: 409,
  [ProblemType.IDEMPOTENCY_KEY_MISSING]: 400,
  [ProblemType.STALE_CONTEXT]: 409,
  [ProblemType.OPTIMISTIC_LOCK_CONFLICT]: 409,
  [ProblemType.UNAUTHENTICATED]: 401,
  [ProblemType.SESSION_EXPIRED]: 401,
  [ProblemType.MFA_REQUIRED]: 401,
  [ProblemType.STEP_UP_REQUIRED]: 401,
  [ProblemType.PERMISSION_DENIED]: 403,
  [ProblemType.ABAC_CONDITION_FAILED]: 403,
  [ProblemType.SEGREGATION_OF_DUTIES]: 403,
  [ProblemType.SECOND_PERSON_REQUIRED]: 403,
  [ProblemType.BREAK_GLASS_REASON_REQUIRED]: 403,
  [ProblemType.ACCOUNT_LOCKED]: 403,
  // 404, deliberately: docs/09 §3.1 case 2 — "must be 404 (not 403 — do not leak existence)".
  [ProblemType.TENANT_MISMATCH]: 404,
  [ProblemType.BRANCH_NOT_GRANTED]: 403,
  [ProblemType.NOT_FOUND]: 404,
  [ProblemType.CONFLICT]: 409,
  [ProblemType.ALREADY_DECIDED]: 409,
  [ProblemType.GONE]: 410,
  [ProblemType.RETIRED_MASTER_RECORD]: 422,
  [ProblemType.BUSINESS_RULE_VIOLATED]: 422,
  [ProblemType.CLINICAL_HARD_STOP]: 422,
  [ProblemType.APPROVAL_REQUIRED]: 422,
  [ProblemType.NUMBERING_SERIES_EXHAUSTED]: 500,
  [ProblemType.STATUTORY_LIMIT]: 422,
  [ProblemType.NOT_LICENSED]: 402,
  [ProblemType.QUOTA_EXCEEDED]: 402,
  [ProblemType.RATE_LIMITED]: 429,
  [ProblemType.INTERNAL_ERROR]: 500,
  [ProblemType.DEPENDENCY_UNAVAILABLE]: 503,
  [ProblemType.READ_ONLY_MODE]: 503,
  [ProblemType.NOT_IMPLEMENTED]: 501,
});
