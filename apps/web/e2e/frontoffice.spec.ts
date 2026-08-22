import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './fixtures';

/**
 * The three front-office screens in a real browser.
 *
 * **What this suite does not do, and why.** The golden paths — book →
 * reschedule → cancel, issue → call → skip → complete, open → split payment →
 * close — need a doctor with a published grid, a queue and a cash counter. The
 * e2e stack seeds the `minimal` tier (`e2e/stack.mts`), and `runSeed` skips
 * `seedMasters`, `seedFrontOffice` and the whole patient population below
 * `demo`, so none of those rows exist here. The API also exposes no
 * master-data listing (`GET /doctors`, `GET /queues`, `GET /cash/counters` do
 * not exist in Phase 1), so the browser has no way to discover an identifier
 * even if the rows were there. Those flows are asserted at component level in
 * `src/features/frontoffice/**\/*.spec.tsx` against the same mutations.
 *
 * What this suite *is* the only place to assert: that each screen renders under
 * a real role with a real `/api/v1/me`, that a role without the key gets the
 * explanation rather than a broken page, that the screens are operable from the
 * keyboard, and that **axe reports zero violations on every one of them**.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectNoViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test.describe('front office', () => {
  test('the hub offers a receptionist only the screens they can open', async ({ page }) => {
    await signIn(page, 'receptionist');
    await page.goto('/frontoffice');
    await expect(page.getByTestId('frontoffice-home')).toBeVisible();

    await expect(page.getByRole('link', { name: /appointment book/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /queue console/i })).toBeVisible();
    // A receptionist does not operate a drawer, so the tile is not drawn at all.
    await expect(page.getByRole('link', { name: /cash counter/i })).toHaveCount(0);

    await expectNoViolations(page);
  });

  test('the appointment book asks for a doctor before it asks the API for anything', async ({ page }) => {
    await signIn(page, 'receptionist');
    await page.goto('/frontoffice/appointments');
    await expect(page).toHaveTitle(/Appointment book/);
    await expect(page.getByTestId('appointment-book')).toBeVisible();
    await expect(page.getByText('No doctor chosen', { exact: false })).toBeVisible();
    await expect(page.getByTestId('doctor-key')).toBeVisible();

    await expectNoViolations(page);
  });

  test('the appointment book is operable from the keyboard', async ({ page }) => {
    await signIn(page, 'receptionist');
    await page.goto('/frontoffice/appointments');
    await expect(page.getByTestId('appointment-book')).toBeVisible();

    // `W` switches to the week view without a mouse; the range label follows.
    await page.keyboard.press('w');
    await expect(page.getByTestId('view-week')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('d');
    await expect(page.getByTestId('view-day')).toHaveAttribute('aria-pressed', 'true');
  });

  test('the queue console asks for a queue, and is never licence-gated', async ({ page }) => {
    await signIn(page, 'receptionist');
    await page.goto('/frontoffice/queue');
    await expect(page).toHaveTitle(/Queue console/);
    await expect(page.getByTestId('queue-console')).toBeVisible();
    await expect(page.getByText('No queue chosen', { exact: false })).toBeVisible();

    // EN-006 §5: a token can always be issued, whatever the licence says. The
    // control is offered to a receptionist, who holds `queue.token.issue`.
    await expect(page.getByTestId('issue-token')).toBeVisible();
    await expect(page.getByText(/not licensed/i)).toHaveCount(0);

    await expectNoViolations(page);
  });

  test('a receptionist is told why the cash counter is closed to them', async ({ page }) => {
    await signIn(page, 'receptionist');
    await page.goto('/frontoffice/cash');
    await expect(page.getByTestId('permission-denied')).toBeVisible();
    await expect(page.getByTestId('missing-permission')).toHaveText('receipt.shift.read');

    await expectNoViolations(page);
  });

  test('a cashier is asked to count the opening float before the drawer opens', async ({ page }) => {
    await signIn(page, 'cashier');
    await page.goto('/frontoffice/cash');
    await expect(page).toHaveTitle(/Cash counter/);
    await expect(page.getByTestId('open-shift-panel')).toBeVisible();
    await expect(page.getByTestId('cash-counter-id')).toBeVisible();
    // The float is counted on the denomination sheet, never typed as a total.
    await expect(page.getByRole('button', { name: 'Open the shift with this float' })).toBeDisabled();

    await expectNoViolations(page);
  });

  test('a cashier is told why the appointment book is closed to them', async ({ page }) => {
    await signIn(page, 'cashier');
    await page.goto('/frontoffice/appointments');
    await expect(page.getByTestId('permission-denied')).toBeVisible();
    await expect(page.getByTestId('missing-permission')).toHaveText('appointment.list');

    await expectNoViolations(page);
  });
});
