/**
 * The seam between this package and `next-intl` in `apps/web`.
 *
 * `next-intl` is a peer concern: this package must stay importable from the
 * worker, the API and the print layer, none of which have React. So instead of
 * depending on `next-intl` we expose the plain configuration object its
 * `getRequestConfig` callback returns, and `apps/web` does:
 *
 * ```ts
 * export default getRequestConfig(async ({ requestLocale }) =>
 *   buildRequestConfig(await requestLocale, hospitalLocales, hospitalTimeZone),
 * );
 * ```
 */

import { getMessages, type MessageTree } from './messages.js';
import type { HospitalLocaleConfig } from './enabled-locales.js';
import { pickLocale } from './enabled-locales.js';
import { getLocaleMeta, type LocaleCode, type TextDirection } from './locales.js';

export interface RequestConfig {
  readonly locale: LocaleCode;
  readonly messages: MessageTree;
  readonly timeZone: string;
  readonly direction: TextDirection;
  /** BCP-47 tag for `<html lang>` and every `Intl.*` call in the tree. */
  readonly bcp47: string;
  /** `docs/06 §8`: Indic scripts get +2 px line-height; nothing is uppercased. */
  readonly lineHeightBoostPx: number;
  readonly uppercaseAllowed: boolean;
}

/**
 * Resolve the request locale against what the hospital enables, then hand back
 * a complete (fallback-merged) catalogue. `requestLocale` is whatever the
 * middleware read from the path, cookie or `Accept-Language`; anything unknown
 * degrades to the hospital default rather than 404-ing a login page.
 */
export function buildRequestConfig(
  requestLocale: string | undefined,
  hospital: HospitalLocaleConfig,
  timeZone: string,
): RequestConfig {
  const locale = pickLocale(hospital, requestLocale);
  const meta = getLocaleMeta(locale);
  return {
    locale,
    messages: getMessages(locale),
    timeZone,
    direction: meta.direction,
    bcp47: meta.bcp47,
    lineHeightBoostPx: meta.lineHeightBoostPx,
    uppercaseAllowed: meta.uppercaseAllowed,
  };
}

/** Attributes for `<html>` — `dir` must come from the registry, never be hard-coded. */
export function htmlAttributes(locale: LocaleCode): { readonly lang: string; readonly dir: TextDirection } {
  const meta = getLocaleMeta(locale);
  return { lang: meta.code, dir: meta.direction };
}
