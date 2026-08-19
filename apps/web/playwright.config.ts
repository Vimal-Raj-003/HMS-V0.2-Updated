import { defineConfig, devices } from '@playwright/test';

/**
 * Browser suite for the Phase-0 exit gates.
 *
 * `fullyParallel` is off and there is a single worker: the suite signs in as
 * eight different roles against one seeded database, and parallel workers would
 * race on the shared account-lockout counters — a flake that looks exactly like
 * a real authentication bug.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] === 'true' ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: 'http://localhost:3400',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    // Nurses and doctors work on tablets; a nav that only works at 1440px is a
    // nav that does not work (docs/06 §7). This runs Chromium at a tablet
    // viewport, which is what exercises the responsive layout.
    //
    // It is deliberately NOT the WebKit iPad profile. Under WebKit the session
    // cookie is not retained across the navigation that follows sign-in, so every
    // authenticated test times out. That is a real finding about Safari/iPadOS
    // support and is tracked as an open question — it is not something to paper
    // over by weakening the cookie, which was tried and did not help either.
    {
      name: 'tablet',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1080, height: 810 }, isMobile: false },
    },
  ],
});
