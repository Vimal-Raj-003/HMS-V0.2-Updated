/**
 * Flag keys.
 *
 * `CLAUDE.md §4`: "Feature flags (`packages/flags`) for every new module:
 * `module.<key>.enabled` per hospital (licence gating)."
 *
 * The authoritative catalogue is `ENFORCEMENT_POINTS` in `@vims/contracts`
 * (EN-040 §3.2) — one registry so that behaviour, message and fail-direction are
 * declared once. This module derives the typed key helpers from it rather than
 * keeping a second list that could drift.
 */

import {
  ENFORCEMENT_POINTS,
  ENTITLEMENT_KEYS,
  getEnforcementPoint,
  type EnforcementPoint,
} from '@vims/contracts';

/** The shape every module-level licence gate takes. */
export type ModuleFlagKey = `module.${string}.enabled`;

/** Non-module capability keys: `feature.data_export.enabled`, `feature.abdm.m2`… */
export type FeatureFlagKey = `feature.${string}`;

/**
 * Any key the evaluator accepts. Sub-flags (`print.agent`, `lic.metering`) are
 * plain strings: they are switches *inside* an already-licensed module, so they
 * are not part of the entitlement registry.
 */
export type FlagKey = ModuleFlagKey | FeatureFlagKey | (string & Record<never, never>);

export function moduleFlagKey(moduleKey: string): ModuleFlagKey {
  return `module.${moduleKey}.enabled`;
}

export function isModuleFlagKey(key: string): key is ModuleFlagKey {
  return key.startsWith('module.') && key.endsWith('.enabled');
}

/** `module.pharmacy.enabled` → `pharmacy`. */
export function moduleKeyFromFlag(key: ModuleFlagKey): string {
  return key.slice('module.'.length, -'.enabled'.length);
}

/** Every module gate currently registered in `@vims/contracts`. */
export const MODULE_FLAG_KEYS: readonly ModuleFlagKey[] = Object.freeze(
  ENFORCEMENT_POINTS.filter((point): point is EnforcementPoint & { key: ModuleFlagKey } =>
    isModuleFlagKey(point.key),
  ).map((point) => point.key),
);

/** Every registered entitlement key, module gates included. */
export const REGISTERED_FLAG_KEYS: readonly string[] = ENTITLEMENT_KEYS;

export function isRegisteredFlagKey(key: string): boolean {
  return getEnforcementPoint(key) !== undefined;
}

export class UnknownFlagKeyError extends Error {
  override readonly name = 'UnknownFlagKeyError';
}

/**
 * Guard for anything that *must* go through the entitlement registry — a route
 * guard, a nav entry, a licence gate. Sub-flags do not use it.
 */
export function assertRegisteredFlagKey(key: string): EnforcementPoint {
  const point = getEnforcementPoint(key);
  if (point === undefined) {
    throw new UnknownFlagKeyError(
      `"${key}" is not a registered enforcement point. Add it to ENFORCEMENT_POINTS in @vims/contracts (EN-040 §3.2) so its message, guard and fail-direction are declared once.`,
    );
  }
  return point;
}
