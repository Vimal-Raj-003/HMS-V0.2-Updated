/**
 * The compiled message catalogues.
 *
 * Every locale is imported statically so that the registry is synchronous and
 * tree-shakeable, and so that a missing or malformed catalogue is a build error
 * rather than a 404 in a hospital with no internet. `en-IN` is the reference:
 * its shape defines `MessageKey`, and every other file is merged **over** it.
 */

/**
 * The `with { type: 'json' }` attribute is required, not decorative. Node's ESM
 * loader refuses a JSON import without it (ERR_IMPORT_ATTRIBUTE_MISSING), so a
 * service running `node dist/main.js` crashes on startup, while a bundler-based
 * consumer such as the web app is happy either way. That asymmetry is why this
 * broke only in the services, and only at runtime.
 */
import ar from './messages/ar.json' with { type: 'json' };
import bn from './messages/bn.json' with { type: 'json' };
import enIN from './messages/en-IN.json' with { type: 'json' };
import gu from './messages/gu.json' with { type: 'json' };
import hi from './messages/hi.json' with { type: 'json' };
import kn from './messages/kn.json' with { type: 'json' };
import ml from './messages/ml.json' with { type: 'json' };
import mr from './messages/mr.json' with { type: 'json' };
import or from './messages/or.json' with { type: 'json' };
import pa from './messages/pa.json' with { type: 'json' };
import ta from './messages/ta.json' with { type: 'json' };
import te from './messages/te.json' with { type: 'json' };
import type { LocaleCode } from './locales.js';

/** A next-intl compatible message tree. Leaves are ICU MessageFormat strings. */
export interface MessageTree {
  readonly [segment: string]: string | MessageTree;
}

/** The reference catalogue. Its type is the source of `MessageKey`. */
export const REFERENCE_CATALOGUE = enIN;

export type ReferenceCatalogue = typeof enIN;

/**
 * Dot-joined key union derived from the `en-IN` catalogue — the "typed
 * message-key infrastructure" a component uses so a renamed key is a type error
 * instead of a blank label on a clinical screen.
 */
export type MessageKey = LeafKeys<ReferenceCatalogue>;

/**
 * A known key, or any dotted key. Runtime catalogues (notification templates,
 * form labels authored by a hospital in EN-039) produce keys the compiler cannot
 * see, so the lookup functions accept both while still auto-completing the
 * compiled ones.
 */
export type AnyMessageKey = MessageKey | (string & Record<never, never>);

type LeafKeys<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : LeafKeys<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Top-level namespaces, as `next-intl`'s `useTranslations('nav')` consumes them. */
export type MessageNamespace = keyof ReferenceCatalogue;

const CATALOGUES: Readonly<Record<LocaleCode, MessageTree>> = Object.freeze({
  'en-IN': enIN,
  hi,
  ta,
  te,
  ml,
  kn,
  mr,
  bn,
  gu,
  or,
  pa,
  ar,
});

/**
 * The catalogue **exactly as authored** — partial for locales that are still
 * being translated. Use `getMessages` for anything that renders.
 */
export function getRawCatalogue(locale: LocaleCode): MessageTree {
  return CATALOGUES[locale];
}
