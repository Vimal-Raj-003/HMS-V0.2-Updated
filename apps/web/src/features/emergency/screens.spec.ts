import { PERMISSION_CATALOGUE } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import { ER_ROUTES, ER_SCREENS, erScreen } from './screens';

const KNOWN_KEYS = new Set(PERMISSION_CATALOGUE.map((permission) => permission.key));

describe('the emergency screen catalogue', () => {
  it('gates every screen on a permission key that actually exists', () => {
    for (const screen of ER_SCREENS) {
      expect(KNOWN_KEYS.has(screen.permission), `${screen.key} → ${screen.permission}`).toBe(true);
    }
  });

  /**
   * The board is gated on reading the board, not on registering an arrival.
   * Gating it on `er.quickreg` would hide the department's status display from
   * anybody who is not allowed to book patients in.
   */
  it('gates the board on the list it loads', () => {
    expect(erScreen('er-board').permission).toBe('er.board.read');
  });

  /**
   * `phase-06`'s central constraint: registration is never a precondition for
   * care. `er.quickreg` is therefore deliberately `low` risk — a permission
   * model that made it hard to reach would be one that killed somebody.
   */
  it('keeps quick registration a low-risk permission', () => {
    const quickReg = PERMISSION_CATALOGUE.find((permission) => permission.key === 'er.quickreg');
    expect(quickReg).toBeDefined();
    expect(quickReg?.risk).toBe('low');
  });

  /**
   * Reconciling a tag into a UHID moves a clinical record onto a real person.
   * It is the one identity operation in the module that carries a reason.
   */
  it('makes merging an identity a reasoned, high-risk act', () => {
    const merge = PERMISSION_CATALOGUE.find((permission) => permission.key === 'er.identity.merge');
    expect(merge?.risk).toBe('high');
    expect(merge?.requiresReason).toBe(true);
  });

  it('explains every denial in plain words', () => {
    for (const screen of ER_SCREENS) {
      expect(screen.summary.length).toBeGreaterThan(20);
      expect(screen.deniedExplanation.length).toBeGreaterThan(20);
      expect(screen.keywords.length).toBeGreaterThan(0);
    }
  });

  it('uses a distinct key and route per screen', () => {
    expect(new Set(ER_SCREENS.map((s) => s.key)).size).toBe(ER_SCREENS.length);
    expect(new Set(ER_SCREENS.map((s) => s.href)).size).toBe(ER_SCREENS.length);
  });

  it('declares no route with a dynamic segment', () => {
    for (const route of ER_ROUTES) {
      expect(route).not.toMatch(/[[\]]/u);
    }
  });

  it('throws on an unknown screen key rather than rendering an ungated page', () => {
    expect(() => erScreen('nope')).toThrow(/Unknown ER screen/u);
  });
});
