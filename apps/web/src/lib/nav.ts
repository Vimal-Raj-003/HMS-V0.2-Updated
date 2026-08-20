import type { RoleNavItem } from '@vims/ui';
import { ADMIN_SCREENS } from '@/features/admin/screens';

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
