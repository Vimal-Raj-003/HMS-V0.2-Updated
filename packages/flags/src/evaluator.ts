/**
 * The flag evaluator.
 *
 * Deterministic and synchronous: given a `ResolvedFlagSet` it always returns the
 * same decision, with no clock, no network and no randomness. `EN-040 §13`
 * budgets p99 < 1 ms because this runs on every route render.
 *
 * ## Order of checks — the order *is* the safety property
 *
 *  1. **Clinical-safety exemption.** If the enforcement point is marked
 *     `clinicalSafetyExempt`, the answer is "enabled" and nothing below is even
 *     read. Not the licence, not the tier, not an administrator's switch.
 *     `EN-040 §1`: commercial state "must **never** block clinical care, patient
 *     safety functions, or a hospital's access to its own data."
 *  2. Unregistered sub-flags (`print.agent`) — pure administrator switches.
 *  3. Stale entitlement cache (> 72 h): fail open for clinical, closed for
 *     commercial (`EN-040 §3.2`).
 *  4. Suspension / termination.
 *  5. Degradation tier restrictions.
 *  6. Administrator override off.
 *  7. Entitlement membership.
 */

import {
  CLINICAL_SAFETY_EXEMPT_KEYS,
  ENTITLEMENT_CACHE_MAX_AGE_SECONDS,
  getEnforcementPoint,
  type EnforcementPoint,
} from '@vims/contracts';

import { effectiveTier, isRestrictedAtTier, isSuspended } from './degradation.js';
import type { FlagKey } from './keys.js';
import { FlagDisabledError, type FlagDecision, type FlagReason, type ResolvedFlagSet } from './types.js';

const GENERIC_UNAVAILABLE = 'This is not available right now. Contact your administrator.';

function decide(
  key: string,
  enabled: boolean,
  reason: FlagReason,
  point: EnforcementPoint | undefined,
  tier: FlagDecision['degradeTier'],
  messageOverride?: string,
): FlagDecision {
  return {
    key,
    enabled,
    reason,
    message: messageOverride ?? point?.message ?? GENERIC_UNAVAILABLE,
    upgradeCta: point?.upgradeCta ?? null,
    clinicalSafetyExempt: point?.clinicalSafetyExempt ?? false,
    degradeTier: tier,
  };
}

export interface FlagEvaluatorOptions {
  /**
   * Override the enforcement-point registry.
   *
   * Production always uses `@vims/contracts`. This seam exists so the safety
   * suite can construct enforcement points that the Phase-0 registry does not
   * contain yet — in particular a *clinical module that fails open but is not
   * exempt*, which is the exact case `EN-040 §3.2` was written for and which
   * arrives with the pharmacy and lab modules in later phases. Without the seam
   * that rule would ship untested.
   */
  readonly resolvePoint?: (key: string) => EnforcementPoint | undefined;
}

export interface FlagEvaluator {
  readonly hospitalId: string;
  readonly branchId: string | null;
  /** The full decision, with the message and CTA a screen should show. */
  evaluate(key: FlagKey): FlagDecision;
  /** The hot path: just the boolean. */
  isEnabled(key: FlagKey): boolean;
  /** Throws `FlagDisabledError` carrying the decision, for a guard or interceptor. */
  assertEnabled(key: FlagKey): void;
  /** Every registered key that is currently on — used to build the nav in one pass. */
  enabledKeys(): readonly string[];
}

/**
 * Build an evaluator over one resolved flag set. The set is captured by value;
 * an entitlement change produces a *new* evaluator (the API rebuilds it on
 * `licence.entitlement.changed`, within the 30 s SLA of `EN-040 §7`).
 */
export function createFlagEvaluator(set: ResolvedFlagSet, options?: FlagEvaluatorOptions): FlagEvaluator {
  const resolvePoint = options?.resolvePoint ?? getEnforcementPoint;
  const entitlements = new Set(set.entitlements);
  const tier = effectiveTier(set.licence.status, set.licence.degradeTier);
  const suspended = isSuspended(set.licence.status, set.licence.degradeTier);
  const cacheStale = set.licence.fromCache && set.licence.cacheAgeSeconds > ENTITLEMENT_CACHE_MAX_AGE_SECONDS;

  function overrideFor(key: string): boolean | undefined {
    const branch = set.branchOverrides[key];
    if (branch !== undefined) return branch;
    return set.overrides[key];
  }

  function evaluate(key: FlagKey): FlagDecision {
    const point = resolvePoint(key);

    // 1. Clinical safety. First, unconditional, and deliberately unreachable by
    //    anything a commercial or administrative actor can change.
    if (point?.clinicalSafetyExempt === true) {
      return decide(key, true, 'clinical_safety_exempt', point, tier);
    }

    // 2. Sub-flags inside an already-licensed module: administrator switches only.
    if (point === undefined) {
      const override = overrideFor(key);
      if (override === undefined) {
        return decide(key, false, 'not_configured', point, tier);
      }
      return decide(key, override, override ? 'override_on' : 'override_off', point, tier);
    }

    // 3. The cached entitlement document has aged out (EN-040 §3.2, §3.9).
    if (cacheStale) {
      return point.failOpen
        ? decide(key, true, 'cache_expired_fail_open', point, tier)
        : decide(
            key,
            false,
            'cache_expired_fail_closed',
            point,
            tier,
            'We could not confirm your plan. This will come back automatically once the connection is restored.',
          );
    }

    // 4. Suspended or terminated: interactive non-clinical use stops. Exempt
    //    capabilities never reach this line, so data export still works.
    if (suspended) {
      return decide(key, false, 'licence_suspended', point, tier);
    }

    // 5. Restricted at the current tier.
    if (isRestrictedAtTier(key, tier)) {
      return decide(key, false, 'licence_degraded', point, tier);
    }

    // 6. The hospital administrator turned it off. Not commerce — configuration.
    if (overrideFor(key) === false) {
      return decide(key, false, 'override_off', point, tier, 'This has been switched off for your hospital.');
    }

    // 7. Is it in the plan? An administrator switch can turn a licensed module
    //    off, but it can never turn an unlicensed one on.
    return entitlements.has(key)
      ? decide(key, true, 'entitled', point, tier)
      : decide(key, false, 'not_licensed', point, tier);
  }

  return {
    hospitalId: set.hospitalId,
    branchId: set.branchId,
    evaluate,
    isEnabled: (key) => evaluate(key).enabled,
    assertEnabled: (key) => {
      const decision = evaluate(key);
      if (!decision.enabled) throw new FlagDisabledError(decision);
    },
    enabledKeys: () =>
      Object.freeze(
        [
          ...new Set([
            // Exempt keys are on whether or not the plan mentions them, so they
            // must be candidates here too or the nav would hide audit and export.
            ...CLINICAL_SAFETY_EXEMPT_KEYS,
            ...entitlements,
            ...Object.keys(set.overrides),
            ...Object.keys(set.branchOverrides),
          ]),
        ]
          .filter((key) => evaluate(key).enabled)
          .sort(),
      ),
  };
}
