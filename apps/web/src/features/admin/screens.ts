import type { Route } from 'next';

/**
 * The admin console's screens, declared once.
 *
 * The left navigation, the console home tiles and the ⌘K palette all read this
 * list. Declaring it three times is how a screen ends up reachable from the
 * palette by somebody whose navigation correctly hid it — the palette is a
 * navigation surface too, and `docs/06` §4.1 applies to it identically.
 *
 * Each entry carries the **API's** permission key, not a UI-invented one, so a
 * screen is offered exactly when its first request would succeed.
 */
export interface AdminScreen {
  readonly key: string;
  readonly label: string;
  readonly href: Route;
  readonly permission: string;
  /** One line for the console home tile and the palette's secondary text. */
  readonly summary: string;
  /** Shown on the permission-denied state, in plain words (docs/06 §6.7). */
  readonly deniedExplanation: string;
  /** ⌘K keywords beyond the label — what a user would actually type. */
  readonly keywords: readonly string[];
}

export const ADMIN_SCREENS: readonly AdminScreen[] = [
  {
    key: 'users',
    label: 'Users',
    href: '/admin/users',
    permission: 'admin.user.read',
    summary: 'Staff, partner and service accounts, their roles and their sessions.',
    deniedExplanation:
      'Seeing staff accounts needs the permission to read the user directory, which is held by hospital and branch administrators and by IT.',
    keywords: ['staff', 'accounts', 'people', 'deactivate', 'password', 'invite'],
  },
  {
    key: 'roles',
    label: 'Roles & permissions',
    href: '/admin/roles',
    permission: 'admin.role.read',
    summary: 'The permission catalogue, the 64 role templates, and the matrix editor.',
    deniedExplanation:
      'The role matrix is visible to administrators, heads of department and auditors. Your roles do not include any of those.',
    keywords: ['rbac', 'matrix', 'permission', 'grant', 'revoke', 'sod', 'template'],
  },
  {
    key: 'branches',
    label: 'Branches',
    href: '/admin/branches',
    permission: 'org.read',
    summary: 'Sites, satellites and collection centres, and which ones you are granted.',
    deniedExplanation:
      'Reading the branch hierarchy is granted to every staff account. Yours is an external or patient account, which is scoped to its own records.',
    keywords: ['site', 'hospital', 'location', 'group', 'satellite'],
  },
  {
    key: 'settings',
    label: 'Settings',
    href: '/admin/settings',
    permission: 'admin.settings.read',
    summary: 'Typed configuration declared by each module, with its provenance and history.',
    deniedExplanation:
      'Configuration is readable by hospital and branch administrators. Ask yours if you need a value changed.',
    keywords: ['config', 'configuration', 'timeout', 'policy', 'preferences'],
  },
  {
    key: 'flags',
    label: 'Feature flags',
    href: '/admin/flags',
    permission: 'admin.flags.configure',
    summary: 'What is switched on for this hospital, within what the licence allows.',
    deniedExplanation:
      'Feature flags show what the hospital is licensed for, which is commercial information, so the same permission covers reading and changing them.',
    keywords: ['toggle', 'rollout', 'beta', 'module', 'enable'],
  },
  {
    key: 'licence',
    label: 'Licence',
    href: '/admin/licence',
    permission: 'admin.licence.read',
    summary: 'Plan, degradation tier, entitlements and the keys safety never lets be gated.',
    deniedExplanation:
      'Plan and seat information is commercial, and is shown to administrators rather than to every user.',
    keywords: ['plan', 'subscription', 'seats', 'billing', 'entitlement', 'expiry'],
  },
  {
    key: 'audit',
    label: 'Audit log',
    href: '/admin/audit',
    permission: 'admin.audit.read',
    summary: 'Append-only, hash-chained record of who did what, with before-and-after values.',
    deniedExplanation:
      'The audit trail is read by administrators, the privacy officer and auditors. Reading it is itself audited, which is why the permission is narrow.',
    keywords: ['log', 'trail', 'history', 'who changed', 'break glass', 'phi', 'investigate'],
  },
];

export function adminScreen(key: string): AdminScreen {
  const screen = ADMIN_SCREENS.find((candidate) => candidate.key === key);
  if (screen === undefined) throw new Error(`Unknown admin screen: ${key}`);
  return screen;
}
