import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { signIn, visibleNavLabels } from './fixtures';

/**
 * The admin console (EN-007 §8), end to end against the real API.
 *
 * The two assertions that matter most are opposites of each other: an
 * administrator can reach every screen, and a non-administrator cannot see that
 * they exist. `docs/06` §4.1 forbids rendering an item the user cannot use, and a
 * console that merely disables its links teaches staff to go and borrow somebody
 * else's password.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const SCREENS = [
  { path: '/admin', heading: 'Administration' },
  { path: '/admin/users', heading: 'Users' },
  { path: '/admin/roles', heading: 'Roles & permissions' },
  { path: '/admin/branches', heading: 'Branches' },
  { path: '/admin/settings', heading: 'Settings' },
  { path: '/admin/flags', heading: 'Feature flags' },
  { path: '/admin/licence', heading: 'Licence' },
  { path: '/admin/audit', heading: 'Audit log' },
] as const;

async function goToScreen(page: Page, path: string, heading: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
}

test.describe('a hospital administrator', () => {
  test('reaches every admin screen and each one renders its own content', async ({ page }) => {
    await signIn(page, 'hospital_admin');

    for (const screen of SCREENS) {
      await goToScreen(page, screen.path, screen.heading);
      // The screen resolved rather than falling back to the permission-denied
      // state, which is the failure mode a wrong permission key produces.
      await expect(page.getByTestId('permission-denied')).toHaveCount(0);
    }
  });

  test('sees every admin item in the navigation', async ({ page }) => {
    await signIn(page, 'hospital_admin');
    const labels = await visibleNavLabels(page);
    for (const label of [
      'Users',
      'Roles & permissions',
      'Branches',
      'Settings',
      'Feature flags',
      'Licence',
      'Audit log',
    ]) {
      expect(labels).toContain(label);
    }
  });

  test('loads the permission matrix with real catalogue data and can filter it', async ({ page }) => {
    await signIn(page, 'hospital_admin');
    await goToScreen(page, '/admin/roles', 'Roles & permissions');

    await expect(page.getByTestId('role-list')).toBeVisible();
    const count = page.getByTestId('matrix-count');
    await expect(count).toBeVisible();
    // The seeded catalogue is large; the point is that a real number arrived.
    // `[\d,]+` and not `\d+`: the count is rendered through `formatCount`, so
    // once the catalogue passed a thousand keys the number arrived as
    // "1,392" and a bare `\d+` stopped matching. The screen was right and this
    // assertion was quietly wrong for every release since.
    await expect(count).toContainText(/Showing [\d,]+ of [\d,]+ permissions/);

    await page.getByTestId('matrix-search').fill('audit');
    await expect(count).not.toContainText(/Showing 0 of/);
    const filtered = await count.textContent();
    await page.getByTestId('matrix-search').fill('');
    await expect(count).not.toHaveText(filtered ?? '');
  });

  test('searches the audit log and sees its own sign-in recorded', async ({ page }) => {
    await signIn(page, 'hospital_admin');
    await goToScreen(page, '/admin/audit', 'Audit log');

    // The log is never empty by the time an administrator has signed in.
    await expect(page.getByTestId('audit-row').first()).toBeVisible();
    await expect(page.getByTestId('audit-count')).toContainText(/row(s)? loaded/);
  });

  test('the console has no detectable WCAG violation on any screen', async ({ page }) => {
    await signIn(page, 'hospital_admin');
    for (const screen of SCREENS) {
      await goToScreen(page, screen.path, screen.heading);
      const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
      expect(results.violations, `${screen.path}: ${JSON.stringify(results.violations, null, 2)}`).toEqual(
        [],
      );
    }
  });
});

test.describe('a role without administrative permissions', () => {
  test('sees no administration item in the navigation at all', async ({ page }) => {
    await signIn(page, 'patient');
    const labels = await visibleNavLabels(page);
    for (const label of [
      'Administration',
      'Users',
      'Roles & permissions',
      'Branches',
      'Settings',
      'Feature flags',
      'Licence',
      'Audit log',
    ]) {
      expect(labels).not.toContain(label);
    }
  });

  test('reaching an admin URL directly is explained, not silently broken', async ({ page }) => {
    await signIn(page, 'patient');

    for (const path of ['/admin/users', '/admin/roles', '/admin/audit']) {
      await page.goto(path);
      const denied = page.getByTestId('permission-denied');
      await expect(denied).toBeVisible();
      // The missing key is named, because that is what an access request needs.
      await expect(page.getByTestId('missing-permission')).toContainText(/^admin\./);
    }
  });

  test('a clinical role sees no user, role, flag, licence or audit screen', async ({ page }) => {
    await signIn(page, 'nurse_ward');
    const labels = await visibleNavLabels(page);
    for (const label of ['Users', 'Roles & permissions', 'Feature flags', 'Licence', 'Audit log']) {
      expect(labels).not.toContain(label);
    }

    await page.goto('/admin/users');
    await expect(page.getByTestId('permission-denied')).toBeVisible();
    await expect(page.getByTestId('missing-permission')).toHaveText('admin.user.read');
  });

  test('the command palette lists only what the session can open', async ({ page }) => {
    await signIn(page, 'hospital_admin');
    await page.getByTestId('open-command-palette').click();
    await expect(page.getByPlaceholder('Type a screen or what you want to do…')).toBeVisible();
    await expect(page.getByRole('option', { name: /Audit log/ })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);

    await signIn(page, 'patient');
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByPlaceholder('Type a screen or what you want to do…')).toBeVisible();
    await expect(page.getByRole('option', { name: /Audit log/ })).toHaveCount(0);
    await expect(page.getByRole('option', { name: /Dashboard/ })).toBeVisible();
  });
});

test.describe('the audit log is read-only by construction', () => {
  test('offers no control that could change a row', async ({ page }) => {
    await signIn(page, 'hospital_admin');
    await goToScreen(page, '/admin/audit', 'Audit log');
    await expect(page.getByTestId('audit-row').first()).toBeVisible();

    for (const forbidden of [/^Edit/i, /^Delete/i, /^Amend/i, /^Redact/i]) {
      await expect(page.getByRole('button', { name: forbidden })).toHaveCount(0);
    }
  });
});
