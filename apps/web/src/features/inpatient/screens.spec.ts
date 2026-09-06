import { PERMISSION_CATALOGUE } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import { IP_ROUTES, IP_SCREENS, ipScreen } from './screens';

const KNOWN_KEYS = new Set(PERMISSION_CATALOGUE.map((permission) => permission.key));

describe('the inpatient screen catalogue', () => {
  it('gates every screen on a permission key that actually exists', () => {
    for (const screen of IP_SCREENS) {
      expect(KNOWN_KEYS.has(screen.permission), `${screen.key} → ${screen.permission}`).toBe(true);
    }
  });

  /**
   * The bed board is the widest key in the phase. A board only the bed manager
   * can read is a board everybody phones the bed manager about, which is how a
   * hospital ends up with a whiteboard beside the screen and two answers to one
   * question.
   */
  it('gates the bed board on a low-risk key', () => {
    const board = PERMISSION_CATALOGUE.find((p) => p.key === 'bed.board.read');
    expect(board?.risk).toBe('low');
    expect(board?.requiresReason ?? false).toBe(false);
  });

  /**
   * And blocking a bed is not, because a blocked bed is one the hospital does
   * not have and somebody will go looking for it.
   */
  it('keeps blocking a bed reasoned and off the board screen', () => {
    const block = PERMISSION_CATALOGUE.find((p) => p.key === 'bed.block');
    expect(block?.requiresReason).toBe(true);
    expect(IP_SCREENS.some((s) => s.permission === 'bed.block')).toBe(false);
  });

  /**
   * Returning a bed to the board without a completed clean is possible and
   * costs a reason. Without the exception, the rule gets worked around by
   * marking a fake clean — which is worse, because it looks like a clean.
   */
  it('keeps the cleaning override reasoned', () => {
    const override = PERMISSION_CATALOGUE.find((p) => p.key === 'housekeeping.override');
    expect(override?.requiresReason).toBe(true);
  });

  it('explains every denial in plain words', () => {
    for (const screen of IP_SCREENS) {
      expect(screen.summary.length).toBeGreaterThan(20);
      expect(screen.deniedExplanation.length).toBeGreaterThan(20);
      expect(screen.keywords.length).toBeGreaterThan(0);
    }
  });

  it('uses a distinct key and route per screen', () => {
    expect(new Set(IP_SCREENS.map((s) => s.key)).size).toBe(IP_SCREENS.length);
    expect(new Set(IP_SCREENS.map((s) => s.href)).size).toBe(IP_SCREENS.length);
  });

  it('declares no route with a dynamic segment', () => {
    for (const route of IP_ROUTES) {
      expect(route).not.toMatch(/[[\]]/u);
    }
  });

  it('throws on an unknown screen key rather than rendering an ungated page', () => {
    expect(() => ipScreen('nope')).toThrow(/Unknown inpatient screen/u);
  });
});
