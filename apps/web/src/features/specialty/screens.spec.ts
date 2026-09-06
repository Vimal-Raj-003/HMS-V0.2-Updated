import { CONSOLE_COMPONENT_CATALOGUE, PERMISSION_CATALOGUE } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import { SPECIALTY_ROUTES, SPECIALTY_SCREENS, specialtyScreen } from './screens';

const KNOWN_KEYS = new Set(PERMISSION_CATALOGUE.map((permission) => permission.key));

describe('the specialty screen catalogue', () => {
  it('gates every screen on a permission key that actually exists', () => {
    for (const screen of SPECIALTY_SCREENS) {
      expect(KNOWN_KEYS.has(screen.permission), `${screen.key} → ${screen.permission}`).toBe(true);
    }
  });

  /**
   * Reading the registry is wide; composing it is not.
   *
   * A clinician who cannot see which console their department opens has no way
   * to explain why their workspace looks the way it does, and will ask somebody
   * who also cannot see it. Changing the tabs, on the other hand, changes what
   * a whole department sees on its next patient — and the person who notices is
   * mid-consultation.
   */
  it('puts the read key on the screen and keeps the configure key off it', () => {
    const read = PERMISSION_CATALOGUE.find((p) => p.key === 'console.registry.read');
    expect(read?.risk).toBe('low');
    expect(SPECIALTY_SCREENS.some((s) => s.permission === 'console.registry.read')).toBe(true);
    expect(SPECIALTY_SCREENS.some((s) => s.permission === 'console.registry.configure')).toBe(false);
  });

  it('gives every screen a distinct key, route and plain-words denial', () => {
    expect(new Set(SPECIALTY_SCREENS.map((s) => s.key)).size).toBe(SPECIALTY_SCREENS.length);
    expect(new Set(SPECIALTY_SCREENS.map((s) => s.href)).size).toBe(SPECIALTY_SCREENS.length);
    for (const screen of SPECIALTY_SCREENS) {
      expect(screen.deniedExplanation.length, screen.key).toBeGreaterThan(40);
      expect(screen.keywords.length, screen.key).toBeGreaterThan(3);
    }
  });

  it('resolves a screen by key and refuses one that does not exist', () => {
    expect(specialtyScreen('console-registry').href).toBe('/specialty/consoles');
    expect(() => specialtyScreen('nope')).toThrow();
    expect(SPECIALTY_ROUTES).toContain('/specialty/consoles');
  });

  /**
   * The registry screen composes from the catalogue, so a component missing
   * from it is a tab an administrator cannot add however hard they try. The
   * generic tabs must be there: OP-025 §0.1 keeps history, prescription,
   * orders, timeline and notes reachable from every console, because a console
   * that hides the rest of the chart is how a specialist misses the allergy.
   */
  it('offers the generic tabs every console must keep reachable', () => {
    for (const key of [
      'generic.history',
      'generic.prescription',
      'generic.orders',
      'generic.timeline',
      'generic.notes',
    ]) {
      expect(
        CONSOLE_COMPONENT_CATALOGUE.some((c) => c.key === key && c.deprecated !== true),
        key,
      ).toBe(true);
    }
  });
});
