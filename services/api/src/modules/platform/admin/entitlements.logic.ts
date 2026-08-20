import {
  DEGRADATION_LADDER,
  ENFORCEMENT_POINTS,
  type DegradationTier,
  type DegradationTierSpec,
  type EnforcementPoint,
} from '@vims/contracts';

/**
 * Pure licence and feature-flag logic (EN-040).
 *
 * The rule everything here serves is `EN-040 §1`: "commercial state may restrict
 * *administrative and convenience* functions, but it must **never** block
 * clinical care, patient safety functions, or a hospital's access to its own
 * data." A defect in this file is not a billing bug — it is a hospital unable to
 * check an allergy because an invoice is late — which is why it is separated
 * from the database code and tested on its own.
 */

export interface EntitlementRow {
  readonly key: string;
  readonly allowed: boolean;
  readonly limit_value: string | null;
  readonly degrade_mode: number;
  readonly source: string;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
}

export interface ResolvedEntitlement {
  readonly key: string;
  readonly family: EnforcementPoint['family'];
  readonly guard: EnforcementPoint['guard'];
  readonly description: string;
  readonly allowed: boolean;
  readonly limitValue: string | null;
  readonly degradeMode: number;
  /** `plan` / `override` from the entitlement row, or `default` when none exists. */
  readonly source: string;
  readonly clinicalSafetyExempt: boolean;
  readonly failOpen: boolean;
  readonly message: string;
  readonly upgradeCta: string | null;
  readonly effectiveTo: string | null;
}

/**
 * Merges the declared enforcement points with whatever the tenant's entitlement
 * table actually says.
 *
 * A point with **no row** is the interesting case, and `EN-040 §3.2` decides it:
 * "the system **fails open for clinical modules and fails closed for
 * administrative/commercial features** — never the reverse." So the absence of a
 * row is resolved by the point's own `failOpen` flag rather than by a blanket
 * default in either direction.
 *
 * A `clinicalSafetyExempt` point is allowed regardless of what the row says. A
 * row that marks one disallowed is a data defect, and honouring it would be the
 * patient-safety failure `EN-040 §14 AC-20` exists to prevent.
 */
export function resolveEntitlements(
  rows: readonly EntitlementRow[],
  points: readonly EnforcementPoint[] = ENFORCEMENT_POINTS,
): readonly ResolvedEntitlement[] {
  const byKey = new Map(rows.map((row) => [row.key, row]));

  return points.map((point) => {
    const row = byKey.get(point.key);
    const allowed = point.clinicalSafetyExempt ? true : (row?.allowed ?? point.failOpen);

    return {
      key: point.key,
      family: point.family,
      guard: point.guard,
      description: point.description,
      allowed,
      limitValue: row?.limit_value ?? null,
      degradeMode: row?.degrade_mode ?? 0,
      source: row?.source ?? 'default',
      clinicalSafetyExempt: point.clinicalSafetyExempt,
      failOpen: point.failOpen,
      message: point.message,
      upgradeCta: point.upgradeCta ?? null,
      effectiveTo: row?.effective_to?.toISOString() ?? null,
    };
  });
}

/** The rung of the degradation ladder a tier number names. Unknown tiers read as Active. */
export function tierSpec(tier: number): DegradationTierSpec {
  const found = DEGRADATION_LADDER.find((spec) => spec.tier === (tier as DegradationTier));
  if (found !== undefined) return found;
  const active = DEGRADATION_LADDER.find((spec) => spec.tier === 0);
  if (active === undefined)
    throw new Error('DEGRADATION_LADDER has no active tier; the ladder is malformed.');
  return active;
}

export type FlagToggleCheck =
  { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly upgradeCta: string | null };

/**
 * `EN-007 §3.7` / `§5`: "Feature flags cannot enable modules outside licence;"
 * `§14 AC-14`: "when an admin toggles its flag, then the toggle is blocked with
 * an upgrade message and **no event is emitted**."
 *
 * Turning a flag **off** is never blocked. A licence check that prevented an
 * administrator from disabling something would be a licence check that could
 * strand a hospital with a module it wants gone.
 */
export function checkFlagToggle(
  key: string,
  enabled: boolean,
  entitlements: readonly ResolvedEntitlement[],
): FlagToggleCheck {
  if (!enabled) return { ok: true };

  const entitlement = entitlements.find((e) => e.key === key);
  // A flag key that is not an entitlement key is a fine-grained sub-flag
  // (`admin.impersonation`, `audit.hash_chain`) rather than a licensed module,
  // and the licence has nothing to say about it.
  if (entitlement === undefined) return { ok: true };
  if (entitlement.allowed) return { ok: true };

  return { ok: false, reason: entitlement.message, upgradeCta: entitlement.upgradeCta };
}

export interface FlagRow {
  readonly id: string;
  readonly key: string;
  readonly hospital_id: string | null;
  readonly branch_id: string | null;
  readonly role_key: string | null;
  readonly user_id: string | null;
  readonly enabled: boolean;
  readonly rollout_pct: number | null;
  readonly expires_at: Date | null;
  readonly note: string | null;
  readonly updated_at: Date | null;
}

export interface ResolvedFlag {
  readonly key: string;
  readonly description: string;
  /** What the hospital has actually configured, or the licence default. */
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly licensed: boolean;
  readonly clinicalSafetyExempt: boolean;
  readonly rolloutPct: number | null;
  readonly expiresAt: string | null;
  readonly note: string | null;
  readonly scope: 'hospital' | 'branch' | 'role' | 'user' | 'global';
  readonly upgradeCta: string | null;
  readonly message: string;
}

export function scopeOfFlag(row: FlagRow): ResolvedFlag['scope'] {
  if (row.user_id !== null) return 'user';
  if (row.role_key !== null) return 'role';
  if (row.branch_id !== null) return 'branch';
  if (row.hospital_id !== null) return 'hospital';
  return 'global';
}

/**
 * The module grid EN-007 §8 describes: "licensed / enabled / beta /
 * dependencies". A row that has expired is treated as absent — an expired
 * rollout that keeps a module switched on is how a time-boxed pilot becomes
 * permanent by accident.
 */
export function resolveFlags(
  rows: readonly FlagRow[],
  entitlements: readonly ResolvedEntitlement[],
  now: Date,
): readonly ResolvedFlag[] {
  const live = rows.filter((row) => row.expires_at === null || row.expires_at.getTime() > now.getTime());
  const byKey = new Map(live.map((row) => [row.key, row]));

  const featureEntitlements = entitlements.filter((e) => e.family === 'feature');
  const extraRows = live.filter((row) => !featureEntitlements.some((e) => e.key === row.key));

  const fromEntitlements = featureEntitlements.map<ResolvedFlag>((entitlement) => {
    const row = byKey.get(entitlement.key);
    return {
      key: entitlement.key,
      description: entitlement.description,
      enabled: row?.enabled ?? entitlement.allowed,
      configured: row !== undefined,
      licensed: entitlement.allowed,
      clinicalSafetyExempt: entitlement.clinicalSafetyExempt,
      rolloutPct: row?.rollout_pct ?? null,
      expiresAt: row?.expires_at?.toISOString() ?? null,
      note: row?.note ?? null,
      scope: row === undefined ? 'hospital' : scopeOfFlag(row),
      upgradeCta: entitlement.upgradeCta,
      message: entitlement.message,
    };
  });

  const fromRows = extraRows.map<ResolvedFlag>((row) => {
    return {
      key: row.key,
      description: 'Fine-grained flag; not a licensed module.',
      enabled: row.enabled,
      configured: true,
      licensed: true,
      clinicalSafetyExempt: false,
      rolloutPct: row.rollout_pct,
      expiresAt: row.expires_at?.toISOString() ?? null,
      note: row.note,
      scope: scopeOfFlag(row),
      upgradeCta: null,
      message: '',
    };
  });

  return [...fromEntitlements, ...fromRows].sort((a, b) => a.key.localeCompare(b.key));
}
