import type { RoleNavItem } from '@vims/ui';
import { ADMIN_SCREENS } from '@/features/admin/screens';
import { DIAGNOSTICS_SCREENS } from '@/features/diagnostics/screens';
import { INVENTORY_SCREENS } from '@/features/inventory/screens';
import { PHARMACY_SCREENS } from '@/features/pharmacy/screens';
import { ER_SCREENS } from '@/features/emergency/screens';
import { IP_SCREENS } from '@/features/inpatient/screens';
import { PROCEDURE_SCREENS } from '@/features/procedures/screens';
import { SPECIALTY_SCREENS } from '@/features/specialty/screens';
import { ORTHO_SCREENS } from '@/features/ortho/screens';
import { RCM_SCREENS } from '@/features/rcm/screens';

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
      ...(screen.entitlement === null ? {} : { entitlement: screen.entitlement }),
    })),
  },
  /**
   * Phase 4 — the pharmacy counter.
   *
   * Generated from `PHARMACY_SCREENS`, for the same reason the diagnostics and
   * administration groups are generated from theirs: the menu, the console home
   * and the ⌘K palette are surfaces reading one list, and a screen added to one
   * and forgotten in another is how somebody reaches a page their navigation
   * deliberately hid.
   *
   * The parent carries **no permission of its own**. A counter pharmacist holds
   * the queue and the dispense keys and none of the register or day-close ones;
   * a permission on the parent would hide the whole console from them.
   */
  {
    key: 'pharmacy',
    label: 'Pharmacy',
    href: '/pharmacy',
    children: PHARMACY_SCREENS.map((screen) => ({
      key: screen.key,
      label: screen.label,
      href: screen.href,
      permission: screen.permission,
      ...(screen.entitlement === null ? {} : { entitlement: screen.entitlement }),
    })),
  },
  /**
   * Phase 4 — stores, purchase and vendors.
   *
   * Separate from the pharmacy group rather than nested under it, because these
   * are different hands: a materials manager, a purchase officer and an accounts
   * payable clerk never open the dispensing counter, and a counter pharmacist
   * rarely opens a comparative statement. `docs/06` §4.1 caps the navigation at
   * two levels, so a combined "supply chain" parent would have pushed one of the
   * two into a third.
   */
  {
    key: 'inventory',
    label: 'Stores & purchase',
    href: '/inventory',
    children: INVENTORY_SCREENS.map((screen) => ({
      key: screen.key,
      label: screen.label,
      href: screen.href,
      permission: screen.permission,
      ...(screen.entitlement === null ? {} : { entitlement: screen.entitlement }),
    })),
  },
  /**
   * Phase 5. Pricing sits above administration and below the operational
   * consoles: a biller reaches it several times a day, an administrator rarely.
   */
  /**
   * Phase 6. Above the revenue cycle and below the clinical consoles: the ER
   * board is a screen somebody looks at every few minutes for a whole shift.
   */
  {
    key: 'emergency',
    label: 'Emergency',
    href: '/er/board',
    children: ER_SCREENS.map((screen) => ({
      key: screen.key,
      label: screen.label,
      href: screen.href,
      permission: screen.permission,
      ...(screen.entitlement === null ? {} : { entitlement: screen.entitlement }),
    })),
  },
  /**
   * Phase 6. Directly under Emergency: a fracture registered in the resus bay
   * is followed up in this clinic, and the two are one journey.
   */
  {
    key: 'ortho',
    label: 'Orthopaedics',
    href: '/ortho/fractures',
    children: ORTHO_SCREENS.map((screen) => ({
      key: screen.key,
      label: screen.label,
      href: screen.href,
      permission: screen.permission,
      ...(screen.entitlement === null ? {} : { entitlement: screen.entitlement }),
    })),
  },
  /**
   * Phase 7. After orthopaedics, because the ward is where a fracture patient
   * goes next and the bed board is read by the same people.
   */
  {
    key: 'inpatient',
    label: 'Inpatient',
    href: '/ip/board',
    children: IP_SCREENS.map((screen) => ({
      key: screen.key,
      label: screen.label,
      href: screen.href,
      permission: screen.permission,
      ...(screen.entitlement === null ? {} : { entitlement: screen.entitlement }),
    })),
  },
  /**
   * Phase 8. The framework's own screen only — a console's screens belong to
   * the console, and appear under it once it is registered and switched on.
   */
  /**
   * Phase 8. Before the specialty consoles, because most of them order into it:
   * the eye clinic's laser, dermatology's biopsy and the pain clinic's block
   * all land on this one board.
   */
  {
    key: 'procedures',
    label: 'Procedures',
    href: '/procedures/board',
    children: PROCEDURE_SCREENS.map((screen) => ({
      key: screen.key,
      label: screen.label,
      href: screen.href,
      permission: screen.permission,
      ...(screen.entitlement === null ? {} : { entitlement: screen.entitlement }),
    })),
  },
  {
    key: 'specialty',
    label: 'Specialty',
    href: '/specialty/consoles',
    children: SPECIALTY_SCREENS.map((screen) => ({
      key: screen.key,
      label: screen.label,
      href: screen.href,
      permission: screen.permission,
      ...(screen.entitlement === null ? {} : { entitlement: screen.entitlement }),
    })),
  },
  {
    key: 'rcm',
    label: 'Revenue cycle',
    href: '/rcm/billing',
    children: RCM_SCREENS.map((screen) => ({
      key: screen.key,
      label: screen.label,
      href: screen.href,
      permission: screen.permission,
      ...(screen.entitlement === null ? {} : { entitlement: screen.entitlement }),
    })),
  },
  {
    key: 'administration',
    label: 'Administration',
    href: '/admin',
    // Administration carries no entitlement: a hospital that cannot reach its
    // own licence screen cannot fix its licence, and locking somebody out of the
    // thing that unlocks everything else is the one failure mode worth ruling
    // out by construction.
    children: ADMIN_SCREENS.map((screen) => ({
      key: screen.key,
      label: screen.label,
      href: screen.href,
      permission: screen.permission,
    })),
  },
];
