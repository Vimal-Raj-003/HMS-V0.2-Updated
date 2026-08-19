import { ENFORCEMENT_POINTS } from '@vims/contracts';
import { describe, expect, it } from 'vitest';

import {
  MODULE_FLAG_KEYS,
  REGISTERED_FLAG_KEYS,
  UnknownFlagKeyError,
  assertRegisteredFlagKey,
  isModuleFlagKey,
  isRegisteredFlagKey,
  moduleFlagKey,
  moduleKeyFromFlag,
} from './keys.js';

describe('module flag keys (CLAUDE.md §4)', () => {
  it('builds the `module.<key>.enabled` shape', () => {
    expect(moduleFlagKey('pharmacy')).toBe('module.pharmacy.enabled');
    expect(moduleKeyFromFlag(moduleFlagKey('multi_branch'))).toBe('multi_branch');
  });

  it('recognises the shape and rejects near-misses', () => {
    expect(isModuleFlagKey('module.audit.enabled')).toBe(true);
    expect(isModuleFlagKey('module.audit')).toBe(false);
    expect(isModuleFlagKey('feature.data_export.enabled')).toBe(false);
    expect(isModuleFlagKey('print.agent')).toBe(false);
  });

  it('derives the module list from the contracts registry, not a second copy', () => {
    const fromContracts = ENFORCEMENT_POINTS.filter((point) => isModuleFlagKey(point.key)).map((p) => p.key);
    expect([...MODULE_FLAG_KEYS]).toEqual(fromContracts);
    expect(MODULE_FLAG_KEYS).toContain('module.audit.enabled');
    expect(MODULE_FLAG_KEYS.length).toBeGreaterThan(10);
  });

  it('exposes every registered entitlement key', () => {
    expect(REGISTERED_FLAG_KEYS).toContain('feature.data_export.enabled');
    expect(REGISTERED_FLAG_KEYS).toContain('quota.sms.monthly');
  });
});

describe('registry guard', () => {
  it('accepts a registered key and returns its enforcement point', () => {
    expect(isRegisteredFlagKey('module.sso.enabled')).toBe(true);
    expect(assertRegisteredFlagKey('module.sso.enabled').guard).toBe('route');
  });

  it('rejects an unregistered key, telling the developer where to declare it', () => {
    expect(isRegisteredFlagKey('module.invented.enabled')).toBe(false);
    expect(() => assertRegisteredFlagKey('module.invented.enabled')).toThrow(UnknownFlagKeyError);
    expect(() => assertRegisteredFlagKey('module.invented.enabled')).toThrow(/ENFORCEMENT_POINTS/);
  });
});
