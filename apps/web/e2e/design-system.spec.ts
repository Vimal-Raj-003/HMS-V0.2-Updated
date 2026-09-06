import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { STORY_CATALOGUE } from '@vims/ui/stories';
import { signIn } from './fixtures';

/**
 * The other half of `docs/06` §5.2's per-component requirement.
 *
 * The gallery at `/design` renders every story in the five mandated variants;
 * this walks the same catalogue and scans what it rendered. The two read from
 * one source, so a component cannot be added to the gallery without also being
 * scanned, and a story cannot be quietly dropped from the scan while still
 * appearing in the gallery.
 *
 * Scanning the whole page rather than each specimen in isolation is deliberate.
 * The five variants sit on one page, so a single scan covers light, dark, high
 * contrast, 200 % zoom and RTL together — and it catches the failures that only
 * appear in combination, which is where they actually live: a contrast pair that
 * passes on `--bg-canvas` and fails on `--bg-layer-3`, a focus ring that
 * disappears in high contrast, a label that overlaps its field at 200 %.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test.describe('the design gallery — docs/06 §5.2', () => {
  test('is not reachable without a session', async ({ page }) => {
    // The gallery is developer-facing, but it lives inside a hospital
    // deployment. It must be behind the same door as everything else.
    await page.goto('/design');
    await expect(page).toHaveURL(/\/login/);
  });

  test('lists every catalogued component', async ({ page }) => {
    await signIn(page, 'hospital_admin');
    await page.goto('/design');
    await expect(page.getByRole('heading', { name: 'Design system', level: 1 })).toBeVisible();
    for (const component of STORY_CATALOGUE) {
      await expect(page.getByRole('link', { name: new RegExp(component.component) })).toBeVisible();
    }
  });

  for (const component of STORY_CATALOGUE) {
    test.describe(component.component, () => {
      test(`renders every story in all five variants`, async ({ page }) => {
        await signIn(page, 'hospital_admin');
        await page.goto(`/design/${component.slug}`);
        await expect(page.getByRole('heading', { name: component.component, level: 1 })).toBeVisible();

        for (const story of component.stories) {
          const row = page.locator(`[data-slot="story-row"][data-story="${story.id}"]`);
          await expect(row, `${component.slug}/${story.id} did not render`).toBeVisible();
          // Five specimens, one per mandated variant. Counting them is what
          // stops a variant being silently dropped from STORY_VARIANTS.
          await expect(row.locator('[data-slot="story-specimen"]')).toHaveCount(5);
        }
      });

      test('has no detectable WCAG violation in any variant', async ({ page }) => {
        await signIn(page, 'hospital_admin');
        await page.goto(`/design/${component.slug}`);
        await expect(page.getByRole('heading', { name: component.component, level: 1 })).toBeVisible();

        const results = await new AxeBuilder({ page })
          .withTags(WCAG)
          // The gallery's own chrome is scanned by the index test; here we want
          // the specimens, so that a violation is attributable to the component
          // rather than to the page that framed it.
          .include('[data-slot="story-row"]')
          .analyze();

        expect(
          results.violations,
          `${component.component}: ${JSON.stringify(results.violations, null, 2)}`,
        ).toEqual([]);
      });

      test('reaches every interactive control from the keyboard alone', async ({ page, browserName }) => {
        // WebKit only, and it is Safari's behaviour rather than ours: macOS ships
        // "Press Tab to highlight each item on a webpage" **off**, so Tab moves
        // between form fields and skips buttons and links entirely. The suite
        // measured 0 of 10 reachable controls on webkit while Chromium reached
        // all of them — the components are operable, the platform is opted out.
        // There is no Playwright switch for that preference, so the property is
        // asserted on the engines that honour it. A real Safari user who needs
        // keyboard access turns the setting on and gets the same behaviour.
        test.skip(
          browserName === 'webkit',
          'WebKit does not Tab to buttons or links unless full keyboard access is enabled in the OS',
        );

        await signIn(page, 'hospital_admin');
        await page.goto(`/design/${component.slug}`);
        await expect(page.getByRole('heading', { name: component.component, level: 1 })).toBeVisible();

        const SELECTOR =
          '[data-slot="story-row"] :is(button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"]))';

        // Stamp each control with an index before tabbing. An earlier version
        // keyed what it reached on `story:variant:tagName`, which collapses the
        // two buttons a TaskList row renders — Skip and Done are both BUTTON in
        // the same specimen — so the reached set could never match the control
        // count and the test failed on components that were perfectly operable.
        const count = await page.evaluate((selector) => {
          const nodes = [...document.querySelectorAll(selector)];
          nodes.forEach((node, i) => {
            node.setAttribute('data-kbd-index', String(i));
          });
          return nodes.length;
        }, SELECTOR);

        test.skip(count === 0, 'this component renders nothing interactive');

        await page.evaluate(() => {
          document.body.focus();
        });

        const reached = new Set<string>();
        // Generous bound: Tab also visits the page's own nav and back link, and
        // wraps through the browser chrome once.
        for (let i = 0; i < count * 3 + 30; i += 1) {
          await page.keyboard.press('Tab');
          const index = await page.evaluate(
            () => document.activeElement?.getAttribute('data-kbd-index') ?? null,
          );
          if (index !== null) reached.add(index);
          if (reached.size >= count) break;
        }

        expect(
          reached.size,
          `only ${reached.size} of ${count} interactive controls were reachable by Tab`,
        ).toBe(count);
      });
    });
  }
});
