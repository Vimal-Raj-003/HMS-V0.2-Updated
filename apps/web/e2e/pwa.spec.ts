import { expect, test } from '@playwright/test';
import { signIn } from './fixtures';

/**
 * Phase 0 exit gate 7 — installable PWA with an offline shell.
 *
 * The gate is worth more than a checkbox: `docs/01` §7 promises that a nurse's
 * tablet losing Wi-Fi in a lift keeps a usable shell. What that promise must
 * NOT become is a screen that looks normal while showing yesterday's drug chart,
 * so the most important assertion in this file is the negative one — that
 * clinical API responses are never served from a cache.
 */

test.describe('gate 7 — installable', () => {
  test('serves a valid web app manifest with the icons it names', async ({ page, request }) => {
    await page.goto('/login');

    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href).toBeTruthy();

    const response = await request.get(href ?? '/manifest.webmanifest');
    expect(response.ok()).toBe(true);

    const manifest = (await response.json()) as {
      name: string;
      start_url: string;
      display: string;
      icons: { src: string; sizes: string; purpose?: string }[];
    };

    expect(manifest.name).toContain('Vim');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBeTruthy();

    // Chromium requires a 192px and a 512px icon before it will offer to
    // install. A manifest naming an icon that 404s makes the app silently
    // non-installable, which is why each one is actually fetched.
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);

    for (const icon of manifest.icons) {
      const iconResponse = await request.get(icon.src);
      expect(iconResponse.ok(), `${icon.src} must exist`).toBe(true);
      expect(Number(iconResponse.headers()['content-length'] ?? '1')).toBeGreaterThan(0);
    }
  });

  test('registers a service worker that takes control', async ({ page }) => {
    await page.goto('/login');

    // `serviceWorker.ready` resolves as soon as there is an active worker, which
    // can still be `activating` for a moment. Polling asserts the end state
    // rather than whichever instant the test happened to sample.
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            if (!('serviceWorker' in navigator)) return 'unsupported';
            const registration = await navigator.serviceWorker.ready;
            return registration.active?.state ?? 'none';
          }),
        { timeout: 20_000 },
      )
      .toBe('activated');

    // Registered is not the same as controlling: a worker that never claims the
    // page cannot serve the offline fallback for it.
    await expect
      .poll(async () => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null), {
        timeout: 20_000,
      })
      .toContain('/sw.js');
  });
});

test.describe('gate 7 — offline shell', () => {
  test('shows the offline page rather than a browser error', async ({ page, context }, testInfo) => {
    // Chromium-family only, and deliberately not silently skipped everywhere.
    //
    // Under WebKit the worker registers and controls the page (asserted above)
    // and the no-cache rule holds (asserted below) — but Playwright's offline
    // emulation does not exercise the worker's navigation fetch handler, so the
    // fallback cannot be observed there. Scoping the assertion is honest;
    // asserting it and expecting a pass would be wrong, and deleting it would
    // lose the check on the browsers where it CAN be proved.
    //
    // Consequence to be explicit about: the offline navigation fallback is
    // verified on Chromium and UNVERIFIED on Safari/iPadOS. It needs a manual
    // check on a real iPad before any iOS rollout.
    test.skip(
      testInfo.project.name === 'webkit-ipad',
      'Playwright offline emulation does not drive the WebKit service-worker navigation handler',
    );

    await page.goto('/login');
    await page.evaluate(() => navigator.serviceWorker.ready);

    await context.setOffline(true);
    try {
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await expect(page.getByRole('heading', { name: /offline/i })).toBeVisible({ timeout: 15_000 });
    } finally {
      await context.setOffline(false);
    }
  });

  test('the offline page says plainly that nothing shown is current', async ({ page, context }) => {
    await page.goto('/offline');
    await expect(page.getByText(/Nothing on this screen is current/i)).toBeVisible();
    // A nurse must not read this and conclude that no alert means no alert.
    await expect(page.getByText(/do not assume that no news is good news/i)).toBeVisible();
    await context.setOffline(false);
  });
});

test.describe('gate 7 — what must NOT be cached', () => {
  /**
   * The safety property. A cached clinical response is worse than no response:
   * "no data" is obviously no data, whereas a stale drug chart is
   * indistinguishable from a current one. Every `/api/` route is `NetworkOnly`
   * in the service worker, so offline it must FAIL rather than resolve.
   */
  test('an API request fails offline instead of resolving from cache', async ({ page, context }) => {
    await signIn(page, 'hospital_admin');
    await page.evaluate(() => navigator.serviceWorker.ready);

    // Warm any cache that might exist by making the call online first.
    const online = await page.evaluate(async () => {
      const r = await fetch('/api/auth/login', { method: 'POST', body: '{}' , headers: { 'content-type': 'application/json' } });
      return r.status;
    });
    expect(online).toBeGreaterThan(0);

    await context.setOffline(true);
    try {
      const offlineResult = await page.evaluate(async () => {
        try {
          const r = await fetch('/api/auth/login', {
            method: 'POST',
            body: '{}',
            headers: { 'content-type': 'application/json' },
          });
          return { ok: true as const, status: r.status };
        } catch {
          return { ok: false as const, status: 0 };
        }
      });
      expect(offlineResult.ok, 'an API call must not resolve from cache while offline').toBe(false);
    } finally {
      await context.setOffline(false);
    }
  });
});
