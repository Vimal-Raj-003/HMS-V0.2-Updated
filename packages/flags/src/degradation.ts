/**
 * The degradation ladder, indexed for O(1) lookup.
 *
 * `EN-040 §3.5` is the contract: degradation is a *declared* ladder, and
 * "clinical safety and patient care functions never degrade". This module only
 * answers "is this capability restricted at tier N?" — the exemption rule lives
 * one level up in the evaluator, where it is applied *before* anything here is
 * consulted.
 */

import { DEGRADATION_LADDER, type DegradationTier, type SubscriptionStatus } from '@vims/contracts';

const RESTRICTED_BY_TIER: ReadonlyMap<DegradationTier, ReadonlySet<string>> = new Map(
  DEGRADATION_LADDER.map((spec) => [spec.tier, new Set(spec.restrictedCapabilities)] as const),
);

/** Tier 4 (suspended) stops interactive non-clinical use wholesale, not key by key. */
export const SUSPENDED_TIER: DegradationTier = 4;

/** Statuses at which only clinical-safety-exempt capabilities remain (EN-040 §3.5). */
const SUSPENDING_STATUSES: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>([
  'suspended',
  'terminated',
]);

export function restrictedCapabilities(tier: DegradationTier): ReadonlySet<string> {
  return RESTRICTED_BY_TIER.get(tier) ?? new Set<string>();
}

export function isRestrictedAtTier(key: string, tier: DegradationTier): boolean {
  return restrictedCapabilities(tier).has(key);
}

/**
 * `EN-040 §3.9`: "**Disputed invoice** → the account can be placed on
 * `billing_hold` by the operator: dunning pauses, **entitlement stays active**."
 * A commercial dispute must never reach the wards, so the hold flattens the tier
 * regardless of what the subscription row happens to carry.
 */
export function effectiveTier(status: SubscriptionStatus, tier: DegradationTier): DegradationTier {
  if (status === 'billing_hold') return 0;
  if (SUSPENDING_STATUSES.has(status)) return SUSPENDED_TIER;
  return tier;
}

export function isSuspended(status: SubscriptionStatus, tier: DegradationTier): boolean {
  return effectiveTier(status, tier) === SUSPENDED_TIER;
}
