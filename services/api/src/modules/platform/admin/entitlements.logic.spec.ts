import { CLINICAL_SAFETY_EXEMPT_KEYS, ENFORCEMENT_POINTS, type EnforcementPoint } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import {
  checkFlagToggle,
  resolveEntitlements,
  resolveFlags,
  scopeOfFlag,
  tierSpec,
  type EntitlementRow,
  type FlagRow,
} from './entitlements.logic.js';

const NOW = new Date('2026-08-20T12:00:00.000Z');

function entitlementRow(overrides: Partial<EntitlementRow> & { key: string }): EntitlementRow {
  return {
    allowed: true,
    limit_value: null,
    degrade_mode: 0,
    source: 'plan',
    effective_from: new Date('2026-01-01T00:00:00.000Z'),
    effective_to: null,
    ...overrides,
  };
}

function flagRow(overrides: Partial<FlagRow> & { key: string }): FlagRow {
  return {
    id: '018f4b5c-0000-7000-8000-0000000000f1',
    hospital_id: '018f4b5c-0000-7000-8000-00000000000a',
    branch_id: null,
    role_key: null,
    user_id: null,
    enabled: true,
    rollout_pct: null,
    expires_at: null,
    note: null,
    updated_at: NOW,
    ...overrides,
  };
}

describe('entitlement resolution', () => {
  it('covers every declared enforcement point, even with no rows at all', () => {
    expect(resolveEntitlements([])).toHaveLength(ENFORCEMENT_POINTS.length);
  });

  it('fails OPEN for a point marked fail-open when no row exists', () => {
    const resolved = resolveEntitlements([]);
    const audit = resolved.find((e) => e.key === 'module.audit.enabled');
    expect(audit?.allowed).toBe(true);
    expect(audit?.source).toBe('default');
  });

  it('fails CLOSED for a commercial point when no row exists', () => {
    // EN-040 §3.2: fail open for clinical, closed for administrative — never the
    // reverse. A missing row must not hand out partner API access for free.
    const gateway = resolveEntitlements([]).find((e) => e.key === 'module.api_gateway.enabled');
    expect(gateway?.allowed).toBe(false);
  });

  it('honours a row that grants a commercial module', () => {
    const resolved = resolveEntitlements([
      entitlementRow({ key: 'module.api_gateway.enabled', allowed: true }),
    ]);
    expect(resolved.find((e) => e.key === 'module.api_gateway.enabled')?.allowed).toBe(true);
  });

  it('honours a row that revokes a commercial module', () => {
    const resolved = resolveEntitlements([entitlementRow({ key: 'module.email.enabled', allowed: false })]);
    expect(resolved.find((e) => e.key === 'module.email.enabled')?.allowed).toBe(false);
  });

  /**
   * EN-040 §14 AC-20 asks for exactly this assertion: the exempt set stays
   * allowed at every tier and in every data state. A row saying otherwise is a
   * data defect, and obeying it would be a patient-safety failure.
   */
  it('never lets a row switch off a clinical-safety-exempt key', () => {
    const hostileRows = CLINICAL_SAFETY_EXEMPT_KEYS.map((key) => entitlementRow({ key, allowed: false }));
    const resolved = resolveEntitlements(hostileRows);
    for (const key of CLINICAL_SAFETY_EXEMPT_KEYS) {
      expect(resolved.find((e) => e.key === key)?.allowed).toBe(true);
    }
  });

  it('carries the plain-language message and upgrade path for a blocked module', () => {
    const gateway = resolveEntitlements([]).find((e) => e.key === 'module.api_gateway.enabled');
    expect(gateway?.message).toMatch(/not included in your plan/);
    expect(gateway?.upgradeCta).toEqual(expect.any(String));
  });
});

describe('degradation tier lookup', () => {
  it('names each rung of the ladder', () => {
    expect(tierSpec(0).status).toBe('active');
    expect(tierSpec(2).status).toBe('soft_degraded');
    expect(tierSpec(4).status).toBe('suspended');
  });

  it('reads an unknown tier as Active rather than as the harshest one', () => {
    // Guessing "suspended" from a corrupt tier number would take a hospital
    // offline over a data error.
    expect(tierSpec(99).status).toBe('active');
  });
});

describe('feature-flag toggles against the licence', () => {
  const entitlements = resolveEntitlements([]);

  it('blocks enabling a module outside the licence', () => {
    const result = checkFlagToggle('module.api_gateway.enabled', true, entitlements);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not included in your plan/);
  });

  it('always allows turning a flag OFF, licensed or not', () => {
    // A licence check that stops an administrator disabling something strands
    // the hospital with a module it wants gone.
    expect(checkFlagToggle('module.api_gateway.enabled', false, entitlements).ok).toBe(true);
  });

  it('allows enabling a licensed module', () => {
    const licensed = resolveEntitlements([entitlementRow({ key: 'module.email.enabled', allowed: true })]);
    expect(checkFlagToggle('module.email.enabled', true, licensed).ok).toBe(true);
  });

  it('has nothing to say about a fine-grained sub-flag', () => {
    expect(checkFlagToggle('admin.impersonation', true, entitlements).ok).toBe(true);
  });

  it('never blocks a clinical-safety-exempt module', () => {
    expect(checkFlagToggle('module.audit.enabled', true, entitlements).ok).toBe(true);
    expect(checkFlagToggle('module.barcode.enabled', true, entitlements).ok).toBe(true);
  });
});

describe('flag grid', () => {
  const entitlements = resolveEntitlements([]);

  it('lists every licensable module, configured or not', () => {
    const grid = resolveFlags([], entitlements, NOW);
    const featureCount = ENFORCEMENT_POINTS.filter((p: EnforcementPoint) => p.family === 'feature').length;
    expect(grid).toHaveLength(featureCount);
    expect(grid.every((f) => !f.configured)).toBe(true);
  });

  it('shows the configured value where the hospital set one', () => {
    const grid = resolveFlags([flagRow({ key: 'module.email.enabled', enabled: true })], entitlements, NOW);
    const email = grid.find((f) => f.key === 'module.email.enabled');
    expect(email).toMatchObject({ enabled: true, configured: true, licensed: false });
  });

  it('treats an expired flag as absent, so a pilot cannot become permanent by accident', () => {
    const expired = flagRow({
      key: 'module.email.enabled',
      enabled: true,
      expires_at: new Date('2026-08-19T00:00:00.000Z'),
    });
    const email = resolveFlags([expired], entitlements, NOW).find((f) => f.key === 'module.email.enabled');
    expect(email?.configured).toBe(false);
    expect(email?.enabled).toBe(false);
  });

  it('surfaces a fine-grained flag that is not a licensed module', () => {
    const grid = resolveFlags([flagRow({ key: 'admin.impersonation', enabled: true })], entitlements, NOW);
    expect(grid.find((f) => f.key === 'admin.impersonation')).toMatchObject({
      configured: true,
      licensed: true,
    });
  });

  it('reports the narrowest scope a flag row targets', () => {
    expect(scopeOfFlag(flagRow({ key: 'x' }))).toBe('hospital');
    expect(scopeOfFlag(flagRow({ key: 'x', branch_id: 'b' }))).toBe('branch');
    expect(scopeOfFlag(flagRow({ key: 'x', role_key: 'r' }))).toBe('role');
    expect(scopeOfFlag(flagRow({ key: 'x', user_id: 'u' }))).toBe('user');
    expect(scopeOfFlag(flagRow({ key: 'x', hospital_id: null }))).toBe('global');
  });

  it('returns a stable, sorted grid so the screen does not reshuffle between loads', () => {
    const grid = resolveFlags([], entitlements, NOW);
    expect([...grid].map((f) => f.key)).toEqual([...grid].map((f) => f.key).sort());
  });
});
