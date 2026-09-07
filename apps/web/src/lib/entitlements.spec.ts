import { ENFORCEMENT_POINTS, getEnforcementPoint } from '@vims/contracts';
import { filterByPermission } from '@vims/ui';
import { describe, expect, it } from 'vitest';
import { PHASE0_NAV } from './nav';
import { ALL_SCREENS, openableScreens } from './screen-index';

/**
 * The gate that stops a screen naming a licence key nobody defined.
 *
 * This defect has now happened twice. The comment in `entitlements.ts` records
 * fixing it for phases 1–4; by Phase 8 ten more keys had been invented by
 * screen catalogues and defined nowhere, so `seedLicences` wrote no row for
 * them, no hospital could enable those modules, and the `entitlement` field was
 * documentation rather than a gate.
 *
 * The reason it recurs is that nothing failed. A key that does not resolve
 * silently means "not licensed", which looks exactly like a hospital that has
 * not bought the module. This test is the thing that makes it loud.
 */
const KNOWN_ENTITLEMENTS = new Set(ENFORCEMENT_POINTS.map((point) => point.key));

describe('screen entitlements', () => {
  it('names only licence keys the catalogue defines', () => {
    const unknown = ALL_SCREENS.filter(
      (screen) => screen.entitlement !== null && !KNOWN_ENTITLEMENTS.has(screen.entitlement),
    ).map((screen) => `${screen.key} → ${screen.entitlement ?? ''}`);

    expect(
      unknown,
      'a key defined nowhere means no licence row, so the module can never be switched on',
    ).toEqual([]);
  });

  it('gives every gated module a message a person could act on', () => {
    for (const screen of ALL_SCREENS) {
      if (screen.entitlement === null) continue;
      const point = getEnforcementPoint(screen.entitlement);
      expect(point, screen.entitlement).toBeDefined();
      // EN-040 §3.2: plain language, never "SKU", never "entitlement".
      expect(point?.message.toLowerCase(), screen.entitlement).not.toContain('entitlement');
      expect(point?.message.length ?? 0, screen.entitlement).toBeGreaterThan(20);
    }
  });

  /**
   * Administration and patient identity are never gated.
   *
   * A hospital locked out of its own licence screen cannot fix its licence, and
   * one that cannot find a patient has nothing left to run. Both are ruled out
   * by construction rather than by remembering.
   */
  it('never gates administration or patient identity on a module', () => {
    const gated = ALL_SCREENS.filter(
      (screen) =>
        (screen.catalogue === 'admin' || screen.catalogue === 'patient') && screen.entitlement !== null,
    ).map((screen) => screen.key);
    expect(gated).toEqual([]);
  });
});

describe('what a session can reach', () => {
  const everyPermission = new Set(ALL_SCREENS.map((screen) => screen.permission));

  it('hides a screen whose module is off, however wide the permissions', () => {
    const withoutInpatient = new Set(
      [...KNOWN_ENTITLEMENTS].filter((key) => key !== 'module.inpatient.enabled'),
    );
    const reachable = openableScreens(everyPermission, withoutInpatient);

    expect(reachable.some((s) => s.entitlement === 'module.inpatient.enabled')).toBe(false);
    // And the rest of the product is untouched — gate 11's second half.
    expect(reachable.some((s) => s.catalogue === 'diagnostics')).toBe(true);
    expect(reachable.some((s) => s.catalogue === 'admin')).toBe(true);
  });

  it('shows it again the moment the module is switched back on', () => {
    const reachable = openableScreens(everyPermission, KNOWN_ENTITLEMENTS);
    expect(reachable.some((s) => s.entitlement === 'module.inpatient.enabled')).toBe(true);
  });

  it('drops the whole navigation group when its module is off', () => {
    const withoutOphthalmology = new Set(
      [...KNOWN_ENTITLEMENTS].filter((key) => key !== 'module.ophthalmology.enabled'),
    );
    const visible = filterByPermission(PHASE0_NAV, everyPermission, withoutOphthalmology);

    const specialty = visible.find((item) => item.key === 'specialty');
    // The framework's own registry screen has no entitlement, so the group
    // survives; the eye clinic inside it does not.
    expect(specialty?.children?.some((child) => child.key === 'eye-clinic')).toBe(false);

    const withEverything = filterByPermission(PHASE0_NAV, everyPermission, KNOWN_ENTITLEMENTS);
    expect(
      withEverything.find((item) => item.key === 'specialty')?.children?.some((c) => c.key === 'eye-clinic'),
    ).toBe(true);
  });

  it('leaves the navigation alone when no licence state is supplied at all', () => {
    // Omitting the set means "licensing is not modelled here" — a story, or a
    // test of the permission filter. It must not mean "nothing is licensed",
    // which would empty the menu.
    const visible = filterByPermission(PHASE0_NAV, everyPermission);
    expect(visible.length).toBeGreaterThan(5);
  });

  /**
   * The palette and the navigation read the same list.
   *
   * They did not, until Phase 8: the palette indexed `ADMIN_SCREENS` alone and
   * could not find anything built after Phase 0.
   */
  it('indexes every navigable screen, not only administration', () => {
    for (const catalogue of [
      'admin',
      'patient',
      'frontoffice',
      'clinical',
      'diagnostics',
      'pharmacy',
      'inventory',
      'rcm',
      'emergency',
      'ortho',
      'inpatient',
      'specialty',
    ]) {
      expect(
        ALL_SCREENS.some((screen) => screen.catalogue === catalogue),
        catalogue,
      ).toBe(true);
    }
  });
});
