/**
 * The locale contract, restated — and why it is restated rather than imported.
 *
 * The list itself belongs to `@vims/i18n`: decision D-13 fixes it at `en-IN`
 * plus `hi, ta, te, ml, kn, mr, bn, gu, or, pa` and `ar`, and the package states
 * the invariant this module depends on — "`en-IN` is always present, always
 * complete, and is the fallback for every other locale".
 *
 * `@vims/i18n` cannot be imported here, though, and the reason is structural
 * rather than stylistic. Its `build` script is `tsc --noEmit`: it ships
 * TypeScript source and JSON catalogues for a bundler to consume, with
 * `"main": "./src/index.ts"`. `@vims/contracts` ships a real `dist/` precisely
 * because `services/*` run as compiled Node — `services/integration-hub` starts
 * as `node dist/main.js`, and its startup suite asserts that it does. A runtime
 * `import { DEFAULT_LOCALE } from '@vims/i18n'` therefore typechecks, passes
 * every vitest run, and then fails in the container with
 * `ERR_MODULE_NOT_FOUND: packages/i18n/src/locales.js` — which is exactly the
 * class of failure `service-startup.integration.spec.ts` exists to catch, and it
 * did catch it.
 *
 * Giving `@vims/i18n` a JavaScript build is the real fix and is a one-line
 * change to its `build` script plus an `exports` map, but it is a change to
 * another package. Until that happens the constants live here, and
 * `locales.spec.ts` imports the real package — under vitest, where TypeScript
 * resolution works — and asserts the two lists are identical. Drift therefore
 * fails a test rather than reaching a hospital as a Tamil message that fell back
 * to a locale nobody enabled.
 */

/** D-13, in the canonical display order of the language picker. */
export const MESSAGING_LOCALE_CODES = [
  'en-IN',
  'hi',
  'ta',
  'te',
  'ml',
  'kn',
  'mr',
  'bn',
  'gu',
  'or',
  'pa',
  'ar',
] as const;

export type LocaleCode = (typeof MESSAGING_LOCALE_CODES)[number];

/**
 * The one fallback, which can never be turned off. A missing Tamil template
 * renders the English one; it never renders a key and never silently picks a
 * neighbouring language.
 */
export const MESSAGING_DEFAULT_LOCALE: LocaleCode = 'en-IN';

const known = new Set<string>(MESSAGING_LOCALE_CODES);

export function isMessagingLocale(value: unknown): value is LocaleCode {
  return typeof value === 'string' && known.has(value);
}
