import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { HANDOFF, type StackHandoff } from './global-setup';

export const DEV_PASSWORD = 'VimsDev#2026';

export function stack(): StackHandoff {
  return JSON.parse(readFileSync(HANDOFF, 'utf8')) as StackHandoff;
}

/**
 * Signs in as a seeded role and waits for the workspace to be usable.
 *
 * The URL alone is not that moment. Sign-in finishes with a client-side
 * navigation, so `history` is rewritten before React has committed the new
 * route — including the `<title>` it hoists into `<head>`. Chromium closes that
 * gap fast enough to hide it; WebKit does not, and a caller that continued on
 * the URL would inspect a half-rendered document. Waiting for the role nav is
 * what makes the helper mean what it says.
 */
export async function signIn(page: Page, roleKey: string): Promise<void> {
  await signInAs(page, `${roleKey}@vims-blr`);
}

/**
 * The same thing, by full username.
 *
 * Roles have more than one seat — `nurse_ward@`, `nurse_ward.2@`,
 * `nurse_ward.3@` — because a hospital has a rota, and half the rules in this
 * system need two people who are not the same person. `signIn` names a role and
 * gets seat one; this names the seat.
 */
export async function signInAs(page: Page, username: string): Promise<void> {
  const { hospitalId } = stack();
  await page.goto('/login');
  await page.getByLabel('Hospital').fill(hospitalId);
  await page.getByLabel('Username, email or employee ID').fill(username);
  await page.getByLabel('Password').fill(DEV_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page, `${username} should reach a workspace`).toHaveURL(/\/dashboard/);
  await expect(page.getByTestId('role-nav')).toBeVisible();
}

/**
 * Every nav label this session can reach.
 *
 * `RoleNav` renders a group as a collapsible button whose children are not in
 * the DOM until it is expanded, so collecting only links would report a
 * two-level menu as a one-item one. Groups are expanded first, then links and
 * group buttons are both collected — the question is what the user can reach,
 * not how it happens to be marked up.
 */
export async function visibleNavLabels(page: Page): Promise<string[]> {
  const nav = page.getByTestId('role-nav');
  await expect(nav).toBeVisible();

  const groups = nav.getByRole('button');
  for (let i = 0; i < (await groups.count()); i += 1) {
    const group = groups.nth(i);
    if ((await group.getAttribute('aria-expanded')) === 'false') await group.click();
  }

  const labels = [
    ...(await nav.getByRole('button').allInnerTexts()),
    ...(await nav.getByRole('link').allInnerTexts()),
  ];
  return labels.map((t) => t.trim()).filter((t) => t.length > 0);
}
