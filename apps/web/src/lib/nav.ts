import type { RoleNavItem } from '@vims/ui';

/**
 * The Phase-0 navigation.
 *
 * Every item carries the permission key that gates it, and `RoleNav` drops any
 * item the session does not hold — `docs/06` §4.1: "never render an item the
 * user cannot use". The keys below are real entries in the catalogue in
 * `packages/contracts`; an invented one would be dropped for everybody and the
 * mistake would look like a permissions problem rather than a typo.
 *
 * Clinical and administrative modules join this list as their phases land, each
 * behind its own key, so a hospital that has not licensed a module never sees a
 * door it cannot open.
 */
export const PHASE0_NAV: readonly RoleNavItem[] = [
  // No permission: every authenticated user has a home.
  { key: 'dashboard', label: 'Dashboard', href: '/dashboard' },
  {
    key: 'administration',
    label: 'Administration',
    href: '/admin',
    children: [
      { key: 'users', label: 'Users', href: '/admin/users', permission: 'admin.user.read' },
      { key: 'roles', label: 'Roles & permissions', href: '/admin/roles', permission: 'admin.role.read' },
      { key: 'settings', label: 'Settings', href: '/admin/settings', permission: 'admin.settings.read' },
      { key: 'audit', label: 'Audit log', href: '/admin/audit', permission: 'admin.audit.read' },
      { key: 'licence', label: 'Licence', href: '/admin/licence', permission: 'admin.licence.read' },
    ],
  },
];
