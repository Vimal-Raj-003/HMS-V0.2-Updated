import { PERMISSION_CATALOGUE } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import { PHASE0_NAV } from '@/lib/nav';
import { ADMIN_SCREENS, adminScreen } from './screens';

/**
 * The screen catalogue is the single source the navigation, the console home and
 * the ⌘K palette all read. Two failures it exists to prevent:
 *
 *  - a permission key that does not exist, which hides the screen from *everyone*
 *    and looks like a permissions bug rather than a typo;
 *  - a screen added to one surface and forgotten in another, which lets a user
 *    reach through the palette something their navigation deliberately hid.
 */

const KNOWN_KEYS = new Set(PERMISSION_CATALOGUE.map((permission) => permission.key));

describe('the admin screen catalogue', () => {
  it('gates every screen on a permission key that actually exists', () => {
    for (const screen of ADMIN_SCREENS) {
      expect(KNOWN_KEYS.has(screen.permission), `${screen.key} → ${screen.permission}`).toBe(true);
    }
  });

  it('gives every screen a summary and a plain-words explanation for the denied state', () => {
    for (const screen of ADMIN_SCREENS) {
      expect(screen.summary.length).toBeGreaterThan(20);
      expect(screen.deniedExplanation.length).toBeGreaterThan(20);
      expect(screen.keywords.length).toBeGreaterThan(0);
    }
  });

  it('uses a distinct key and route per screen', () => {
    expect(new Set(ADMIN_SCREENS.map((s) => s.key)).size).toBe(ADMIN_SCREENS.length);
    expect(new Set(ADMIN_SCREENS.map((s) => s.href)).size).toBe(ADMIN_SCREENS.length);
  });

  it('drives the navigation from the same list, with the same keys', () => {
    const group = PHASE0_NAV.find((item) => item.key === 'administration');
    expect(group).toBeDefined();
    expect(group?.children?.map((child) => child.key)).toEqual(ADMIN_SCREENS.map((s) => s.key));
    expect(group?.children?.map((child) => child.permission)).toEqual(ADMIN_SCREENS.map((s) => s.permission));
  });

  it('refuses to look up a screen that does not exist rather than rendering an ungated page', () => {
    expect(() => adminScreen('not-a-screen')).toThrow(/Unknown admin screen/);
  });
});
