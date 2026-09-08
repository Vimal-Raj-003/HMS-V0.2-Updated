import { expect, test } from '@playwright/test';
import { ROLE_TEMPLATES } from '@vims/contracts';
import { ADMIN_SCREENS } from '../src/features/admin/screens';
import { CLINICAL_SCREENS } from '../src/features/clinical/screens';
import { DIAGNOSTICS_SCREENS } from '../src/features/diagnostics/screens';
import { ER_SCREENS } from '../src/features/emergency/screens';
import { FRONT_OFFICE_SCREENS } from '../src/features/frontoffice/screens';
import { IP_SCREENS } from '../src/features/inpatient/screens';
import { INVENTORY_SCREENS } from '../src/features/inventory/screens';
import { ORTHO_SCREENS } from '../src/features/ortho/screens';
import { PATIENT_SCREENS } from '../src/features/patient/screens';
import { PHARMACY_SCREENS } from '../src/features/pharmacy/screens';
import { PROCEDURE_SCREENS } from '../src/features/procedures/screens';
import { RCM_SCREENS } from '../src/features/rcm/screens';
import { SPECIALTY_SCREENS } from '../src/features/specialty/screens';
import { signIn } from './fixtures';

/**
 * Every registered screen, opened by somebody entitled to open it.
 *
 * The rest of this suite tests a handful of screens deeply. This one tests all
 * of them shallowly, and the distinction matters: a console can be built,
 * migrated, permissioned and routed, and still throw on first paint because a
 * hook reads a field the API stopped returning. Nothing else in the repo would
 * notice — the unit tests mock the fetch, the integration tests never open a
 * browser, and the deep e2e specs only cover phases 0–2.
 *
 * The assertions are deliberately weak. A screen passes if it renders *itself*:
 * not the permission gate, not the licence gate, and no uncaught exception. It
 * is not asserting that the screen is correct; it is asserting that the screen
 * exists, which for 110 screens across thirty consoles had never been checked
 * at all.
 *
 * Screens are grouped by persona rather than given a test each, because signing
 * in is the expensive part: 110 logins is four minutes of the suite spent on
 * authentication that the login spec already covers.
 */

interface Screen {
  readonly href: string;
  readonly label: string;
  readonly permission: string;
}

const ALL: readonly Screen[] = [
  ...ADMIN_SCREENS,
  ...CLINICAL_SCREENS,
  ...DIAGNOSTICS_SCREENS,
  ...ER_SCREENS,
  ...FRONT_OFFICE_SCREENS,
  ...IP_SCREENS,
  ...INVENTORY_SCREENS,
  ...ORTHO_SCREENS,
  ...PATIENT_SCREENS,
  ...PHARMACY_SCREENS,
  ...PROCEDURE_SCREENS,
  ...RCM_SCREENS,
  ...SPECIALTY_SCREENS,
].map((s) => ({ href: s.href, label: s.label, permission: s.permission }));

/**
 * The first seeded role template holding the screen's key.
 *
 * The seed creates one user per template, so "a role that holds it" and "a
 * login that can open it" are the same statement.
 */
function personaFor(permission: string): string | null {
  const template = ROLE_TEMPLATES.find((t) => (t.permissions).includes(permission));
  return template?.key ?? null;
}

const byPersona = new Map<string, Screen[]>();
const unreachable: Screen[] = [];
for (const screen of ALL) {
  const persona = personaFor(screen.permission);
  if (persona === null) {
    unreachable.push(screen);
    continue;
  }
  const list = byPersona.get(persona) ?? [];
  list.push(screen);
  byPersona.set(persona, list);
}

test.describe('every screen renders for somebody who may open it', () => {
  /**
   * A screen whose key no seeded role holds is a screen no login can reach.
   * That is a grant gap rather than a rendering one, and it is worth failing on
   * because the screen is shipped, routed and invisible.
   */
  test('every screen is reachable by at least one seeded role', () => {
    expect(
      unreachable.map((s) => `${s.href} needs ${s.permission}`),
      'screens no seeded role template can open',
    ).toEqual([]);
  });

  for (const [persona, screens] of byPersona) {
    test(`${persona} opens ${String(screens.length)} screen(s)`, async ({ page }) => {
      test.setTimeout(30_000 + screens.length * 12_000);

      const crashes: string[] = [];
      page.on('pageerror', (e) => crashes.push(`${page.url()}: ${e.message}`));

      await signIn(page, persona);

      const failures: string[] = [];
      for (const screen of screens) {
        await page.goto(screen.href);

        // The gates are the two ways a screen legitimately declines to render.
        // Either here means the grant or the licence is wrong, not the screen.
        if ((await page.getByTestId('permission-denied').count()) > 0) {
          failures.push(`${screen.href}: permission-denied despite ${persona} holding ${screen.permission}`);
          continue;
        }
        if ((await page.getByTestId('module-not-licensed').count()) > 0) {
          failures.push(`${screen.href}: module-not-licensed on a fully-entitled demo tenant`);
          continue;
        }

        // A screen that rendered has a heading. An error boundary does not.
        const heading = page.locator('h1, h2').first();
        try {
          await expect(heading).toBeVisible({ timeout: 10_000 });
        } catch {
          failures.push(`${screen.href}: nothing rendered (no heading within 10s)`);
        }
      }

      expect(failures, `${persona} could not open`).toEqual([]);
      expect(crashes, `uncaught exceptions while ${persona} browsed`).toEqual([]);
    });
  }
});
