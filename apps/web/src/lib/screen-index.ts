import { ADMIN_SCREENS } from '@/features/admin/screens';
import { CLINICAL_SCREENS } from '@/features/clinical/screens';
import { DIAGNOSTICS_SCREENS } from '@/features/diagnostics/screens';
import { ER_SCREENS } from '@/features/emergency/screens';
import { FRONT_OFFICE_SCREENS } from '@/features/frontoffice/screens';
import { IP_SCREENS } from '@/features/inpatient/screens';
import { INVENTORY_SCREENS } from '@/features/inventory/screens';
import { ORTHO_SCREENS } from '@/features/ortho/screens';
import { PATIENT_SCREENS } from '@/features/patient/screens';
import { PHARMACY_SCREENS } from '@/features/pharmacy/screens';
import { PROCEDURE_SCREENS } from '@/features/procedures/screens';
import { RCM_SCREENS } from '@/features/rcm/screens';
import { SPECIALTY_SCREENS } from '@/features/specialty/screens';

/**
 * Every screen in the workspace, as one list.
 *
 * The navigation comment has claimed since Phase 0 that "the menu, the console
 * home and the ⌘K palette are three surfaces reading one list". Two of them
 * were: the palette read only `ADMIN_SCREENS`, so by Phase 8 it could not find
 * the bed board, the eye clinic or anything else built after Phase 0 — a search
 * box that quietly knew about a tenth of the product.
 *
 * `phase-08` gate 11 is what forced the issue: "Every console is toggled off:
 * no nav item, no route, **no search result**." A palette that never indexed a
 * console could pass that gate by accident and fail the one after it.
 *
 * Each catalogue keeps its own shape and its own owner; this only flattens
 * them, and holds no knowledge of any individual screen.
 */
export interface IndexedScreen {
  readonly key: string;
  readonly label: string;
  readonly href: string;
  /**
   * Which catalogue this came from — `inpatient`, `diagnostics`, `admin`.
   *
   * Distinct from `area`, which several catalogues use for a *sub*-area of
   * their own: diagnostics splits into lab, radiology and investigations, and
   * pharmacy into counter, stock and registers. Conflating the two makes
   * "is this an administration screen" unanswerable.
   */
  readonly catalogue: string;
  /** The catalogue's own grouping, or the catalogue name where it has none. */
  readonly area: string;
  readonly permission: string;
  readonly summary: string;
  readonly keywords: readonly string[];
  /** `null` for a platform screen that no licence gates. */
  readonly entitlement: string | null;
}

/** The fields every catalogue has, plus the two some of them added later. */
interface CatalogueEntry {
  readonly key: string;
  readonly label: string;
  readonly href: string;
  readonly permission: string;
  readonly summary: string;
  readonly keywords: readonly string[];
  readonly area?: string;
  readonly entitlement?: string | null;
}

/**
 * Flattens one catalogue.
 *
 * `area` and `entitlement` arrived with Phase 3 and Phase 5, so the Phase-0 and
 * Phase-1 catalogues have neither. The fallbacks are supplied here rather than
 * back-filled into those files, because both of them are `null`/platform for
 * good reasons — administration and patient identity are not licensed modules,
 * and a hospital locked out of either has nothing left to run.
 */
function index(
  screens: readonly CatalogueEntry[],
  catalogue: string,
  fallbackEntitlement: string | null = null,
): readonly IndexedScreen[] {
  return screens.map((screen) => ({
    key: screen.key,
    label: screen.label,
    href: screen.href,
    catalogue,
    area: screen.area ?? catalogue,
    permission: screen.permission,
    summary: screen.summary,
    keywords: screen.keywords,
    entitlement: screen.entitlement ?? fallbackEntitlement,
  }));
}

export const ALL_SCREENS: readonly IndexedScreen[] = Object.freeze([
  ...index(ADMIN_SCREENS, 'admin'),
  ...index(PATIENT_SCREENS, 'patient'),
  ...index(FRONT_OFFICE_SCREENS, 'frontoffice'),
  ...index(CLINICAL_SCREENS, 'clinical'),
  ...index(DIAGNOSTICS_SCREENS, 'diagnostics'),
  ...index(PHARMACY_SCREENS, 'pharmacy'),
  ...index(INVENTORY_SCREENS, 'inventory'),
  ...index(RCM_SCREENS, 'rcm'),
  ...index(ER_SCREENS, 'emergency'),
  ...index(ORTHO_SCREENS, 'ortho'),
  ...index(IP_SCREENS, 'inpatient'),
  ...index(PROCEDURE_SCREENS, 'procedures'),
  ...index(SPECIALTY_SCREENS, 'specialty'),
]);

/**
 * The screens this session can actually open.
 *
 * Both conditions, always: a permission answers "may this person", an
 * entitlement answers "did this hospital buy it". Offering a screen that fails
 * either and letting the API refuse is what teaches staff the product is
 * broken.
 */
export function openableScreens(
  granted: ReadonlySet<string>,
  licensed: ReadonlySet<string>,
): readonly IndexedScreen[] {
  return ALL_SCREENS.filter(
    (screen) =>
      granted.has(screen.permission) && (screen.entitlement === null || licensed.has(screen.entitlement)),
  );
}
