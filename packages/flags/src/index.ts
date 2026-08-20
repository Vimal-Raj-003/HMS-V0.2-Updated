/**
 * `@vims/flags` — `module.<key>.enabled` per hospital, evaluated deterministically.
 *
 * `CLAUDE.md §4` requires a feature flag for every module and licence gating per
 * hospital. `EN-040` requires that the gate can never close on clinical safety.
 * Both live here, and the second one is enforced by
 * `assertClinicalSafetyInvariant()` rather than by convention.
 */

export {
  MODULE_FLAG_KEYS,
  REGISTERED_FLAG_KEYS,
  UnknownFlagKeyError,
  assertRegisteredFlagKey,
  isModuleFlagKey,
  isRegisteredFlagKey,
  moduleFlagKey,
  moduleKeyFromFlag,
  type FeatureFlagKey,
  type FlagKey,
  type ModuleFlagKey,
} from './keys.js';

export {
  FlagDisabledError,
  type DegradationTier,
  type FlagDecision,
  type FlagReason,
  type LicenceSnapshot,
  type ResolvedFlagSet,
  type SubscriptionStatus,
} from './types.js';

export {
  SUSPENDED_TIER,
  effectiveTier,
  isRestrictedAtTier,
  isSuspended,
  restrictedCapabilities,
} from './degradation.js';

export { createFlagEvaluator, type FlagEvaluator, type FlagEvaluatorOptions } from './evaluator.js';

export {
  ALL_DEGRADATION_TIERS,
  ALL_SUBSCRIPTION_STATUSES,
  ClinicalSafetyRegressionError,
  assertClinicalSafetyInvariant,
  hostileFlagSet,
  verifyClinicalSafetyInvariant,
  type SafetyVerification,
  type SafetyViolation,
} from './safety.js';

export { CLINICAL_SAFETY_EXEMPT_KEYS, getEnforcementPoint, type EnforcementPoint } from '@vims/contracts';
