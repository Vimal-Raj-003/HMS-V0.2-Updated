import { ENTITLEMENT_CACHE_MAX_AGE_SECONDS, type EnforcementPoint } from '@vims/contracts';
import { describe, expect, it } from 'vitest';

import { createFlagEvaluator } from './evaluator.js';
import { FlagDisabledError, type LicenceSnapshot, type ResolvedFlagSet } from './types.js';

const ACTIVE: LicenceSnapshot = {
  status: 'active',
  degradeTier: 0,
  expiresAt: '2027-03-31T00:00:00.000Z',
  fromCache: false,
  cacheAgeSeconds: 0,
};

function flagSet(patch: Partial<ResolvedFlagSet> = {}): ResolvedFlagSet {
  return {
    hospitalId: 'h-1',
    branchId: 'b-1',
    licence: ACTIVE,
    entitlements: [
      'module.multi_branch.enabled',
      'module.integration_hub.enabled',
      'module.sso.enabled',
      'module.email.enabled',
    ],
    overrides: {},
    branchOverrides: {},
    ...patch,
  };
}

describe('a licensed module', () => {
  it('is enabled with reason "entitled"', () => {
    const decision = createFlagEvaluator(flagSet()).evaluate('module.sso.enabled');
    expect(decision.enabled).toBe(true);
    expect(decision.reason).toBe('entitled');
    expect(decision.degradeTier).toBe(0);
  });
});

describe('a licence-disabled module is blocked', () => {
  it('is blocked when it is simply not in the plan, with the plan message and an upgrade CTA', () => {
    const decision = createFlagEvaluator(flagSet({ entitlements: [] })).evaluate(
      'module.multi_branch.enabled',
    );
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe('not_licensed');
    expect(decision.message).toBe('Multiple branches are not included in your plan.');
    expect(decision.upgradeCta).toBe('Ask about Enterprise Group');
  });

  it('is blocked at the degradation tier that restricts it (EN-040 §3.5 tier 2)', () => {
    const evaluator = createFlagEvaluator(
      flagSet({ licence: { ...ACTIVE, status: 'soft_degraded', degradeTier: 2 } }),
    );
    expect(evaluator.evaluate('module.api_gateway.enabled').reason).toBe('licence_degraded');
    expect(evaluator.isEnabled('module.integration_hub.enabled')).toBe(false);
    // SSO is only restricted from tier 3, so it still works at tier 2.
    expect(evaluator.isEnabled('module.sso.enabled')).toBe(true);
  });

  it('is blocked wholesale when the subscription is suspended or terminated', () => {
    for (const status of ['suspended', 'terminated'] as const) {
      const evaluator = createFlagEvaluator(flagSet({ licence: { ...ACTIVE, status, degradeTier: 0 } }));
      const decision = evaluator.evaluate('module.sso.enabled');
      expect(decision.enabled, status).toBe(false);
      expect(decision.reason, status).toBe('licence_suspended');
      expect(decision.degradeTier, status).toBe(4);
    }
  });

  it('is blocked when the cached entitlement document has aged past 72 h (fails closed for commercial)', () => {
    const decision = createFlagEvaluator(
      flagSet({
        licence: { ...ACTIVE, fromCache: true, cacheAgeSeconds: ENTITLEMENT_CACHE_MAX_AGE_SECONDS + 1 },
      }),
    ).evaluate('module.sso.enabled');
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe('cache_expired_fail_closed');
    expect(decision.message).toContain('could not confirm your plan');
  });

  it('is still trusted while the cache is inside the 72 h window', () => {
    const evaluator = createFlagEvaluator(
      flagSet({
        licence: { ...ACTIVE, fromCache: true, cacheAgeSeconds: ENTITLEMENT_CACHE_MAX_AGE_SECONDS },
      }),
    );
    expect(evaluator.isEnabled('module.sso.enabled')).toBe(true);
  });

  it('throws a FlagDisabledError carrying the decision, for a route guard', () => {
    const evaluator = createFlagEvaluator(flagSet({ entitlements: [] }));
    expect(() => evaluator.assertEnabled('module.sso.enabled')).toThrow(FlagDisabledError);
    try {
      evaluator.assertEnabled('module.sso.enabled');
      expect.unreachable('assertEnabled must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(FlagDisabledError);
      expect((error as FlagDisabledError).decision.reason).toBe('not_licensed');
    }
    expect(() => evaluator.assertEnabled('module.audit.enabled')).not.toThrow();
  });
});

describe('a clinical-safety-exempt key is NOT blocked', () => {
  const expiredEverything = flagSet({
    licence: {
      status: 'terminated',
      degradeTier: 4,
      expiresAt: '2020-01-01T00:00:00.000Z',
      fromCache: true,
      cacheAgeSeconds: ENTITLEMENT_CACHE_MAX_AGE_SECONDS * 100,
    },
    entitlements: [],
    overrides: {
      'module.audit.enabled': false,
      'feature.data_export.enabled': false,
      'module.print.enabled': false,
    },
    branchOverrides: { 'module.audit.enabled': false },
  });

  it('stays on with an expired, terminated, uncached licence and every switch off', () => {
    const evaluator = createFlagEvaluator(expiredEverything);
    for (const key of ['module.audit.enabled', 'module.print.enabled', 'module.barcode.enabled']) {
      const decision = evaluator.evaluate(key);
      expect(decision.enabled, key).toBe(true);
      expect(decision.reason, key).toBe('clinical_safety_exempt');
      expect(decision.clinicalSafetyExempt, key).toBe(true);
    }
  });

  it('keeps the hospital able to export its own data at every tier (EN-040 §14 AC-6)', () => {
    const evaluator = createFlagEvaluator(expiredEverything);
    expect(evaluator.isEnabled('feature.data_export.enabled')).toBe(true);
    expect(evaluator.evaluate('feature.data_export.enabled').message).toBe(
      'You can always export your own data.',
    );
  });

  it('appears in enabledKeys even though the plan grants nothing', () => {
    const enabled = createFlagEvaluator(expiredEverything).enabledKeys();
    expect(enabled).toContain('module.audit.enabled');
    expect(enabled).toContain('feature.data_export.enabled');
    expect(enabled).not.toContain('module.sso.enabled');
    expect([...enabled]).toEqual([...enabled].sort());
  });
});

describe('administrator switches', () => {
  it('can turn a licensed module off — that is configuration, not commerce', () => {
    const decision = createFlagEvaluator(flagSet({ overrides: { 'module.sso.enabled': false } })).evaluate(
      'module.sso.enabled',
    );
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe('override_off');
    expect(decision.message).toBe('This has been switched off for your hospital.');
  });

  it('cannot turn an unlicensed module on', () => {
    const decision = createFlagEvaluator(
      flagSet({ entitlements: [], overrides: { 'module.sso.enabled': true } }),
    ).evaluate('module.sso.enabled');
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe('not_licensed');
  });

  it('lets a branch switch win over the hospital one (EN-041)', () => {
    const evaluator = createFlagEvaluator(
      flagSet({
        overrides: { 'module.sso.enabled': false },
        branchOverrides: { 'module.sso.enabled': true },
      }),
    );
    expect(evaluator.isEnabled('module.sso.enabled')).toBe(true);
  });
});

describe('sub-flags (switches inside an already-licensed module)', () => {
  it('are off until somebody configures them', () => {
    const decision = createFlagEvaluator(flagSet()).evaluate('print.agent');
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe('not_configured');
    expect(decision.clinicalSafetyExempt).toBe(false);
    expect(decision.upgradeCta).toBeNull();
    expect(decision.message).toContain('Contact your administrator');
  });

  it('follow the administrator switch, hospital or branch', () => {
    expect(
      createFlagEvaluator(flagSet({ overrides: { 'print.agent': true } })).evaluate('print.agent'),
    ).toMatchObject({ enabled: true, reason: 'override_on' });
    expect(
      createFlagEvaluator(flagSet({ branchOverrides: { 'print.autoprint': false } })).evaluate(
        'print.autoprint',
      ),
    ).toMatchObject({ enabled: false, reason: 'override_off' });
  });
});

describe('fail-open for clinical, fail-closed for commercial (EN-040 §3.2)', () => {
  /**
   * No enforcement point in the Phase-0 registry is `failOpen` without also
   * being `clinicalSafetyExempt`, so this rule is exercised through the
   * `resolvePoint` seam with the shape a clinical module will have from Phase 4
   * (`module.pharmacy.enabled`: fails open, but is still licensable).
   */
  const pharmacy: EnforcementPoint = {
    key: 'module.pharmacy.enabled',
    family: 'feature',
    guard: 'route',
    description: 'Phase 4 pharmacy — clinical, therefore fails open.',
    failOpen: true,
    clinicalSafetyExempt: false,
    message: 'Pharmacy is temporarily unavailable.',
  };
  const resolvePoint = (key: string): EnforcementPoint | undefined =>
    key === pharmacy.key ? pharmacy : undefined;

  it('lets a clinical module through when the entitlement cache has expired', () => {
    const decision = createFlagEvaluator(
      flagSet({
        entitlements: [],
        licence: { ...ACTIVE, fromCache: true, cacheAgeSeconds: ENTITLEMENT_CACHE_MAX_AGE_SECONDS + 1 },
      }),
      { resolvePoint },
    ).evaluate('module.pharmacy.enabled');
    expect(decision.enabled).toBe(true);
    expect(decision.reason).toBe('cache_expired_fail_open');
  });

  it('still applies the plan when the cache is fresh — fail-open is not a free licence', () => {
    const decision = createFlagEvaluator(flagSet({ entitlements: [] }), { resolvePoint }).evaluate(
      'module.pharmacy.enabled',
    );
    expect(decision.enabled).toBe(false);
    expect(decision.reason).toBe('not_licensed');
  });
});

describe('determinism', () => {
  it('returns identical decisions for identical input, with no clock or randomness', () => {
    const set = flagSet({ licence: { ...ACTIVE, status: 'grace', degradeTier: 1 } });
    const first = createFlagEvaluator(set);
    const second = createFlagEvaluator(set);
    for (const key of ['module.sso.enabled', 'capacity.branches', 'module.audit.enabled', 'print.agent']) {
      expect(first.evaluate(key)).toEqual(second.evaluate(key));
      expect(first.evaluate(key)).toEqual(first.evaluate(key));
    }
    expect(first.hospitalId).toBe('h-1');
    expect(first.branchId).toBe('b-1');
  });
});
