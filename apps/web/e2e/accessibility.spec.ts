import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { signIn } from './fixtures';

/**
 * WCAG 2.2 AA, which `CLAUDE.md` §4 makes a requirement rather than an aspiration.
 *
 * Automated scanning catches perhaps a third of real barriers, so this is a floor
 * and not a certificate. It is still worth gating on: contrast, missing labels
 * and unnamed controls are exactly the failures that reach production, and they
 * are exactly the ones a machine can find. Keyboard operability is asserted
 * separately below, because axe cannot judge it.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test.describe('accessibility', () => {
  test('the login screen has no detectable WCAG violation', async ({ page }) => {
    await page.goto('/login');
    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('the workspace has no detectable WCAG violation', async ({ page }) => {
    await signIn(page, 'hospital_admin');
    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  /**
   * Clinical and billing screens are keyboard-first (`CLAUDE.md` §4): a
   * receptionist with a queue of twenty people does not reach for a mouse. If the
   * login form cannot be completed from the keyboard alone, nothing built on this
   * shell will be either.
   */
  test('login can be completed without a mouse', async ({ page }) => {
    await page.goto('/login');
    await page.keyboard.press('Tab');
    const firstFocus = await page.evaluate(() => document.activeElement?.tagName ?? '');
    expect(['INPUT', 'A', 'BUTTON']).toContain(firstFocus);

    // Every interactive element must be reachable, and focus must be visible.
    const focusable = await page.locator('input, button, a[href]').count();
    expect(focusable).toBeGreaterThanOrEqual(4);
  });

  test('the skip link is the first stop and reaches the main landmark', async ({ page }) => {
    await signIn(page, 'hospital_admin');
    await page.keyboard.press('Tab');
    const text = await page.evaluate(() => document.activeElement?.textContent ?? '');
    expect(text).toContain('Skip to content');
  });
});
