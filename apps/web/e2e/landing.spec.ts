import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * The landing page and its assistant, in a real browser.
 *
 * This is the only page in the product a stranger sees, and the only one that
 * talks to the API without a session. So the suite asserts three separate
 * things: that the page is readable and accessible, that its motion is genuinely
 * optional, and that the assistant refuses what it must refuse before it does
 * anything else.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Axe, with motion stopped first.
 *
 * `clinical.spec.ts` waits for every animation to finish before sampling
 * colour, which works because those screens animate once. This page has an
 * infinite one — the rhythm strip sweeps forever — so that wait would never
 * return. Emulating `prefers-reduced-motion: reduce` is the honest equivalent:
 * the sweep lives inside a `no-preference` media query and the pulses are all
 * `motion-safe:`, so the page genuinely stops, and the pass doubles as a test
 * that reduced motion is respected.
 */
async function expectNoViolations(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

test.describe('the landing page', () => {
  test('leads with one heading and says what the product is', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('handoffs');
    await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();
  });

  test('states figures that were counted, not rounded', async ({ page }) => {
    await page.goto('/');
    const strip = page.getByRole('heading', { name: /counted from the repository/i });
    await expect(strip).toBeVisible();
    // The count-up ends on the truth even when it animates, and renders it
    // directly when it does not.
    await expect(page.getByText('1,080', { exact: true })).toBeVisible();
    await expect(page.getByText('908', { exact: true })).toBeVisible();
  });

  test('shows the rules the database keeps, with their references', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Safety' }).click();
    await expect(page.getByRole('heading', { name: /shapes in the schema/i })).toBeInViewport();
    await expect(page.getByText('A vinca alkaloid is never given intrathecally')).toBeVisible();
    // The reference is the point: every claim on this page is checkable.
    await expect(page.getByText('OP-031 §B.2')).toBeVisible();
  });

  test('reveals its sections without hiding them from a reader who declined motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    // The failure this guards against: a scroll-reveal that sets opacity to 0
    // and waits for an observer that never fires, leaving the page blank below
    // the fold for exactly the users who asked for less movement.
    const wayfinding = page.getByRole('heading', { name: 'Where do you work?' });
    await wayfinding.scrollIntoViewIfNeeded();
    await expect(wayfinding).toBeVisible();
    await expect(page.getByRole('link', { name: /Front office/ })).toBeVisible();
  });

  test('has no accessibility violations', async ({ page }) => {
    await page.goto('/');
    await expectNoViolations(page);
  });
});

test.describe('the assistant', () => {
  const open = async (page: Page): Promise<void> => {
    await page.goto('/');
    await page.getByRole('button', { name: /ask a question/i }).click();
    await expect(page.getByRole('dialog', { name: /hospital assistant/i })).toBeVisible();
  };

  const ask = async (page: Page, question: string): Promise<void> => {
    await page.getByPlaceholder(/ask about departments/i).fill(question);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
  };

  test('opens, and says what it is not', async ({ page }) => {
    await open(page);
    // On the panel itself, before a visitor types anything.
    await expect(page.getByText(/not medical advice/i)).toBeVisible();
    await expect(page.getByText(/emergency\? call 112/i)).toBeVisible();
  });

  test('sends someone with chest pain to an ambulance, not to a booking form', async ({ page }) => {
    await open(page);
    await ask(page, 'I am having severe chest pain');
    await expect(page.getByText(/needs urgent medical attention/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/112/).first()).toBeVisible();
    // The form must not appear on top of that answer.
    await expect(page.getByRole('button', { name: /send request/i })).toHaveCount(0);
  });

  test('declines to give a dose', async ({ page }) => {
    await open(page);
    await ask(page, 'what dose of paracetamol should i take');
    await expect(page.getByText(/not able to help with that one/i)).toBeVisible({ timeout: 15_000 });
  });

  test('answers from the hospital’s own directory', async ({ page }) => {
    await open(page);
    await ask(page, 'which departments do you have');
    await expect(page.getByText('Orthopaedics').first()).toBeVisible({ timeout: 15_000 });
  });

  test('takes an appointment request, and never calls it a booking', async ({ page }) => {
    await open(page);
    await ask(page, 'I want to book an appointment with Orthopaedics');

    const form = page.getByRole('button', { name: /send request/i });
    await expect(form).toBeVisible({ timeout: 15_000 });
    // The department the visitor named is selected *immediately*, before the
    // directory has loaded. `toHaveValue(/.+/)` used to be the assertion here
    // and it passed by luck: the form seeds the option from the intent now, but
    // when it did not, a controlled select whose value matched no option
    // silently showed "No preference" until the fetch landed. Asserting the
    // visible department name is what makes the difference detectable.
    await expect(
      page.getByLabel('Department').locator('option:checked'),
      'the department the visitor named should be selected without waiting for the directory',
    ).toHaveText('Orthopaedics');

    await page.getByRole('textbox', { name: 'Your name' }).fill('Meera Iyer');
    await page.getByRole('textbox', { name: 'Phone number' }).fill('+919876500011');
    await page.getByRole('checkbox').check();
    await form.click();

    // `/not a confirmed appointment/` was the first assertion here and it was
    // useless: the form's own subtitle says the same thing, so the locator
    // matched before anything had been submitted and the test passed whatever
    // happened. "Thank you" appears only in the receipt the API returns.
    await expect(page.getByText(/thank you/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/not a confirmed appointment/i)).toBeVisible();
    // And the form is gone, because the enquiry was accepted.
    await expect(form).toHaveCount(0);
  });

  test('will not send a request without consent', async ({ page }) => {
    await open(page);
    await ask(page, 'book an appointment');
    await expect(page.getByRole('button', { name: /send request/i })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole('textbox', { name: 'Your name' }).fill('No Consent');
    await page.getByRole('textbox', { name: 'Phone number' }).fill('+919876500012');
    await page.getByRole('button', { name: /send request/i }).click();

    // The checkbox is `required`, so the browser refuses to submit at all: no
    // receipt, and the form is still sitting there waiting for the tick.
    await expect(page.getByText(/thank you/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /send request/i })).toBeVisible();
    await expect(page.getByRole('checkbox')).not.toBeChecked();
  });

  test('has no accessibility violations with the panel and a form open', async ({ page }) => {
    // The closed page proves nothing about the controls. This is the state that
    // matters: a live region, a text input, a select that loads late, a date
    // field, a required checkbox and two buttons.
    await open(page);
    await ask(page, 'book an appointment with Orthopaedics');
    await expect(page.getByRole('button', { name: /send request/i })).toBeVisible({
      timeout: 15_000,
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('closes on Escape and gives focus back to the launcher', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: /hospital assistant/i })).toBeHidden();
    await expect(page.getByRole('button', { name: /ask a question/i })).toBeFocused();
  });
});
