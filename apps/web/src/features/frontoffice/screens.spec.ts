import { CLINICAL_SAFETY_EXEMPT_PERMISSIONS, PERMISSION_CATALOGUE } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import { FRONT_OFFICE_ROUTES, FRONT_OFFICE_SCREENS, frontOfficeScreen } from './screens';

/**
 * The screen catalogue, which the navigation and the ⌘K palette read.
 *
 * The failure it exists to prevent is a permission key that does not exist:
 * that hides the screen from *everyone*, and the symptom — "reception cannot see
 * the appointment book" — looks exactly like a permissions problem rather than a
 * typo, so it survives a long time.
 */
const KNOWN_KEYS = new Set(PERMISSION_CATALOGUE.map((permission) => permission.key));

describe('the front-office screen catalogue', () => {
  it('gates every screen on a permission key that actually exists', () => {
    for (const screen of FRONT_OFFICE_SCREENS) {
      expect(KNOWN_KEYS.has(screen.permission), `${screen.key} → ${screen.permission}`).toBe(true);
    }
  });

  it('explains every denial in plain words', () => {
    for (const screen of FRONT_OFFICE_SCREENS) {
      expect(screen.summary.length).toBeGreaterThan(20);
      expect(screen.deniedExplanation.length).toBeGreaterThan(20);
      expect(screen.keywords.length).toBeGreaterThan(0);
    }
  });

  it('uses a distinct key and route per screen', () => {
    expect(new Set(FRONT_OFFICE_SCREENS.map((s) => s.key)).size).toBe(FRONT_OFFICE_SCREENS.length);
    expect(new Set(FRONT_OFFICE_SCREENS.map((s) => s.href)).size).toBe(FRONT_OFFICE_SCREENS.length);
  });

  /**
   * EN-006 §5: a hospital must be able to hand out a token, show a board and
   * call the next patient whatever its licence says. The catalogue marks two of
   * those keys `clinicalSafetyExempt`, and this asserts the UI does not
   * reintroduce a gate the permission layer deliberately removed.
   */
  it('never licence-gates the queue', () => {
    expect(frontOfficeScreen('queue').entitlement).toBeNull();
    for (const key of ['queue.token.issue', 'queue.board.read']) {
      expect(CLINICAL_SAFETY_EXEMPT_PERMISSIONS).toContain(key);
    }
  });

  it('exports the route list for whoever wires navigation', () => {
    expect(FRONT_OFFICE_ROUTES).toContain('/frontoffice');
    expect(FRONT_OFFICE_ROUTES).toContain('/frontoffice/appointments');
    expect(FRONT_OFFICE_ROUTES).toContain('/frontoffice/queue');
    expect(FRONT_OFFICE_ROUTES).toContain('/frontoffice/cash');
  });

  it('throws on an unknown screen key rather than rendering an ungated page', () => {
    expect(() => frontOfficeScreen('nope')).toThrow(/Unknown front-office screen/u);
  });
});
