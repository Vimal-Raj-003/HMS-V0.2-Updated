import { getPermission, type AbacConditions, type PolicyContext, type PolicyResource } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import { evaluate, withinAmountLimit, withinTimeWindow, type LicenceState } from './policy.engine.js';

/**
 * The authorisation engine is the code that decides whether a nurse may open a
 * chart or a cashier may waive a bill. Every branch is tested, and the tests are
 * written against REAL keys from `packages/contracts`' catalogue rather than
 * invented ones — a test using a made-up permission would keep passing after the
 * catalogue changed underneath it.
 */

const HOSP_A = '11111111-1111-7111-8111-111111111111';
const HOSP_B = '22222222-2222-7222-8222-222222222222';
const BRANCH_A = 'aaaaaaaa-1111-7111-8111-111111111111';
const BRANCH_B = 'bbbbbbbb-2222-7222-8222-222222222222';
const USER = '33333333-3333-7333-8333-333333333333';
const OTHER_USER = '44444444-4444-7444-8444-444444444444';
const PATIENT = '55555555-5555-7555-8555-555555555555';
const WARD_A = '66666666-6666-7666-8666-666666666666';
const DEPT_A = '77777777-7777-7777-8777-777777777777';

// Real keys, resolved from the catalogue so a rename breaks the test loudly.
const PLAIN = 'admin.user.read';
const PHI_READ = 'admin.audit.read';
const REASON_REQUIRED = 'admin.user.deactivate';
const STEP_UP = 'admin.settings.configure';
const SECOND_PERSON = 'barcode.verify.blood';
const SAFETY_EXEMPT = 'notify.publish';

const NOW = Date.parse('2026-08-19T10:00:00+05:30');

function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    hospitalId: HOSP_A,
    branchId: BRANCH_A,
    grantedBranchIds: [BRANCH_A],
    scope: 'branch',
    userId: USER,
    roleKeys: ['hospital_admin'],
    permissions: new Set([PLAIN, PHI_READ, REASON_REQUIRED, STEP_UP, SECOND_PERSON, SAFETY_EXEMPT]),
    conditions: [],
    authContext: { acr: 'aal2', amr: ['pwd', 'otp'], authTimeMs: NOW - 30_000, method: 'password' },
    impersonatorUserId: null,
    nowMs: NOW,
    timezone: 'Asia/Kolkata',
    ...overrides,
  };
}

const resource = (o: Partial<PolicyResource> = {}): PolicyResource => ({
  type: 'user',
  hospitalId: HOSP_A,
  ...o,
});

describe('catalogue integrity — the keys these tests rely on', () => {
  it.each([PLAIN, PHI_READ, REASON_REQUIRED, STEP_UP, SECOND_PERSON, SAFETY_EXEMPT])(
    '%s is a registered permission',
    (key) => {
      expect(getPermission(key)).toBeDefined();
    },
  );

  it('the flagged keys still carry the flags these tests assert on', () => {
    expect(getPermission(PHI_READ)?.phiRead).toBe(true);
    expect(getPermission(REASON_REQUIRED)?.requiresReason).toBe(true);
    expect(getPermission(STEP_UP)?.requiresStepUp).toBe(true);
    expect(getPermission(SECOND_PERSON)?.requiresSecondPerson).toBe(true);
    expect(getPermission(SAFETY_EXEMPT)?.clinicalSafetyExempt).toBe(true);
  });
});

describe('deny by default', () => {
  it('refuses a permission that is not in the catalogue', () => {
    const d = evaluate({ permission: 'made.up.key', context: ctx(), resource: resource() });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('unregistered_permission');
  });

  it('refuses a registered permission the user does not hold', () => {
    const d = evaluate({
      permission: PLAIN,
      context: ctx({ permissions: new Set<string>() }),
      resource: resource(),
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('missing_permission');
  });
});

describe('tenancy is checked before anything else', () => {
  it('refuses a resource belonging to another hospital', () => {
    const d = evaluate({ permission: PLAIN, context: ctx(), resource: resource({ hospitalId: HOSP_B }) });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('tenant_mismatch');
  });

  /**
   * docs/09 §3.1: a cross-tenant denial must not leak that the row exists. The
   * message a user sees is "Not found.", and `primitives/problem.ts` maps
   * TENANT_MISMATCH to 404 rather than 403 for the same reason.
   */
  it('does not disclose existence in the cross-tenant message', () => {
    const d = evaluate({ permission: PLAIN, context: ctx(), resource: resource({ hospitalId: HOSP_B }) });
    if (!d.allowed) {
      expect(d.message).toBe('Not found.');
      expect(d.message.toLowerCase()).not.toContain('permission');
      expect(d.message.toLowerCase()).not.toContain('hospital');
    }
  });

  it('permits a group-scoped session to reach another hospital', () => {
    const d = evaluate({
      permission: PLAIN,
      context: ctx({ scope: 'group' }),
      resource: resource({ hospitalId: HOSP_B }),
    });
    expect(d.allowed).toBe(true);
  });

  it('refuses a branch outside the grant', () => {
    const d = evaluate({ permission: PLAIN, context: ctx(), resource: resource({ branchId: BRANCH_B }) });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('branch_not_granted');
  });
});

describe('licence gating never reaches clinical safety', () => {
  const nothingLicensed: LicenceState = { isModuleEnabled: () => false };

  it('blocks an ordinary permission when the module is unlicensed', () => {
    const d = evaluate({ permission: PLAIN, context: ctx(), resource: resource(), licence: nothingLicensed });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('not_licensed');
  });

  /**
   * EN-040 §5: "Clinical safety is never gated." If this test fails, an unpaid
   * invoice can switch off a safety control — a patient-safety regression, not a
   * billing one.
   */
  it('still permits a clinical-safety-exempt permission when nothing is licensed', () => {
    const d = evaluate({
      permission: SAFETY_EXEMPT,
      context: ctx(),
      resource: resource(),
      licence: nothingLicensed,
    });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.trace).toContain('licence:exempt');
  });
});

describe('ABAC conditions', () => {
  const withConditions = (conditions: AbacConditions) => ctx({ conditions: [conditions] });

  it('enforces ownPatientsOnly', () => {
    const denied = evaluate({
      permission: PLAIN,
      context: withConditions({ ownPatientsOnly: true }),
      resource: resource({ patientId: PATIENT, isOwnPatient: false }),
    });
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.reason).toBe('not_own_patient');

    const allowed = evaluate({
      permission: PLAIN,
      context: withConditions({ ownPatientsOnly: true }),
      resource: resource({ patientId: PATIENT, isOwnPatient: true }),
    });
    expect(allowed.allowed).toBe(true);
  });

  it('enforces ward and department scope', () => {
    const ward = evaluate({
      permission: PLAIN,
      context: withConditions({ wardIds: [WARD_A] }),
      resource: resource({ wardId: 'ffffffff-ffff-7fff-8fff-ffffffffffff' }),
    });
    expect(ward.allowed).toBe(false);
    if (!ward.allowed) expect(ward.reason).toBe('ward_out_of_scope');

    const dept = evaluate({
      permission: PLAIN,
      context: withConditions({ departmentIds: [DEPT_A] }),
      resource: resource({ departmentId: 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee' }),
    });
    expect(dept.allowed).toBe(false);
    if (!dept.allowed) expect(dept.reason).toBe('department_out_of_scope');
  });

  it('enforces ownQueueOnly', () => {
    const d = evaluate({
      permission: PLAIN,
      context: withConditions({ ownQueueOnly: true }),
      resource: resource({ queueOwnerUserId: OTHER_USER }),
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('not_own_queue');
  });

  it('requires a registered device when deviceBound is set', () => {
    const d = evaluate({
      permission: PLAIN,
      context: withConditions({ deviceBound: true }),
      resource: resource(),
      deviceBound: false,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('device_not_bound');
  });

  it('enforces an IP allowlist', () => {
    const blocked = evaluate({
      permission: PLAIN,
      context: withConditions({ ipAllowlist: ['10.0.0.1'] }),
      resource: resource(),
      ip: '203.0.113.9',
    });
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.reason).toBe('ip_not_allowed');

    const permitted = evaluate({
      permission: PLAIN,
      context: withConditions({ ipAllowlist: ['10.0.0.1'] }),
      resource: resource(),
      ip: '10.0.0.1',
    });
    expect(permitted.allowed).toBe(true);
  });

  it('returns a mask obligation rather than silently masking', () => {
    const d = evaluate({
      permission: PLAIN,
      context: withConditions({ dataClassMasks: ['aadhaar', 'mobile'] }),
      resource: resource(),
    });
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.obligations).toContainEqual({ kind: 'mask_fields', fields: ['aadhaar', 'mobile'] });
    }
  });

  /**
   * Roles are additive: a doctor who is also an HOD holds two grants. If the
   * engine intersected them, adding a role could remove access the user already
   * had — surprising anywhere, dangerous in a hospital.
   */
  it('permits when ANY single grant permits, not only when all do', () => {
    const d = evaluate({
      permission: PLAIN,
      context: ctx({ conditions: [{ ownPatientsOnly: true }, {}] }),
      resource: resource({ patientId: PATIENT, isOwnPatient: false }),
    });
    expect(d.allowed).toBe(true);
  });
});

describe('care team and break-glass', () => {
  const careTeam = ctx({ conditions: [{ careTeamOnly: true }] });

  it('refuses a chart outside the care team when no reason is given', () => {
    const d = evaluate({ permission: PLAIN, context: careTeam, resource: resource({ patientId: PATIENT }) });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('not_care_team');
  });

  it('permits it with a reason, and records break-glass plus a PHI-read obligation', () => {
    const d = evaluate({
      permission: PLAIN,
      context: careTeam,
      resource: resource({ patientId: PATIENT }),
      reason: 'Patient collapsed in corridor; treating as emergency.',
    });
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.obligations).toContainEqual({ kind: 'break_glass', patientId: PATIENT });
      expect(d.obligations).toContainEqual({ kind: 'write_phi_read_audit', patientId: PATIENT });
    }
  });

  it('does not accept whitespace as a break-glass reason', () => {
    const d = evaluate({
      permission: PLAIN,
      context: careTeam,
      resource: resource({ patientId: PATIENT }),
      reason: '   ',
    });
    expect(d.allowed).toBe(false);
  });
});

describe('extra friction: reason, second person, step-up', () => {
  it('requires a reason where the catalogue demands one', () => {
    const without = evaluate({ permission: REASON_REQUIRED, context: ctx(), resource: resource() });
    expect(without.allowed).toBe(false);
    if (!without.allowed) expect(without.reason).toBe('reason_required');

    const with_ = evaluate({
      permission: REASON_REQUIRED,
      context: ctx(),
      resource: resource(),
      reason: 'Employee left the organisation on 2026-08-15.',
    });
    expect(with_.allowed).toBe(true);
    if (with_.allowed) expect(with_.obligations).toContainEqual({ kind: 'capture_reason' });
  });

  it('requires a second, DIFFERENT person', () => {
    const none = evaluate({ permission: SECOND_PERSON, context: ctx(), resource: resource() });
    expect(none.allowed).toBe(false);
    if (!none.allowed) expect(none.reason).toBe('second_person_required');

    // The most likely real-world bug: the same user "confirming" their own action.
    const self = evaluate({
      permission: SECOND_PERSON,
      context: ctx(),
      resource: resource(),
      secondPersonUserId: USER,
    });
    expect(self.allowed).toBe(false);
    if (!self.allowed) expect(self.reason).toBe('second_person_required');

    const other = evaluate({
      permission: SECOND_PERSON,
      context: ctx(),
      resource: resource(),
      secondPersonUserId: OTHER_USER,
    });
    expect(other.allowed).toBe(true);
  });

  it('requires fresh authentication for step-up permissions', () => {
    const stale = evaluate({
      permission: STEP_UP,
      context: ctx({
        authContext: { acr: 'aal2', amr: ['pwd'], authTimeMs: NOW - 10 * 60_000, method: 'password' },
      }),
      resource: resource(),
    });
    expect(stale.allowed).toBe(false);
    if (!stale.allowed) expect(stale.reason).toBe('step_up_required');

    const fresh = evaluate({ permission: STEP_UP, context: ctx(), resource: resource() });
    expect(fresh.allowed).toBe(true);
  });
});

describe('audit obligations are always returned', () => {
  it('always includes write_audit', () => {
    const d = evaluate({ permission: PLAIN, context: ctx(), resource: resource() });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.obligations).toContainEqual({ kind: 'write_audit', action: PLAIN });
  });

  it('adds a PHI-read obligation for PHI-bearing reads', () => {
    const d = evaluate({ permission: PHI_READ, context: ctx(), resource: resource({ patientId: PATIENT }) });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.obligations).toContainEqual({ kind: 'write_phi_read_audit', patientId: PATIENT });
  });
});

describe('amount limits use decimal arithmetic, never floats', () => {
  it('accepts at the boundary and rejects just above it', () => {
    expect(
      withinAmountLimit(
        { maxAmount: '5000.00', combine: 'whichever_is_lower' },
        { type: 'bill', amount: '5000.00' },
      ),
    ).toBe(true);
    expect(
      withinAmountLimit(
        { maxAmount: '5000.00', combine: 'whichever_is_lower' },
        { type: 'bill', amount: '5000.01' },
      ),
    ).toBe(false);
  });

  it('handles a value classic float arithmetic gets wrong', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in binary floating point.
    expect(
      withinAmountLimit(
        { maxAmount: '0.30', combine: 'whichever_is_lower' },
        { type: 'bill', amount: '0.30' },
      ),
    ).toBe(true);
  });

  it('whichever_is_lower requires BOTH ceilings to pass', () => {
    const limit = { maxAmount: '25000.00', maxPercent: '25', combine: 'whichever_is_lower' as const };
    expect(withinAmountLimit(limit, { type: 'bill', amount: '20000.00', percent: '30' })).toBe(false);
    expect(withinAmountLimit(limit, { type: 'bill', amount: '30000.00', percent: '10' })).toBe(false);
    expect(withinAmountLimit(limit, { type: 'bill', amount: '20000.00', percent: '10' })).toBe(true);
  });

  it('whichever_is_higher passes when either ceiling passes', () => {
    const limit = { maxAmount: '25000.00', maxPercent: '25', combine: 'whichever_is_higher' as const };
    expect(withinAmountLimit(limit, { type: 'bill', amount: '20000.00', percent: '30' })).toBe(true);
  });

  it('denies through the engine when the limit is exceeded', () => {
    const d = evaluate({
      permission: PLAIN,
      context: ctx({ conditions: [{ amountLimit: { maxPercent: '10', combine: 'whichever_is_lower' } }] }),
      resource: resource({ percent: '25' }),
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('amount_limit_exceeded');
  });
});

describe('time windows', () => {
  const tz = 'Asia/Kolkata';
  const at = (iso: string) => Date.parse(iso);

  it('matches inside a daytime window', () => {
    expect(
      withinTimeWindow(
        { daysOfWeek: [], startTime: '09:00', endTime: '17:00', crossesMidnight: false },
        at('2026-08-19T10:00:00+05:30'),
        tz,
      ),
    ).toBe(true);
    expect(
      withinTimeWindow(
        { daysOfWeek: [], startTime: '09:00', endTime: '17:00', crossesMidnight: false },
        at('2026-08-19T18:00:00+05:30'),
        tz,
      ),
    ).toBe(false);
  });

  /**
   * A night shift is written 22:00 -> 06:00. Compared naively as start <= now
   * <= end it would never match, and the night staff would be locked out of the
   * system at 02:00 — the shift where a lockout matters most.
   */
  it('matches across midnight for a night shift', () => {
    const night = { daysOfWeek: [], startTime: '22:00', endTime: '06:00', crossesMidnight: true };
    expect(withinTimeWindow(night, at('2026-08-19T23:30:00+05:30'), tz)).toBe(true);
    expect(withinTimeWindow(night, at('2026-08-20T02:00:00+05:30'), tz)).toBe(true);
    expect(withinTimeWindow(night, at('2026-08-20T12:00:00+05:30'), tz)).toBe(false);
  });

  it('infers the midnight crossing even when the flag is not set', () => {
    const night = { daysOfWeek: [], startTime: '22:00', endTime: '06:00', crossesMidnight: false };
    expect(withinTimeWindow(night, at('2026-08-20T02:00:00+05:30'), tz)).toBe(true);
  });

  it('respects days of the week in the hospital timezone', () => {
    // 2026-08-19 is a Wednesday (ISO day 3) in Asia/Kolkata.
    const wed = { daysOfWeek: [3], startTime: '00:00', endTime: '23:59', crossesMidnight: false };
    expect(withinTimeWindow(wed, at('2026-08-19T10:00:00+05:30'), tz)).toBe(true);
    expect(withinTimeWindow(wed, at('2026-08-20T10:00:00+05:30'), tz)).toBe(false);
  });

  it('evaluates in the hospital timezone, not the server timezone', () => {
    // 20:00 UTC on the 19th is 01:30 on the 20th in Kolkata — inside a night window.
    const night = { daysOfWeek: [], startTime: '22:00', endTime: '06:00', crossesMidnight: true };
    expect(withinTimeWindow(night, at('2026-08-19T20:00:00Z'), tz)).toBe(true);
    expect(withinTimeWindow(night, at('2026-08-19T20:00:00Z'), 'UTC')).toBe(false);
  });

  it('denies through the engine outside the window', () => {
    const d = evaluate({
      permission: PLAIN,
      context: ctx({
        conditions: [
          { timeWindow: { daysOfWeek: [], startTime: '22:00', endTime: '06:00', crossesMidnight: true } },
        ],
      }),
      resource: resource(),
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('outside_time_window');
  });
});

describe('decision trace', () => {
  it('records the path taken, so a denial can be explained to a user', () => {
    const d = evaluate({ permission: PLAIN, context: ctx(), resource: resource() });
    expect(d.trace).toEqual(
      expect.arrayContaining(['catalogue:hit', 'tenant:ok', 'rbac:hit', 'branch:ok', 'abac:ok']),
    );
  });
});

/**
 * A `requiresSecondPerson` key is denied unless the engine is handed a
 * co-signer, and `PolicyService` had no way to hand it one — so paying a
 * refund, voiding a receipt and prescribing a Schedule X drug denied every
 * caller, including the person entitled to do it. Two modules met that
 * separately and each worked around it locally.
 *
 * These assertions pin the engine half of the contract `PolicyService.assert`'s
 * `options.secondPersonUserId` now satisfies.
 */
describe('a second-person key needs a second person', () => {
  it('refuses when no co-signer is supplied', () => {
    const d = evaluate({ permission: SECOND_PERSON, context: ctx(), resource: resource() });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('second_person_required');
  });

  it('refuses a co-signer who is the actor', () => {
    // Self-countersigning defeats the whole control while looking satisfied.
    const context = ctx();
    const d = evaluate({
      permission: SECOND_PERSON,
      context,
      resource: resource(),
      secondPersonUserId: context.userId,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('second_person_required');
  });

  it('allows a different co-signer, and says the obligation was met', () => {
    const d = evaluate({
      permission: SECOND_PERSON,
      context: ctx(),
      resource: resource(),
      secondPersonUserId: '00000000-0000-7000-8000-0000000000ff',
    });
    expect(d.allowed, JSON.stringify(d)).toBe(true);
    if (d.allowed) {
      expect(d.obligations.map((o) => o.kind)).toContain('require_second_person');
    }
  });
});
