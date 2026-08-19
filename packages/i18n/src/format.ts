/**
 * Locale-aware formatting for numbers, money, dates and times.
 *
 * `docs/06 §8` is prescriptive here and the rules are safety rules, not taste:
 *
 *  - Indian grouping `##,##,###.##` for `en-IN` and every Indian language;
 *    Western grouping for `ar` (Gulf deployments).
 *  - lakh/crore abbreviations (`₹1.24 Cr`) are **dashboard-only** — printed and
 *    exported documents always carry the exact value.
 *  - dates `dd-MM-yyyy` on screen, `dd-MMM-yyyy` on documents; times `HH:mm`,
 *    24-hour, in the hospital's time zone.
 *  - Latin digits everywhere. A dose or a token rendered in Devanagari numerals
 *    is a patient-safety hazard, so grouping is implemented here rather than
 *    delegated to whatever numbering system ICU picks for a locale.
 */

import { getLocaleMeta, I18nError, type DigitGrouping, type LocaleCode } from './locales.js';

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = Object.freeze({
  INR: '₹',
  AED: 'د.إ',
  QAR: 'ر.ق',
  SAR: 'ر.س',
  USD: '$',
  EUR: '€',
  GBP: '£',
  KES: 'KSh',
});

export function currencySymbol(code: string): string {
  return CURRENCY_SYMBOLS[code] ?? code;
}

/** `12345678` → `1,23,45,678`. The last three digits, then pairs. */
export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const pairs: string[] = [];
  let cursor = rest;
  while (cursor.length > 2) {
    pairs.unshift(cursor.slice(-2));
    cursor = cursor.slice(0, -2);
  }
  if (cursor.length > 0) pairs.unshift(cursor);
  return `${pairs.join(',')},${last3}`;
}

/** `12345678` → `12,345,678`. */
export function groupWestern(digits: string): string {
  if (digits.length <= 3) return digits;
  const groups: string[] = [];
  let cursor = digits;
  while (cursor.length > 3) {
    groups.unshift(cursor.slice(-3));
    cursor = cursor.slice(0, -3);
  }
  if (cursor.length > 0) groups.unshift(cursor);
  return groups.join(',');
}

export function groupDigits(digits: string, grouping: DigitGrouping): string {
  return grouping === 'indian' ? groupIndian(digits) : groupWestern(digits);
}

export interface NumberFormatOptions {
  /** Exact number of decimals. Money is always 2 (`docs/06 §8`). */
  readonly fractionDigits?: number;
  /** Override the locale's own grouping (a report may force Western totals). */
  readonly grouping?: DigitGrouping;
}

interface DecimalParts {
  readonly negative: boolean;
  readonly whole: string;
  readonly frac: string;
}

function splitDecimal(value: number | string, fractionDigits: number): DecimalParts {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new I18nError(`Cannot format a non-finite number (${String(value)})`);
    }
    text = value.toFixed(fractionDigits);
  } else {
    text = value;
  }
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new I18nError(`Cannot format ${JSON.stringify(text)} as a number`);
  }
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [wholeRaw = '0', fracRaw = ''] = unsigned.split('.');
  const frac =
    fractionDigits === 0
      ? ''
      : fracRaw.length >= fractionDigits
        ? fracRaw.slice(0, fractionDigits)
        : fracRaw.padEnd(fractionDigits, '0');
  return { negative, whole: wholeRaw, frac };
}

/**
 * Format a number for display. Accepts a decimal *string* as well as a number so
 * that a Postgres `numeric` can be rendered without ever passing through a
 * float.
 */
export function formatNumber(
  value: number | string,
  locale: LocaleCode,
  options?: NumberFormatOptions,
): string {
  const meta = getLocaleMeta(locale);
  const fractionDigits = options?.fractionDigits ?? 0;
  const grouping = options?.grouping ?? meta.numberGrouping;
  const { negative, whole, frac } = splitDecimal(value, fractionDigits);
  const grouped = groupDigits(whole, grouping);
  return `${negative ? '-' : ''}${grouped}${frac.length > 0 ? `.${frac}` : ''}`;
}

export interface CurrencyFormatOptions {
  readonly currency?: string;
  readonly withSymbol?: boolean;
}

/** Always two decimals, always grouped, symbol from tenant config. */
export function formatCurrency(
  value: number | string,
  locale: LocaleCode,
  options?: CurrencyFormatOptions,
): string {
  const meta = getLocaleMeta(locale);
  const currency = options?.currency ?? meta.defaultCurrency;
  const withSymbol = options?.withSymbol ?? true;
  const body = formatNumber(value, locale, { fractionDigits: 2 });
  if (!withSymbol) return body;
  return body.startsWith('-')
    ? `-${currencySymbol(currency)}${body.slice(1)}`
    : `${currencySymbol(currency)}${body}`;
}

/**
 * `₹1.24 Cr` / `₹8.50 L`. **Dashboards only** — `docs/06 §8` requires the exact
 * value in the tooltip and in every printed or exported document, so the name
 * carries the restriction and there is no short alias for it.
 */
export function formatAbbreviatedForDashboardOnly(
  value: number,
  locale: LocaleCode,
  options?: CurrencyFormatOptions,
): string {
  const meta = getLocaleMeta(locale);
  if (meta.numberGrouping !== 'indian') {
    return formatCurrency(value, locale, options);
  }
  const currency = options?.currency ?? meta.defaultCurrency;
  const symbol = (options?.withSymbol ?? true) ? currencySymbol(currency) : '';
  const magnitude = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (magnitude >= 10_000_000) return `${sign}${symbol}${(magnitude / 10_000_000).toFixed(2)} Cr`;
  if (magnitude >= 100_000) return `${sign}${symbol}${(magnitude / 100_000).toFixed(2)} L`;
  if (magnitude >= 1_000) return `${sign}${symbol}${(magnitude / 1_000).toFixed(1)} K`;
  return formatCurrency(value, locale, options);
}

// ── dates & times ────────────────────────────────────────────────────────────

/**
 * Document month abbreviations stay Latin/English on purpose: `docs/06 §8` keeps
 * accession numbers, bill numbers and document identifiers untranslated, and a
 * `dd-MMM-yyyy` on a GST invoice or a lab report is part of that identifier.
 */
const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

export interface ZonedParts {
  readonly year: string;
  readonly month: string;
  readonly day: string;
  readonly hour: string;
  readonly minute: string;
}

/**
 * Split an instant into calendar parts in a given IANA time zone.
 * `en-GB` is used as the formatting locale purely because it guarantees
 * Latin digits and a stable `dd/MM/yyyy` part order.
 */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  if (Number.isNaN(instant.getTime())) {
    throw new I18nError('Cannot format an invalid Date');
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
  };
}

/** `dd-MM-yyyy` — the on-screen date format for every locale. */
export function formatDate(instant: Date, timeZone: string): string {
  const { day, month, year } = zonedParts(instant, timeZone);
  return `${day}-${month}-${year}`;
}

/** `dd-MMM-yyyy` — the document date format (bills, reports, discharge summaries). */
export function formatDateLong(instant: Date, timeZone: string): string {
  const { day, month, year } = zonedParts(instant, timeZone);
  const index = Number.parseInt(month, 10) - 1;
  const name = MONTHS_SHORT[index];
  if (name === undefined) {
    throw new I18nError(`Unexpected month "${month}" for time zone "${timeZone}"`);
  }
  return `${day}-${name}-${year}`;
}

/** `HH:mm`, 24-hour — mandatory in clinical contexts (`docs/06 §8`). */
export function formatTime(instant: Date, timeZone: string): string {
  const { hour, minute } = zonedParts(instant, timeZone);
  return `${hour}:${minute}`;
}

/** `dd-MM-yyyy HH:mm` — worklists, audit rows, timelines. */
export function formatDateTime(instant: Date, timeZone: string): string {
  return `${formatDate(instant, timeZone)} ${formatTime(instant, timeZone)}`;
}
