import type { RoleNavItem } from '@vims/ui';
import { ADMIN_SCREENS } from '@/features/admin/screens';
import { DIAGNOSTICS_SCREENS } from '@/features/diagnostics/screens';

/**
 * The Phase-0 navigation.
 *
 * Every item carries the permission key that gates it, and `RoleNav` drops any
 * item the session does not hold — `docs/06` §4.1: "never render an item the
 * user cannot use". The keys below are real entries in the catalogue in
 * `packages/contracts`; an invented one would be dropped for everybody and the
 * mistake would look like a permissions problem rather than a typo.
 *
 * The administration group is generated from `ADMIN_SCREENS` so the menu, the
 * console home and the ⌘K palette cannot drift apart — a screen added to one and
 * forgotten in another is how a user ends up able to reach something their
 * navigation deliberately hid.
 *
 * Clinical modules join this list as their phases land, each behind its own key,
 * so a hospital that has not licensed a module never sees a door it cannot open.
 */
export const PHASE0_NAV: readonly RoleNavItem[] = [
  // No permission: every authenticated user has a home.
  { key: 'dashboard', label: 'Dashboard', href: '/dashboard' },
  /**
   * Phase 3 — diagnostics.
   *
   * Generated from `DIAGNOSTICS_SCREENS` for the same reason the administration
   * group is generated from `ADMIN_SCREENS`: the menu, the console home and the
   * ⌘K palette are three surfaces reading one list, and a screen added to one
   * and forgotten in another is how somebody ends up reaching a page their
   * navigation deliberately hid.
   *
   * The parent carries **no permission of its own** — the hub renders only the
   * tiles the session can open, and `RoleNav` drops each child the session
   * cannot use. A permission on the parent would hide the whole console from a
   * pathologist who holds four of the eight keys.
   */
  {
    key: 'diagnostics',
    label: 'Diagnostics',
    href: '/diagnostics',
    children: DIAGNOSTICS_SCREENS.map((screen) => ({
      key: screen.key,
      label: screen.label,
      href: screen.href,
      permission: screen.permission,
    })),
  },
  {
    key: 'administration',
    label: 'Administration',
    href: '/admin',
    children: ADMIN_SCREENS.map((screen) => ({
      key: screen.key,
      label: screen.label,
      href: screen.href,
      permission: screen.permission,
    })),
  },
];
