/**
 * The clinical-safety invariant, expressed as executable code.
 *
 * `EN-040 §13`: "an automated test asserts that every `clinical_safety_exempt`
 * enforcement point remains exempt (a regression here is a patient-safety bug)".
 * `EN-040 §14 AC-6`: "**Given** any degradation tier including suspension,
 * **when** an administrator requests a data export, **then** the export is
 * permitted — data access is never gated by payment."
 *
 * `verifyClinicalSafetyInvariant()` proves it exhaustively rather than by
 * example: it builds the most hostile flag set that can exist — no entitlements
 * at all, every administrator switch off, an entitlement cache a decade stale —
 * and evaluates every exempt key at every status × tier combination. Anything
 * that comes back disabled is reported.
 *
 * It is exported (not merely tested) so that `services/api` can run it at boot
 * and refuse to start on a regression, which is cheaper than discovering it in a
 * ward.
 */

import { CLINICAL_SAFETY_EXEMPT_KEYS, type DegradationTier, type SubscriptionStatus } from '@vims/contracts';

import { createFlagEvaluator, type FlagEvaluatorOptions } from './evaluator.js';
import type { ResolvedFlagSet } from './types.js';

export const ALL_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = Object.freeze([
  'trial',
  'active',
  'grace',
  'soft_degraded',
  'hard_degraded',
  'suspended',
  'terminated',
  'billing_hold',
]);

export const ALL_DEGRADATION_TIERS: readonly DegradationTier[] = Object.freeze([0, 1, 2, 3, 4]);

/**
 * The worst commercial state a tenant can be in, with every administrator switch
 * turned off as well. Nothing clinical may depend on any of it.
 */
export function hostileFlagSet(status: SubscriptionStatus, tier: DegradationTier): ResolvedFlagSet {
  const allOff: Record<string, boolean> = {};
  for (const key of CLINICAL_SAFETY_EXEMPT_KEYS) {
    allOff[key] = false;
  }
  return {
    hospitalId: 'hospital-under-test',
    branchId: 'branch-under-test',
    licence: {
      status,
      degradeTier: tier,
      expiresAt: '2020-01-01T00:00:00.000Z',
      fromCache: true,
      // Ten years past the 72 h cache window.
      cacheAgeSeconds: 10 * 365 * 24 * 60 * 60,
    },
    entitlements: [],
    overrides: allOff,
    branchOverrides: allOff,
  };
}

export interface SafetyViolation {
  readonly key: string;
  readonly status: SubscriptionStatus;
  readonly tier: DegradationTier;
  readonly reason: string;
}

export interface SafetyVerification {
  readonly ok: boolean;
  readonly checked: number;
  readonly violations: readonly SafetyViolation[];
}

export function verifyClinicalSafetyInvariant(options?: FlagEvaluatorOptions): SafetyVerification {
  const violations: SafetyViolation[] = [];
  let checked = 0;

  for (const status of ALL_SUBSCRIPTION_STATUSES) {
    for (const tier of ALL_DEGRADATION_TIERS) {
      const evaluator = createFlagEvaluator(hostileFlagSet(status, tier), options);
      for (const key of CLINICAL_SAFETY_EXEMPT_KEYS) {
        checked += 1;
        const decision = evaluator.evaluate(key);
        if (!decision.enabled) {
          violations.push({ key, status, tier, reason: decision.reason });
        }
      }
    }
  }

  return { ok: violations.length === 0, checked, violations };
}

export class ClinicalSafetyRegressionError extends Error {
  override readonly name = 'ClinicalSafetyRegressionError';
}

/** Boot-time guard. Throws with the full list rather than the first failure. */
export function assertClinicalSafetyInvariant(options?: FlagEvaluatorOptions): void {
  const result = verifyClinicalSafetyInvariant(options);
  if (!result.ok) {
    const detail = result.violations
      .map((v) => `  · ${v.key} blocked at status=${v.status} tier=${v.tier} (${v.reason})`)
      .join('\n');
    throw new ClinicalSafetyRegressionError(
      `${result.violations.length} clinical-safety enforcement point(s) can be disabled by licence state. EN-040 §3.5 forbids this.\n${detail}`,
    );
  }
}
