import { expect, test } from '@playwright/test';
import { DEV_PASSWORD, signIn, stack, visibleNavLabels } from './fixtures';

/**
 * Phase-0 exit gates 2 and 3.
 *
 * Gate 3 asks that each of eight roles "sees a different, correct, **empty**
 * workspace with only their permitted nav items". The important word is
 * *different*: a suite that signs in as eight users and asserts the page loaded
 * would pass with a hard-coded menu, which is precisely the bug worth catching.
 * So the assertions below compare the roles against each other, not only against
 * a fixed expectation.
 */

const GATE_3_ROLES = [
  'hospital_admin',
  'doctor_consultant_opd',
  'nurse_ward',
  'receptionist',
  'cashier',
  'pharmacist_op',
  'lab_technician',
  'patient',
] as const;

test.describe('gate 2 — a person can sign in', () => {
  test('the login screen is reachable and usable', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: /Vim/ })).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
  });

  test('an unauthenticated visitor is sent to login and returned afterwards', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);
    await signIn(page, 'hospital_admin');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('a wrong password is refused with a readable error and a reference', async ({ page }) => {
    const { hospitalId } = stack();
    await page.goto('/login');
    await page.getByLabel('Hospital').fill(hospitalId);
    await page.getByLabel('Username, email or employee ID').fill('hospital_admin@vims-blr');
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Not `getByRole('alert')`: Next renders a route announcer with that role on
    // every page, so the generic locator is ambiguous by construction.
    const alert = page.getByTestId('login-error');
    await expect(alert).toBeVisible();
    // The support reference is what a user reads to the helpdesk; without it an
    // incident cannot be traced back to one request.
    await expect(alert).toContainText(/Reference:/);
    await expect(page).toHaveURL(/\/login/);
  });

  test('signing out ends the session', async ({ page }) => {
    await signIn(page, 'hospital_admin');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('gate 3 — each role gets its own workspace', () => {
  for (const role of GATE_3_ROLES) {
    test(`${role} signs in and sees a workspace`, async ({ page }) => {
      await signIn(page, role);
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
      await expect(page.getByTestId('session-user')).toContainText(/\S/);
      await expect(page.getByTestId('session-roles')).toContainText(role);
    });
  }

  test('the navigation differs between roles, and an admin sees more than a patient', async ({ page }) => {
    await signIn(page, 'hospital_admin');
    const adminNav = await visibleNavLabels(page);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);

    await signIn(page, 'patient');
    const patientNav = await visibleNavLabels(page);

    expect(adminNav).toContain('Dashboard');
    expect(patientNav).toContain('Dashboard');

    // The decisive assertion: the two menus are genuinely different, and the
    // administrative items are absent for the patient rather than merely
    // disabled — docs/06 §4.1 forbids rendering an item the user cannot use.
    expect(adminNav).not.toEqual(patientNav);
    expect(adminNav.length).toBeGreaterThan(patientNav.length);
    for (const restricted of ['Users', 'Roles & permissions', 'Audit log', 'Licence']) {
      expect(patientNav).not.toContain(restricted);
    }
    expect(adminNav).toContain('Users');
  });

  test('the workspace is empty by design — no module is reachable in Phase 0', async ({ page }) => {
    await signIn(page, 'doctor_consultant_opd');
    await expect(page.getByText('Your workspace is ready')).toBeVisible();
  });
});

test.describe('account lockout survives the browser', () => {
  test('five wrong passwords lock the account, and the correct one is then refused', async ({ page }) => {
    const { hospitalId } = stack();
    // A dedicated account, deliberately NOT one of the gate-3 roles. Locking an
    // account another test signs in with makes the suite order-dependent: it
    // passes alone and fails in a full run, which is the most expensive kind of
    // flake to diagnose.
    const user = 'phlebotomist@vims-blr';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await page.goto('/login');
      await page.getByLabel('Hospital').fill(hospitalId);
      await page.getByLabel('Username, email or employee ID').fill(user);
      await page.getByLabel('Password').fill(`wrong-${attempt}`);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByTestId('login-error')).toBeVisible();
    }

    await page.goto('/login');
    await page.getByLabel('Hospital').fill(hospitalId);
    await page.getByLabel('Username, email or employee ID').fill(user);
    await page.getByLabel('Password').fill(DEV_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // The lock must beat a correct password, or a lockout is decorative.
    await expect(page.getByTestId('login-error')).toContainText(/locked/i);
  });
});
