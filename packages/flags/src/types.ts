/**
 * The inputs and outputs of a feature-flag decision.
 *
 * Everything here is a plain value. The evaluator is a pure function of a
 * *resolved* flag set: no Redis, no HTTP, no `Date.now()`. The resolution (plan
 * ⊕ add-ons ⊕ overrides ⊖ suspensions, signed, cached, refreshed within 30 s —
 * EN-040 §3.1) happens in `services/api`; this package only decides.
 *
 * That split is what makes the clinical-safety invariant testable: given any
 * hostile flag set, the answer for a clinical-safety key is still "allowed", and
 * a unit test can prove it without a database.
 */

import type { DegradationTier, SubscriptionStatus } from '@vims/contracts';

export type { DegradationTier, SubscriptionStatus };

/**
 * Why the evaluator answered the way it did. Surfaced in problem+json and in
 * the admin console, never as a raw string to a clinician mid-procedure
 * (EN-040 §3.5).
 */
export type FlagReason =
  /** Enabled because it is a clinical-safety capability. Licence state is irrelevant. */
  | 'clinical_safety_exempt'
  /** Enabled by the entitlement document. */
  | 'entitled'
  /** Enabled by an explicit per-hospital or per-branch flag override. */
  | 'override_on'
  /** Turned off by the hospital administrator, not by commerce. */
  | 'override_off'
  /** Not in the tenant's plan bundle. */
  | 'not_licensed'
  /** In the bundle, but restricted at the current degradation tier. */
  | 'licence_degraded'
  /** Subscription suspended or terminated: interactive non-clinical use stops. */
  | 'licence_suspended'
  /** Cached entitlement older than 72 h, and this capability fails open (clinical). */
  | 'cache_expired_fail_open'
  /** Cached entitlement older than 72 h, and this capability fails closed (commercial). */
  | 'cache_expired_fail_closed'
  /** A sub-flag nobody has configured. Off, because nothing clinical is off by default. */
  | 'not_configured';

export interface FlagDecision {
  readonly key: string;
  readonly enabled: boolean;
  readonly reason: FlagReason;
  /**
   * Plain-language explanation from the enforcement-point registry —
   * "a nurse should understand a banner without knowing what a SKU is"
   * (EN-040 §13).
   */
  readonly message: string;
  readonly upgradeCta: string | null;
  readonly clinicalSafetyExempt: boolean;
  readonly degradeTier: DegradationTier;
}

/**
 * The commercial state of the tenant at the moment of evaluation. On-prem this
 * comes from the signed licence key's dates; in SaaS from the entitlement
 * document (EN-040 §3.8, §3.2).
 */
export interface LicenceSnapshot {
  readonly status: SubscriptionStatus;
  readonly degradeTier: DegradationTier;
  /** ISO-8601. Informational — expiry is expressed through `status`/`degradeTier`. */
  readonly expiresAt: string | null;
  /** True when the answer came from a cached, signed document rather than live. */
  readonly fromCache: boolean;
  /** Age of that cache. Compared against `ENTITLEMENT_CACHE_MAX_AGE_SECONDS`. */
  readonly cacheAgeSeconds: number;
}

/**
 * A fully resolved flag set for one hospital (and optionally one branch).
 * Deliberately serialisable: this is exactly what the API caches in Redis and
 * ships to the browser so the nav can hide unlicensed items without a round trip.
 */
export interface ResolvedFlagSet {
  readonly hospitalId: string;
  readonly branchId: string | null;
  readonly licence: LicenceSnapshot;
  /** Entitlement keys the plan (plus add-ons and overrides) grants. */
  readonly entitlements: readonly string[];
  /** Hospital-scoped administrator switches: `key` → on/off. */
  readonly overrides: Readonly<Record<string, boolean>>;
  /** Branch-scoped switches (EN-041). Take precedence over the hospital ones. */
  readonly branchOverrides: Readonly<Record<string, boolean>>;
}

export class FlagDisabledError extends Error {
  override readonly name = 'FlagDisabledError';
  readonly decision: FlagDecision;

  constructor(decision: FlagDecision) {
    super(`Feature "${decision.key}" is not available: ${decision.reason}`);
    this.decision = decision;
  }
}
