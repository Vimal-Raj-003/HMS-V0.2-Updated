/**
 * The locale registry — the single place that answers "which languages does
 * Vim's HMS speak, and how does each of them render a number, a date and a
 * page?".
 *
 * The superset is fixed by `CLAUDE.md §4`, `docs/02 §2` and `docs/06 §8`, and
 * recorded as decision **D-13**: `en-IN` (default and always the fallback) plus
 * `hi, ta, te, ml, kn, mr, bn, gu, or, pa` and `ar` (RTL). Eleven non-default
 * locales, no more and no fewer. A hospital *enables* a subset of these
 * (`ui.enabled_locales` in `@vims/contracts`), but the superset itself only
 * changes by ADR.
 */

/** Order matters: it is the canonical display order of the language picker. */
export const LOCALE_CODES = [
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

export type LocaleCode = (typeof LOCALE_CODES)[number];

/**
 * `docs/06 §8`: "Untranslated keys fall back to `en-IN`". There is exactly one
 * fallback and it can never be turned off — a missing Tamil string must never
 * render as a raw key on a clinical screen.
 */
export const DEFAULT_LOCALE = 'en-IN';

export type TextDirection = 'ltr' | 'rtl';

/** `docs/06 §8`: Indian grouping `##,##,###.##` vs Western `###,###,###.##`. */
export type DigitGrouping = 'indian' | 'western';

export type LocaleScript = 'Latn' | 'Deva' | 'Taml' | 'Telu' | 'Mlym' | 'Knda' | 'Beng' | 'Gujr' | 'Orya' | 'Guru' | 'Arab';

export interface LocaleMeta {
  readonly code: LocaleCode;
  /** BCP-47 tag handed to `Intl.*`. `-u-nu-latn` pins Latin digits: a token or a
   *  dose rendered in Devanagari numerals is a patient-safety hazard. */
  readonly bcp47: string;
  readonly direction: TextDirection;
  readonly script: LocaleScript;
  /** Endonym, shown in the language picker (never translated). */
  readonly nativeName: string;
  readonly englishName: string;
  readonly numberGrouping: DigitGrouping;
  /** ISO-4217 default for a deployment using this locale; overridden per tenant. */
  readonly defaultCurrency: string;
  /** `docs/06 §8`: screen/document date format. */
  readonly dateFormat: 'dd-MM-yyyy';
  readonly longDateFormat: 'dd-MMM-yyyy';
  /** 24 h in every clinical context (`docs/06 §8`). */
  readonly timeFormat: 'HH:mm';
  readonly firstDayOfWeek: 0 | 1;
  /** `docs/06 §8`: Indic scripts need +2 px line-height over the Latin equivalent. */
  readonly lineHeightBoostPx: 0 | 2;
  /** `docs/06 §8`: "never `text-transform: uppercase` on Indic". */
  readonly uppercaseAllowed: boolean;
  /**
   * Rough expansion factor against `en-IN`, used by layout tests and by the
   * "8 longest strings per screen" check in `docs/06 §8`.
   */
  readonly expansionFactor: number;
}

function meta(
  code: LocaleCode,
  input: Omit<LocaleMeta, 'code' | 'dateFormat' | 'longDateFormat' | 'timeFormat' | 'defaultCurrency'> &
    Partial<Pick<LocaleMeta, 'defaultCurrency'>>,
): LocaleMeta {
  return {
    code,
    dateFormat: 'dd-MM-yyyy',
    longDateFormat: 'dd-MMM-yyyy',
    timeFormat: 'HH:mm',
    defaultCurrency: input.defaultCurrency ?? 'INR',
    bcp47: input.bcp47,
    direction: input.direction,
    script: input.script,
    nativeName: input.nativeName,
    englishName: input.englishName,
    numberGrouping: input.numberGrouping,
    firstDayOfWeek: input.firstDayOfWeek,
    lineHeightBoostPx: input.lineHeightBoostPx,
    uppercaseAllowed: input.uppercaseAllowed,
    expansionFactor: input.expansionFactor,
  };
}

const indic = {
  direction: 'ltr',
  numberGrouping: 'indian',
  firstDayOfWeek: 1,
  lineHeightBoostPx: 2,
  uppercaseAllowed: false,
} as const;

export const LOCALES: Readonly<Record<LocaleCode, LocaleMeta>> = Object.freeze({
  'en-IN': meta('en-IN', {
    bcp47: 'en-IN-u-nu-latn',
    direction: 'ltr',
    script: 'Latn',
    nativeName: 'English (India)',
    englishName: 'English (India)',
    numberGrouping: 'indian',
    firstDayOfWeek: 1,
    lineHeightBoostPx: 0,
    uppercaseAllowed: true,
    expansionFactor: 1,
  }),
  hi: meta('hi', {
    ...indic,
    bcp47: 'hi-IN-u-nu-latn',
    script: 'Deva',
    nativeName: 'हिन्दी',
    englishName: 'Hindi',
    expansionFactor: 1.2,
  }),
  ta: meta('ta', {
    ...indic,
    bcp47: 'ta-IN-u-nu-latn',
    script: 'Taml',
    nativeName: 'தமிழ்',
    englishName: 'Tamil',
    expansionFactor: 1.4,
  }),
  te: meta('te', {
    ...indic,
    bcp47: 'te-IN-u-nu-latn',
    script: 'Telu',
    nativeName: 'తెలుగు',
    englishName: 'Telugu',
    expansionFactor: 1.35,
  }),
  ml: meta('ml', {
    ...indic,
    bcp47: 'ml-IN-u-nu-latn',
    script: 'Mlym',
    nativeName: 'മലയാളം',
    englishName: 'Malayalam',
    expansionFactor: 1.4,
  }),
  kn: meta('kn', {
    ...indic,
    bcp47: 'kn-IN-u-nu-latn',
    script: 'Knda',
    nativeName: 'ಕನ್ನಡ',
    englishName: 'Kannada',
    expansionFactor: 1.35,
  }),
  mr: meta('mr', {
    ...indic,
    bcp47: 'mr-IN-u-nu-latn',
    script: 'Deva',
    nativeName: 'मराठी',
    englishName: 'Marathi',
    expansionFactor: 1.2,
  }),
  bn: meta('bn', {
    ...indic,
    bcp47: 'bn-IN-u-nu-latn',
    script: 'Beng',
    nativeName: 'বাংলা',
    englishName: 'Bengali',
    expansionFactor: 1.25,
  }),
  gu: meta('gu', {
    ...indic,
    bcp47: 'gu-IN-u-nu-latn',
    script: 'Gujr',
    nativeName: 'ગુજરાતી',
    englishName: 'Gujarati',
    expansionFactor: 1.2,
  }),
  or: meta('or', {
    ...indic,
    bcp47: 'or-IN-u-nu-latn',
    script: 'Orya',
    nativeName: 'ଓଡ଼ିଆ',
    englishName: 'Odia',
    expansionFactor: 1.25,
  }),
  pa: meta('pa', {
    ...indic,
    bcp47: 'pa-IN-u-nu-latn',
    script: 'Guru',
    nativeName: 'ਪੰਜਾਬੀ',
    englishName: 'Punjabi',
    expansionFactor: 1.2,
  }),
  ar: meta('ar', {
    // The only RTL locale in the superset — present because `CLAUDE.md §1`
    // requires UAE/Qatar deployments to follow without re-architecture.
    bcp47: 'ar-AE-u-nu-latn',
    direction: 'rtl',
    script: 'Arab',
    nativeName: 'العربية',
    englishName: 'Arabic',
    numberGrouping: 'western',
    defaultCurrency: 'AED',
    firstDayOfWeek: 0,
    lineHeightBoostPx: 2,
    uppercaseAllowed: false,
    expansionFactor: 1.25,
  }),
});

const localeSet = new Set<string>(LOCALE_CODES);

export function isLocaleCode(value: unknown): value is LocaleCode {
  return typeof value === 'string' && localeSet.has(value);
}

export class I18nError extends Error {
  override readonly name = 'I18nError';
}

export function getLocaleMeta(locale: LocaleCode): LocaleMeta {
  return LOCALES[locale];
}

/** Parse an untrusted string (a cookie, a header, a settings row) into a locale. */
export function parseLocale(value: unknown): LocaleCode {
  if (isLocaleCode(value)) return value;
  throw new I18nError(
    `Unsupported locale ${JSON.stringify(value)}. The superset is fixed by D-13: ${LOCALE_CODES.join(', ')}.`,
  );
}

/** Never throws — for request paths where an unknown `Accept-Language` must degrade, not fail. */
export function parseLocaleOrDefault(value: unknown): LocaleCode {
  return isLocaleCode(value) ? value : DEFAULT_LOCALE;
}

export function localeDirection(locale: LocaleCode): TextDirection {
  return LOCALES[locale].direction;
}

export function isRtl(locale: LocaleCode): boolean {
  return LOCALES[locale].direction === 'rtl';
}

/**
 * Best match for an `Accept-Language` header. Deliberately simple: exact tag,
 * then primary subtag, then `en-IN`. Quality values are honoured in order of
 * appearance rather than by weight, which is enough for a language picker.
 */
export function matchAcceptLanguage(header: string, enabled: readonly LocaleCode[]): LocaleCode {
  const enabledSet = new Set<LocaleCode>(enabled.length > 0 ? enabled : LOCALE_CODES);
  const tags = header
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith('q='))
        ?.slice(2);
      const weight = q === undefined ? 1 : Number.parseFloat(q);
      return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0 };
    })
    .filter((entry) => entry.tag.length > 0 && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight);

  for (const { tag } of tags) {
    if (isLocaleCode(tag) && enabledSet.has(tag)) return tag;
    const primary = tag.split('-')[0];
    if (primary !== undefined && isLocaleCode(primary) && enabledSet.has(primary)) return primary;
    if (primary === 'en' && enabledSet.has(DEFAULT_LOCALE)) return DEFAULT_LOCALE;
  }
  return DEFAULT_LOCALE;
}
