import { DEGRADATION_LADDER, type DegradationTier } from '@vims/contracts';
import { describe, expect, it } from 'vitest';

import {
  SUSPENDED_TIER,
  effectiveTier,
  isRestrictedAtTier,
  isSuspended,
  restrictedCapabilities,
} from './degradation.js';

describe('the declared ladder (EN-040 §3.5)', () => {
  it('restricts nothing at tier 0', () => {
    expect([...restrictedCapabilities(0)]).toEqual([]);
  });

  it('blocks new branches and seats in grace, and nothing else', () => {
    expect(isRestrictedAtTier('capacity.branches', 1)).toBe(true);
    expect(isRestrictedAtTier('capacity.seats.clinical', 1)).toBe(true);
    expect(isRestrictedAtTier('module.integration_hub.enabled', 1)).toBe(false);
  });

  it('restricts partner API, integrations and email at soft-degraded', () => {
    expect(isRestrictedAtTier('module.api_gateway.enabled', 2)).toBe(true);
    expect(isRestrictedAtTier('module.integration_hub.enabled', 2)).toBe(true);
    expect(isRestrictedAtTier('module.email.enabled', 2)).toBe(true);
  });

  it('adds SSO and multi-branch at hard-degraded', () => {
    expect(isRestrictedAtTier('module.sso.enabled', 2)).toBe(false);
    expect(isRestrictedAtTier('module.sso.enabled', 3)).toBe(true);
    expect(isRestrictedAtTier('module.multi_branch.enabled', 3)).toBe(true);
  });

  it('covers every tier the contracts ladder declares', () => {
    for (const spec of DEGRADATION_LADDER) {
      expect([...restrictedCapabilities(spec.tier)].sort()).toEqual([...spec.restrictedCapabilities].sort());
    }
  });

  it('returns an empty set for a tier that is not in the ladder', () => {
    // A tier value that arrived from a hand-edited database row must degrade to
    // "restrict nothing extra", not throw in a route guard.
    expect([...restrictedCapabilities(9 as DegradationTier)]).toEqual([]);
  });
});

describe('status overrides the stored tier where the spec says so', () => {
  it('flattens a billing hold to tier 0 (EN-040 §3.9 — a dispute never reaches the wards)', () => {
    expect(effectiveTier('billing_hold', 3)).toBe(0);
    expect(isSuspended('billing_hold', 4)).toBe(false);
  });

  it('treats suspended and terminated as the top of the ladder', () => {
    expect(effectiveTier('suspended', 0)).toBe(SUSPENDED_TIER);
    expect(effectiveTier('terminated', 0)).toBe(SUSPENDED_TIER);
    expect(isSuspended('terminated', 0)).toBe(true);
  });

  it('passes an ordinary status through untouched', () => {
    expect(effectiveTier('active', 0)).toBe(0);
    expect(effectiveTier('grace', 1)).toBe(1);
    expect(effectiveTier('soft_degraded', 2)).toBe(2);
    expect(isSuspended('active', 0)).toBe(false);
  });
});
