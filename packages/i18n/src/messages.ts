/**
 * Message resolution with the one rule `docs/06 §8` makes non-negotiable:
 * **an untranslated key falls back to `en-IN`, never to the raw key.**
 *
 * Two entry points, for two very different consumers:
 *
 *  - `getMessages(locale)` returns the *merged* tree (`en-IN` deep-merged with
 *    the locale's own strings). This is what `next-intl` is handed, so the
 *    fallback happens structurally and no runtime hook is needed.
 *  - `translate(locale, key, values)` is the synchronous lookup used by the
 *    worker, the print layer and the notification templates, where there is no
 *    React tree to hang a provider on.
 */

import { getRawCatalogue, type AnyMessageKey, type MessageTree } from './catalogues.js';
import { DEFAULT_LOCALE, type LocaleCode } from './locales.js';

export type { AnyMessageKey, MessageKey, MessageNamespace, MessageTree } from './catalogues.js';

export type MessageValues = Readonly<Record<string, string | number>>;

function isTree(value: string | MessageTree | undefined): value is MessageTree {
  return typeof value === 'object' && value !== null;
}

function lookup(tree: MessageTree, key: string): string | undefined {
  let cursor: string | MessageTree | undefined = tree;
  for (const segment of key.split('.')) {
    if (!isTree(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return typeof cursor === 'string' ? cursor : undefined;
}

function deepMerge(base: MessageTree, override: MessageTree): MessageTree {
  const merged: Record<string, string | MessageTree> = {};
  for (const [key, value] of Object.entries(base)) {
    merged[key] = value;
  }
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    merged[key] = isTree(existing) && isTree(value) ? deepMerge(existing, value) : value;
  }
  return merged;
}

const mergedCache = new Map<LocaleCode, MessageTree>();

/**
 * The catalogue handed to `NextIntlClientProvider` / `getMessages()`. Always
 * complete: every `en-IN` key is present, overridden where a translation exists.
 */
export function getMessages(locale: LocaleCode): MessageTree {
  const cached = mergedCache.get(locale);
  if (cached !== undefined) return cached;
  const reference = getRawCatalogue(DEFAULT_LOCALE);
  const merged = locale === DEFAULT_LOCALE ? reference : deepMerge(reference, getRawCatalogue(locale));
  mergedCache.set(locale, merged);
  return merged;
}

/** True only when the locale itself carries the key — the fallback does not count. */
export function hasOwnTranslation(locale: LocaleCode, key: AnyMessageKey): boolean {
  return lookup(getRawCatalogue(locale), key) !== undefined;
}

export interface MessageResolution {
  readonly key: string;
  readonly value: string;
  /** Which catalogue actually supplied the string. */
  readonly resolvedFrom: LocaleCode;
  /** True when `resolvedFrom !== locale`, i.e. the `en-IN` fallback was used. */
  readonly fellBack: boolean;
}

/**
 * Resolve a key, reporting *where* the string came from. The UI never needs
 * this; the coverage tooling and the "which screens are still English?" report
 * do, and so does anything that must not silently ship English to a patient.
 */
export function resolveMessage(locale: LocaleCode, key: AnyMessageKey): MessageResolution | undefined {
  const own = lookup(getRawCatalogue(locale), key);
  if (own !== undefined) {
    return { key, value: own, resolvedFrom: locale, fellBack: false };
  }
  const fallback = lookup(getRawCatalogue(DEFAULT_LOCALE), key);
  if (fallback !== undefined) {
    return { key, value: fallback, resolvedFrom: DEFAULT_LOCALE, fellBack: locale !== DEFAULT_LOCALE };
  }
  return undefined;
}

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Simple `{name}` interpolation. Full ICU (plural/select/gender) is `next-intl`'s
 * job in the browser; this is the server-side path for print templates, SMS and
 * notification bodies, where the catalogue authors keep the syntax simple on
 * purpose. An unknown placeholder is left verbatim rather than throwing — a
 * missing variable must never take down a discharge summary.
 */
export function interpolate(template: string, values?: MessageValues): string {
  if (values === undefined) return template;
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Look up and interpolate. Falls back to `en-IN`; if the key does not exist at
 * all it returns the key itself, which is what `next-intl` does and what makes
 * the missing key obvious in a screenshot instead of rendering an empty label.
 */
export function translate(locale: LocaleCode, key: AnyMessageKey, values?: MessageValues): string {
  const resolved = resolveMessage(locale, key);
  return resolved === undefined ? key : interpolate(resolved.value, values);
}

export type Translator = (key: AnyMessageKey, values?: MessageValues) => string;

/** A bound translator for a locale — the shape a service or worker wants. */
export function createTranslator(locale: LocaleCode): Translator {
  return (key, values) => translate(locale, key, values);
}
