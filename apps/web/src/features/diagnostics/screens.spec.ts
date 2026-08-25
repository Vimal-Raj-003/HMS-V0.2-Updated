import { CLINICAL_SAFETY_EXEMPT_PERMISSIONS, PERMISSION_CATALOGUE } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import { DIAGNOSTICS_ROUTES, DIAGNOSTICS_SCREENS, diagnosticsScreen, screensInArea } from './screens';

/**
 * The screen catalogue, which the navigation and the ⌘K palette read.
 *
 * The failure it exists to prevent is a permission key that does not exist:
 * that hides the screen from *everyone*, and the symptom — "the phlebotomist
 * cannot see the collection screen" — looks exactly like a permissions problem
 * rather than a typo, so it survives a long time.
 */
const KNOWN_KEYS = new Set(PERMISSION_CATALOGUE.map((permission) => permission.key));

describe('the diagnostics screen catalogue', () => {
  it('gates every screen on a permission key that actually exists', () => {
    for (const screen of DIAGNOSTICS_SCREENS) {
      expect(KNOWN_KEYS.has(screen.permission), `${screen.key} → ${screen.permission}`).toBe(true);
    }
  });

  it('explains every denial in plain words', () => {
    for (const screen of DIAGNOSTICS_SCREENS) {
      expect(screen.summary.length).toBeGreaterThan(20);
      expect(screen.deniedExplanation.length).toBeGreaterThan(20);
      expect(screen.keywords.length).toBeGreaterThan(0);
    }
  });

  it('uses a distinct key and route per screen', () => {
    expect(new Set(DIAGNOSTICS_SCREENS.map((s) => s.key)).size).toBe(DIAGNOSTICS_SCREENS.length);
    expect(new Set(DIAGNOSTICS_SCREENS.map((s) => s.href)).size).toBe(DIAGNOSTICS_SCREENS.length);
  });

  /**
   * EN-040 §5 / D-9: a hard stop a lapsed subscription could switch off is not a
   * hard stop. The critical-value board and the reading console are built on
   * `clinicalSafetyExempt` keys, so neither carries a licence gate — and this
   * asserts the UI does not reintroduce a gate the permission layer deliberately
   * removed.
   */
  it('never licence-gates a critical-value surface', () => {
    expect(diagnosticsScreen('lab-critical').entitlement).toBeNull();
    expect(diagnosticsScreen('rad-reading').entitlement).toBeNull();
    for (const key of [
      'lab.critical.read',
      'lab.critical.notify',
      'rad.critical.read',
      'rad.critical.notify',
    ]) {
      expect(CLINICAL_SAFETY_EXEMPT_PERMISSIONS, key).toContain(key);
    }
  });

  /**
   * The QC console is gated with the rest of the laboratory rather than
   * separately. EN-031 §5's release gate lives in the database and bites whether
   * or not this screen can be opened, so a licence tier that hid the console
   * while the gate kept holding results would be a trap rather than a downgrade.
   */
  it('gates the QC console on the same key as the bench it holds results for', () => {
    expect(diagnosticsScreen('lab-qc').entitlement).toBe(diagnosticsScreen('lab-bench').entitlement);
  });

  it('groups the screens into the three consoles the nav renders', () => {
    expect(screensInArea('lab')).toHaveLength(4);
    expect(screensInArea('radiology')).toHaveLength(3);
    expect(screensInArea('investigations')).toHaveLength(1);
  });

  it('exports the route list for whoever wires navigation', () => {
    expect(DIAGNOSTICS_ROUTES).toContain('/diagnostics');
    expect(DIAGNOSTICS_ROUTES).toContain('/diagnostics/lab/collection');
    expect(DIAGNOSTICS_ROUTES).toContain('/diagnostics/lab/bench');
    expect(DIAGNOSTICS_ROUTES).toContain('/diagnostics/lab/critical');
    expect(DIAGNOSTICS_ROUTES).toContain('/diagnostics/lab/qc');
    expect(DIAGNOSTICS_ROUTES).toContain('/diagnostics/radiology/orders');
    expect(DIAGNOSTICS_ROUTES).toContain('/diagnostics/radiology/reading');
    expect(DIAGNOSTICS_ROUTES).toContain('/diagnostics/radiology/pacs');
    expect(DIAGNOSTICS_ROUTES).toContain('/diagnostics/investigations');
  });

  /**
   * `docs/06` §6.5 — no PHI in a URL. Every diagnostics route is static: there
   * is no `[id]` segment anywhere, so a patient identifier cannot reach the
   * address bar, the browser history, or a reverse-proxy access log.
   */
  it('declares no route with a dynamic segment', () => {
    for (const route of DIAGNOSTICS_ROUTES) {
      expect(route).not.toMatch(/[[\]]/u);
    }
  });

  it('throws on an unknown screen key rather than rendering an ungated page', () => {
    expect(() => diagnosticsScreen('nope')).toThrow(/Unknown diagnostics screen/u);
  });
});
