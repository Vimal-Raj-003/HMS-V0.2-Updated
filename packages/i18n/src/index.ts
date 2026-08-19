/**
 * `@vims/i18n` — the locale registry, the message catalogues and the formatting
 * rules that `docs/06 §8` makes binding.
 *
 * The invariant every consumer can rely on: **`en-IN` is always present, always
 * complete, and is the fallback for every other locale.** Nothing in this
 * package can be configured to break that.
 */

export {
  DEFAULT_LOCALE,
  I18nError,
  LOCALES,
  LOCALE_CODES,
  getLocaleMeta,
  isLocaleCode,
  isRtl,
  localeDirection,
  matchAcceptLanguage,
  parseLocale,
  parseLocaleOrDefault,
  type DigitGrouping,
  type LocaleCode,
  type LocaleMeta,
  type LocaleScript,
  type TextDirection,
} from './locales.js';

export { getRawCatalogue, REFERENCE_CATALOGUE } from './catalogues.js';
export type {
  AnyMessageKey,
  MessageKey,
  MessageNamespace,
  MessageTree,
  ReferenceCatalogue,
} from './catalogues.js';

export {
  createTranslator,
  getMessages,
  hasOwnTranslation,
  interpolate,
  resolveMessage,
  translate,
  type MessageResolution,
  type MessageValues,
  type Translator,
} from './messages.js';

export {
  assertLocaleRemovable,
  enabledLocalesSchema,
  isLocaleEnabled,
  localeCodeSchema,
  pickLocale,
  resolveHospitalLocales,
  type HospitalLocaleConfig,
  type HospitalLocaleInput,
} from './enabled-locales.js';

export {
  currencySymbol,
  formatAbbreviatedForDashboardOnly,
  formatCurrency,
  formatDate,
  formatDateLong,
  formatDateTime,
  formatNumber,
  formatTime,
  groupDigits,
  groupIndian,
  groupWestern,
  zonedParts,
  type CurrencyFormatOptions,
  type NumberFormatOptions,
  type ZonedParts,
} from './format.js';

export {
  CRITICAL_KEYS,
  CRITICAL_KEY_PREFIXES,
  PARTIAL_LOCALE_ALLOWLIST,
  computeCoverage,
  flattenMessages,
  formatCoverageReport,
  isCriticalKey,
  type CoverageInput,
  type CoverageReport,
  type LocaleCoverage,
} from './coverage.js';

export { buildRequestConfig, htmlAttributes, type RequestConfig } from './next-intl.js';
