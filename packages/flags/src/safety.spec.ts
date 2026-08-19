import { CLINICAL_SAFETY_EXEMPT_KEYS, getEnforcementPoint, type EnforcementPoint } from '@vims/contracts';
import { describe, expect, it } from 'vitest';

import { createFlagEvaluator } from './evaluator.js';
import {
  ALL_DEGRADATION_TIERS,
  ALL_SUBSCRIPTION_STATUSES,
  ClinicalSafetyRegressionError,
  assertClinicalSafetyInvariant,
  hostileFlagSet,
  verifyClinicalSafetyInvariant,
} from './safety.js';

describe('the clinical-safety invariant (EN-040 §13, AC-6)', () => {
  it('holds for every exempt key at every status × tier under the most hostile flag set', () => {
    const result = verifyClinicalSafetyInvariant();
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(
      ALL_SUBSCRIPTION_STATUSES.length * ALL_DEGRADATION_TIERS.length * CLINICAL_SAFETY_EXEMPT_KEYS.length,
    );
    expect(CLINICAL_SAFETY_EXEMPT_KEYS.length).toBeGreaterThan(5);
  });

  it('does not throw at boot', () => {
    expect(() => assertClinicalSafetyInvariant()).not.toThrow();
  });

  it('covers the capabilities EN-040 §3.5 names as never degraded', () => {
    for (const key of [
      'module.audit.enabled',
      'module.backup_dr.enabled',
      'module.barcode.enabled',
      'module.print.enabled',
      'feature.data_export.enabled',
    ]) {
      expect(CLINICAL_SAFETY_EXEMPT_KEYS, key).toContain(key);
    }
  });

  it('builds a genuinely hostile set — nothing entitled, everything switched off, cache long dead', () => {
    const set = hostileFlagSet('terminated', 4);
    expect(set.entitlements).toEqual([]);
    expect(set.licence.cacheAgeSeconds).toBeGreaterThan(72 * 60 * 60);
    for (const key of CLINICAL_SAFETY_EXEMPT_KEYS) {
      expect(set.overrides[key]).toBe(false);
      expect(set.branchOverrides[key]).toBe(false);
    }
  });
});

describe('the invariant check can actually fail (prove the guard works)', () => {
  /**
   * `docs/prompts/phase-00-foundation.md` exit gate 4: "deliberately breaking a
   * policy makes them fail (prove it)". Here the break is a registry that has
   * lost the `clinicalSafetyExempt` marking on the audit module — the exact
   * regression EN-040 §13 calls a patient-safety bug.
   */
  const brokenRegistry = (key: string): EnforcementPoint | undefined => {
    const point = getEnforcementPoint(key);
    if (point === undefined) return undefined;
    if (key === 'module.audit.enabled') {
      return { ...point, clinicalSafetyExempt: false, failOpen: false };
    }
    return point;
  };

  it('reports the regression instead of passing quietly', () => {
    const result = verifyClinicalSafetyInvariant({ resolvePoint: brokenRegistry });
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations.every((v) => v.key === 'module.audit.enabled')).toBe(true);
    expect(result.violations.map((v) => v.reason)).toContain('cache_expired_fail_closed');
  });

  it('throws at boot with every offending combination listed', () => {
    expect(() => assertClinicalSafetyInvariant({ resolvePoint: brokenRegistry })).toThrow(
      ClinicalSafetyRegressionError,
    );
    expect(() => assertClinicalSafetyInvariant({ resolvePoint: brokenRegistry })).toThrow(/EN-040 §3.5/);
    expect(() => assertClinicalSafetyInvariant({ resolvePoint: brokenRegistry })).toThrow(
      /module\.audit\.enabled blocked at status=/,
    );
  });

  it('confirms the same key passes with the real registry', () => {
    const evaluator = createFlagEvaluator(hostileFlagSet('terminated', 4));
    expect(evaluator.isEnabled('module.audit.enabled')).toBe(true);
  });
});
