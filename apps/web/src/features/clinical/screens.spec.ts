import { CLINICAL_SAFETY_EXEMPT_PERMISSIONS, PERMISSION_CATALOGUE } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import { CLINICAL_ROUTES, CLINICAL_SCREENS, clinicalScreen } from './screens';

/**
 * The screen catalogue, which the navigation and the ⌘K palette read.
 *
 * The failure it exists to prevent is a permission key that does not exist:
 * that hides the screen from *everyone*, and the symptom — "the nurse cannot
 * see the vitals room" — looks exactly like a permissions problem rather than a
 * typo, so it survives a long time.
 */
const KNOWN_KEYS = new Set(PERMISSION_CATALOGUE.map((permission) => permission.key));

describe('the clinical screen catalogue', () => {
  it('gates every screen on a permission key that actually exists', () => {
    for (const screen of CLINICAL_SCREENS) {
      expect(KNOWN_KEYS.has(screen.permission), `${screen.key} → ${screen.permission}`).toBe(true);
    }
  });

  it('explains every denial in plain words', () => {
    for (const screen of CLINICAL_SCREENS) {
      expect(screen.summary.length).toBeGreaterThan(20);
      expect(screen.deniedExplanation.length).toBeGreaterThan(20);
      expect(screen.keywords.length).toBeGreaterThan(0);
    }
  });

  it('uses a distinct key and route per screen', () => {
    expect(new Set(CLINICAL_SCREENS.map((s) => s.key)).size).toBe(CLINICAL_SCREENS.length);
    expect(new Set(CLINICAL_SCREENS.map((s) => s.href)).size).toBe(CLINICAL_SCREENS.length);
  });

  /**
   * EN-040 §5 / D-9: a hard stop a lapsed subscription could switch off is not a
   * hard stop. The prescribing screen's safety surface is built entirely from
   * `clinicalSafetyExempt` keys, so it carries no licence gate — and this
   * asserts the UI does not reintroduce a gate the permission layer
   * deliberately removed.
   */
  it('never licence-gates the prescribing safety surface', () => {
    expect(clinicalScreen('prescribe').entitlement).toBeNull();
    for (const key of ['cdss.evaluate', 'cdss.alert.read', 'cdss.alert.respond']) {
      expect(CLINICAL_SAFETY_EXEMPT_PERMISSIONS).toContain(key);
    }
  });

  it('exports the route list for whoever wires navigation', () => {
    expect(CLINICAL_ROUTES).toContain('/clinical');
    expect(CLINICAL_ROUTES).toContain('/clinical/vitals');
    expect(CLINICAL_ROUTES).toContain('/clinical/console');
    expect(CLINICAL_ROUTES).toContain('/clinical/prescribe');
    expect(CLINICAL_ROUTES).toContain('/clinical/alerts');
  });

  it('throws on an unknown screen key rather than rendering an ungated page', () => {
    expect(() => clinicalScreen('nope')).toThrow(/Unknown clinical screen/u);
  });
});
