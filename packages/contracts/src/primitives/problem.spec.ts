import { describe, expect, it } from 'vitest';
import { PROBLEM_BASE_URI, PROBLEM_STATUS, PROBLEM_TITLES, ProblemType, buildProblem } from './problem.js';
import type { ProblemTypeKey } from './problem.js';

/**
 * RFC 9457 is the single error shape of the API (`CLAUDE.md §4`). The tests here
 * are about three things that would be silent failures if they broke:
 * the tenant-mismatch status (`docs/09 §3.1` — 404, never 403), the completeness
 * of the title/status maps, and `buildProblem` not emitting keys it was not given
 * (`exactOptionalPropertyTypes`).
 */

const ALL_TYPES = Object.values(ProblemType) as ProblemTypeKey[];

describe('problem type catalogue', () => {
  it('registers every type exactly once', () => {
    // A duplicated slug would silently overwrite a title and a status.
    expect(new Set(ALL_TYPES).size).toBe(ALL_TYPES.length);
  });

  it('names every type as a lower kebab-case slug, because the URI is forever', () => {
    // docs/09 §4: renaming a shipped `type` is a breaking API change.
    for (const type of ALL_TYPES) {
      expect(type, `"${type}" is not a kebab-case slug`).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    }
  });

  it('gives every type both a title and a status, with nothing left over', () => {
    for (const type of ALL_TYPES) {
      expect(PROBLEM_TITLES[type], `${type} has no title`).toBeTruthy();
      expect(PROBLEM_STATUS[type], `${type} has no status`).toBeGreaterThan(0);
    }
    expect(Object.keys(PROBLEM_TITLES).sort()).toEqual([...ALL_TYPES].sort());
    expect(Object.keys(PROBLEM_STATUS).sort()).toEqual([...ALL_TYPES].sort());
  });

  it('freezes both maps so a module cannot reword another module’s error', () => {
    // docs/06 §1.1 heuristic 4: one pattern per job across 177 modules.
    expect(Object.isFrozen(PROBLEM_TITLES)).toBe(true);
    expect(Object.isFrozen(PROBLEM_STATUS)).toBe(true);
  });

  it('uses only HTTP status codes a client can act on', () => {
    for (const type of ALL_TYPES) {
      const status = PROBLEM_STATUS[type];
      expect(status, `${type} has status ${status}`).toBeGreaterThanOrEqual(400);
      expect(status, `${type} has status ${status}`).toBeLessThan(600);
    }
  });

  it('answers a cross-tenant reference with 404, never 403', () => {
    // docs/09 §3.1 case 2: "must be 404 (not 403 — do not leak existence)".
    // A 403 here tells hospital B that hospital A's record id is real.
    expect(PROBLEM_STATUS[ProblemType.TENANT_MISMATCH]).toBe(404);
    expect(PROBLEM_STATUS[ProblemType.TENANT_MISMATCH]).not.toBe(403);
  });

  it('makes a cross-tenant reference indistinguishable from a genuine miss', () => {
    // Same status is not enough: a different *title* leaks existence just as well.
    expect(PROBLEM_TITLES[ProblemType.TENANT_MISMATCH]).toBe(PROBLEM_TITLES[ProblemType.NOT_FOUND]);
  });

  it('keeps branch-not-granted at 403, because that branch is not a secret from its own tenant', () => {
    // docs/09 §3.1 case 6 is about scope inside one hospital, not about existence.
    expect(PROBLEM_STATUS[ProblemType.BRANCH_NOT_GRANTED]).toBe(403);
  });

  it('maps licence and quota refusals to 402, not to 403', () => {
    // EN-040: a commercial refusal must be distinguishable from a permission
    // refusal, or the UI offers "request access" where it should offer "upgrade".
    expect(PROBLEM_STATUS[ProblemType.NOT_LICENSED]).toBe(402);
    expect(PROBLEM_STATUS[ProblemType.QUOTA_EXCEEDED]).toBe(402);
  });

  it('maps semantic refusals to 422 so a client does not retry them as validation errors', () => {
    for (const type of [
      ProblemType.BUSINESS_RULE_VIOLATED,
      ProblemType.CLINICAL_HARD_STOP,
      ProblemType.APPROVAL_REQUIRED,
      ProblemType.STATUTORY_LIMIT,
      ProblemType.RETIRED_MASTER_RECORD,
    ]) {
      expect(PROBLEM_STATUS[type], `${type} should be 422`).toBe(422);
    }
  });

  it('maps every concurrency and replay refusal to 409', () => {
    for (const type of [
      ProblemType.IDEMPOTENCY_KEY_REUSED,
      ProblemType.STALE_CONTEXT,
      ProblemType.OPTIMISTIC_LOCK_CONFLICT,
      ProblemType.CONFLICT,
      ProblemType.ALREADY_DECIDED,
    ]) {
      expect(PROBLEM_STATUS[type], `${type} should be 409`).toBe(409);
    }
  });

  it('tells a clinician what happened rather than naming our internals', () => {
    // docs/06 §1.1 heuristic 9. A title containing "exception", "SQL" or "null" is
    // a developer message that escaped into a bedside screen.
    for (const type of ALL_TYPES) {
      const title = PROBLEM_TITLES[type];
      expect(title.length, `${type} title is too terse`).toBeGreaterThan(6);
      expect(title.length, `${type} title is too long for a toast`).toBeLessThanOrEqual(60);
      expect(title, `${type} title leaks an internal term`).not.toMatch(
        /exception|sql|null|undefined|stack|SKU|entitlement/i,
      );
      expect(title[0], `${type} title should start with a capital`).toBe(title[0]?.toUpperCase());
    }
  });

  it('says a hard stop is about safety, not about a rule engine', () => {
    // docs/06 §5.2: the hard-stop wording is what a nurse reads mid-administration.
    expect(PROBLEM_TITLES[ProblemType.CLINICAL_HARD_STOP]).toMatch(/safety/i);
  });
});

describe('buildProblem', () => {
  const base = {
    type: ProblemType.VALIDATION_FAILED,
    status: 400,
    title: PROBLEM_TITLES[ProblemType.VALIDATION_FAILED],
    reference: 'trace_01HZX',
  } as const;

  it('renders the type as an absolute URI under the stable error namespace', () => {
    // RFC 9457 requires `type` to be a URI; clients switch on it.
    expect(buildProblem(base).type).toBe(`${PROBLEM_BASE_URI}/validation-failed`);
    expect(buildProblem(base).type.startsWith('https://')).toBe(true);
  });

  it('always carries the reference the user reads out to the helpdesk', () => {
    const problem = buildProblem(base);
    expect(problem.reference).toBe('trace_01HZX');
    expect(problem.status).toBe(400);
    expect(problem.title).toBe(base.title);
  });

  it('omits every optional key it was not given, rather than emitting undefined', () => {
    // `exactOptionalPropertyTypes`: `{"detail": undefined}` serialises to a key
    // that the client's Zod schema then has to tolerate. It must simply be absent.
    const problem = buildProblem(base);
    for (const key of [
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
    ]) {
      expect(Object.hasOwn(problem, key), `${key} should be absent`).toBe(false);
    }
    expect(JSON.stringify(problem)).not.toContain('undefined');
  });

  it('keeps a falsy-but-present value, so "retry after 0 seconds" is not lost', () => {
    const problem = buildProblem({
      ...base,
      type: ProblemType.RATE_LIMITED,
      status: 429,
      retryAfterSeconds: 0,
    });
    expect(Object.hasOwn(problem, 'retryAfterSeconds')).toBe(true);
    expect(problem.retryAfterSeconds).toBe(0);
  });

  it('carries the field errors the UI attaches to each input', () => {
    const problem = buildProblem({
      ...base,
      detail: 'Two fields need correcting.',
      errors: [
        { path: 'items/0/quantity', message: 'Must be at least 1', code: 'too_small' },
        { path: 'mobile', message: 'Enter a 10-digit Indian mobile number' },
      ],
    });
    expect(problem.errors).toHaveLength(2);
    expect(problem.errors?.[0]?.path).toBe('items/0/quantity');
  });

  it('names the missing permission so the UI can offer "request access"', () => {
    const problem = buildProblem({
      type: ProblemType.PERMISSION_DENIED,
      status: PROBLEM_STATUS[ProblemType.PERMISSION_DENIED],
      title: PROBLEM_TITLES[ProblemType.PERMISSION_DENIED],
      reference: 'trace_01HZY',
      requiredPermission: 'admin.role.assign',
    });
    expect(problem.requiredPermission).toBe('admin.role.assign');
    expect(problem.status).toBe(403);
  });

  it('carries the rule id, clinical impact and next action for a hard stop', () => {
    // docs/06 §1.1 heuristic 9: what happened, what it means clinically, what to
    // do next, and the reference id.
    const problem = buildProblem({
      type: ProblemType.CLINICAL_HARD_STOP,
      status: PROBLEM_STATUS[ProblemType.CLINICAL_HARD_STOP],
      title: PROBLEM_TITLES[ProblemType.CLINICAL_HARD_STOP],
      reference: 'trace_01HZZ',
      ruleId: 'ALLERGY_ANAPHYLAXIS',
      clinicalImpact: 'A documented anaphylaxis allergy matches this drug.',
      nextAction: 'Choose an alternative drug or ask the consultant to review the allergy record.',
      instance: '/api/v1/prescriptions',
    });
    expect(problem.ruleId).toBe('ALLERGY_ANAPHYLAXIS');
    expect(problem.clinicalImpact).toBeTruthy();
    expect(problem.nextAction).toBeTruthy();
    expect(problem.instance).toBe('/api/v1/prescriptions');
  });

  it('carries the entitlement key so a 402 can name what to buy', () => {
    const problem = buildProblem({
      type: ProblemType.NOT_LICENSED,
      status: PROBLEM_STATUS[ProblemType.NOT_LICENSED],
      title: PROBLEM_TITLES[ProblemType.NOT_LICENSED],
      reference: 'trace_01J00',
      entitlementKey: 'module.api_gateway.enabled',
      approvalRequestId: '0194f2c0-0000-7000-8000-000000000009',
    });
    expect(problem.entitlementKey).toBe('module.api_gateway.enabled');
    expect(problem.approvalRequestId).toBeTruthy();
  });

  it('produces a distinct URI for every registered type', () => {
    const uris = ALL_TYPES.map((type) => buildProblem({ ...base, type }).type);
    expect(new Set(uris).size).toBe(ALL_TYPES.length);
  });
});
