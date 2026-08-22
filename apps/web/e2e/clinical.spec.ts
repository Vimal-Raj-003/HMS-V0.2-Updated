import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './fixtures';

/**
 * The four Phase-2 clinical screens in a real browser.
 *
 * **What this suite does not do, and why.** The golden paths — capture
 * observations → flag → alert, open a consultation → note → sign → amend, build
 * a prescription → hard stop → countersign — need a checked-in patient, a
 * started encounter and a drug master. The e2e stack seeds the `minimal` tier
 * (`e2e/stack.mts`), and `runSeed` skips `seedMasters`, `seedClinical` and the
 * patient population below `demo`, so none of those rows exist here. The API
 * also exposes no doctor's queue and no master-data listing, so the browser has
 * no way to discover an identifier even if the rows were there. Those flows are
 * asserted at component level in `src/features/clinical/**\/*.spec.tsx` against
 * the same mutations, including every safety behaviour.
 *
 * What this suite *is* the only place to assert: that each screen renders under
 * a real role with a real `/api/v1/me`, that a role without the key gets the
 * explanation rather than a broken page, that the screens are operable from the
 * keyboard, and that **axe reports zero violations on every one of them**.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** A syntactically valid identifier that no seeded row uses. */
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000001';

async function expectNoViolations(page: Page): Promise<void> {
  // Let any colour transition finish before sampling. The design system's
  // buttons carry `transition-colors`, and axe reads *computed* colour: scanning
  // mid-transition reports a blend of the disabled and enabled palettes as a
  // contrast failure that no user ever sees.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test.describe('clinical', () => {
  test('the hub offers a nurse only the screen they can open', async ({ page }) => {
    await signIn(page, 'nurse_opd');
    await page.goto('/clinical');
    await expect(page.getByTestId('clinical-home')).toBeVisible();

    await expect(page.getByRole('link', { name: /vitals room/i })).toBeVisible();
    // A nurse neither prescribes nor reads the governance report.
    await expect(page.getByRole('link', { name: /e-prescription/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /alert fatigue/i })).toHaveCount(0);

    await expectNoViolations(page);
  });

  test('the hub offers a doctor the consultation and the prescription', async ({ page }) => {
    await signIn(page, 'doctor_consultant_opd');
    await page.goto('/clinical');
    await expect(page.getByRole('link', { name: /doctor console/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /e-prescription/i })).toBeVisible();
    // Recording observations is a nursing key; the tile is not drawn at all.
    await expect(page.getByRole('link', { name: /vitals room/i })).toHaveCount(0);

    await expectNoViolations(page);
  });

  test('the vitals room asks for a patient before it reads anything', async ({ page }) => {
    await signIn(page, 'nurse_opd');
    await page.goto('/clinical/vitals');
    await expect(page).toHaveTitle(/Vitals room/);
    await expect(page.getByTestId('vitals-room')).toBeVisible();
    await expect(page.getByText('No patient chosen yet', { exact: false })).toBeVisible();

    await expectNoViolations(page);
  });

  /**
   * The nurse does not hold `vitals.configure`, so the configured bands are not
   * readable on this login and nothing may be coloured. The screen says so, and
   * every field reports "not scored" rather than a guess.
   */
  test('the vitals room colours nothing when it cannot read the hospital’s bands', async ({ page }) => {
    await signIn(page, 'nurse_opd');
    await page.goto('/clinical/vitals');
    await page.getByTestId('vitals-patient').fill(UNKNOWN_ID);

    await expect(page.getByTestId('vitals-entry-pad')).toBeVisible();
    await expect(page.getByTestId('bands-unavailable')).toBeVisible();

    await page.getByTestId('vitals-systolic').fill('190');
    await expect(page.getByTestId('flag-critical')).toHaveCount(0);
    await expect(page.getByTestId('flag-normal')).toHaveCount(0);
    await expect(page.getByTestId('flag-not-scored').first()).toBeVisible();

    await expectNoViolations(page);
  });

  test('the vitals room refuses an inconsistent blood pressure before the round trip', async ({ page }) => {
    await signIn(page, 'nurse_opd');
    await page.goto('/clinical/vitals');
    await page.getByTestId('vitals-patient').fill(UNKNOWN_ID);
    await page.getByTestId('vitals-systolic').fill('80');
    await page.getByTestId('vitals-diastolic').fill('95');

    await expect(page.getByTestId('vitals-problems')).toContainText('lower than systolic');
    await expect(page.getByTestId('vitals-save')).toBeDisabled();
  });

  test('a doctor cannot open the vitals room, and is told which key is missing', async ({ page }) => {
    await signIn(page, 'doctor_consultant_opd');
    await page.goto('/clinical/vitals');
    await expect(page.getByTestId('permission-denied')).toBeVisible();
    await expect(page.getByTestId('missing-permission')).toHaveText('vitals.record.create');

    await expectNoViolations(page);
  });

  test('the consultation asks for an encounter before it reads anything', async ({ page }) => {
    await signIn(page, 'doctor_consultant_opd');
    await page.goto('/clinical/console');
    await expect(page).toHaveTitle(/Consultation/);
    await expect(page.getByTestId('doctor-console')).toBeVisible();
    await expect(page.getByText('No consultation opened', { exact: false })).toBeVisible();

    await expectNoViolations(page);
  });

  test('the prescription screen is keyboard-operable and offers no way past a check it has not run', async ({
    page,
  }) => {
    await signIn(page, 'doctor_consultant_opd');
    await page.goto('/clinical/prescribe');
    await expect(page.getByTestId('prescription-screen')).toBeVisible();

    // `Alt+R` adds a line without a mouse — OP-002 §8's binding. The focus is
    // moved out of the text field first, because a screen shortcut that fired
    // while a clinician was typing into a field would be a bug, and
    // `useShortcuts` deliberately ignores keystrokes aimed at an input.
    await page.getByTestId('rx-patient').fill(UNKNOWN_ID);
    await page.getByTestId('rx-patient').blur();
    await page.keyboard.press('Alt+r');
    await expect(page.getByTestId('rx-lines')).toBeVisible();

    // Nothing on the screen offers to prescribe through a safety check.
    const buttons = await page.getByRole('button').allInnerTexts();
    for (const label of buttons) {
      expect(label).not.toMatch(/anyway|proceed|bypass|ignore alert/i);
    }

    await expectNoViolations(page);
  });

  test('a nurse cannot open the prescription screen', async ({ page }) => {
    await signIn(page, 'nurse_opd');
    await page.goto('/clinical/prescribe');
    await expect(page.getByTestId('permission-denied')).toBeVisible();
    await expect(page.getByTestId('missing-permission')).toHaveText('rx.create');
  });

  test('the alert-fatigue report opens for governance', async ({ page }) => {
    await signIn(page, 'hospital_admin');
    await page.goto('/clinical/alerts');
    await expect(page).toHaveTitle(/Alert fatigue/);
    await expect(page.getByTestId('alert-fatigue')).toBeVisible();
    await expect(page.getByTestId('fatigue-window')).toBeVisible();

    await expectNoViolations(page);
  });

  test('the alert-fatigue report is not open to a nurse', async ({ page }) => {
    await signIn(page, 'nurse_opd');
    await page.goto('/clinical/alerts');
    await expect(page.getByTestId('permission-denied')).toBeVisible();
    await expect(page.getByTestId('missing-permission')).toHaveText('cdss.report.read');
  });
});
