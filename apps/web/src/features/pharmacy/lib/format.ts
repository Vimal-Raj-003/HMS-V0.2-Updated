/**
 * Formatting shared by the pharmacy and inventory screens.
 *
 * Two decisions here are not cosmetic.
 *
 * **Money is never parsed.** The API sends `numeric(14,2)` as a decimal string
 * and this module keeps it one: `formatMoney` groups the digits and prefixes the
 * symbol without ever going through IEEE-754. A pharmacy bill that is out by a
 * paisa per line is out by a great deal by the end of a shift, and the round trip
 * through a float is exactly where that happens.
 *
 * **Absolute times, always.** `docs/06` §10 forbids "2 hours ago" as a record's
 * only timestamp: a narcotic register and a GRN are legal documents, and a
 * relative time in one of them is not a fact anybody can testify to. Relative age
 * is an addition, never a replacement.
 *
 * `en-IN` is fixed rather than taken from the device, because a shared counter
 * tablet's locale is whatever the last engineer set it to.
 */

const ABSOLUTE = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const DATE_ONLY = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

export function formatInstant(iso: string | null): string {
  if (iso === null || iso === '') return '—';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '—';
  return ABSOLUTE.format(new Date(parsed));
}

export function formatDate(iso: string | null): string {
  if (iso === null || iso === '') return '—';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '—';
  return DATE_ONLY.format(new Date(parsed));
}

/**
 * A decimal string as money, without a float in the middle.
 *
 * The integer part is grouped with the Indian lakh/crore convention that `en-IN`
 * uses; the fractional part is passed through untouched, padded to two places.
 * A value that is not a decimal string is returned unchanged rather than
 * becoming `NaN` — a mangled number on a bill is worse than an unfamiliar one.
 */
export function formatMoney(amount: string | null, currency = '₹'): string {
  if (amount === null || amount.trim() === '') return '—';
  const match = /^(-?)(\d+)(?:\.(\d*))?$/u.exec(amount.trim());
  if (match === null) return amount;
  const sign = match[1] ?? '';
  const whole = match[2] ?? '0';
  const fraction = (match[3] ?? '').padEnd(2, '0').slice(0, 2);
  return `${sign}${currency}${groupIndian(whole)}.${fraction}`;
}

/** 1234567 → 12,34,567 — the last three digits, then pairs (`en-IN`). */
export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/gu, ',')},${last3}`;
}

/**
 * A quantity as sent: a decimal string with its trailing zeros trimmed.
 *
 * `10.0000` on a screen reads as a precision the pharmacist did not measure, and
 * `10` is the same number. Nothing is rounded — only zeros after the point are
 * dropped, so `10.2500` becomes `10.25` and `10.2501` stays whole.
 */
export function formatQty(qty: string | null): string {
  if (qty === null || qty.trim() === '') return '—';
  const trimmed = qty.trim();
  if (!/^-?\d+(\.\d+)?$/u.test(trimmed)) return trimmed;
  if (!trimmed.includes('.')) return trimmed;
  return trimmed.replace(/\.?0+$/u, '');
}

/**
 * A coded enum as a human phrase.
 *
 * `docs/06` §1.1 heuristic 2: never a database word in the UI. A status chip
 * reading `pending_approval` is a column name wearing a badge.
 */
export function humanise(code: string | null): string {
  if (code === null || code === '') return '—';
  const words = code.replace(/[_-]+/gu, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Days until an expiry date, or `null` when there is none.
 *
 * Compared on the calendar date rather than the instant: a batch expiring today
 * expires at the end of today everywhere in the country, and an instant
 * comparison would make it "expired" for a counter in a different offset.
 */
export function daysUntil(isoDate: string | null, now: Date): number | null {
  if (isoDate === null || isoDate === '') return null;
  const parsed = Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed)) return null;
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((parsed - today) / 86_400_000);
}

export type ExpiryBand = 'expired' | 'critical' | 'near' | 'watch' | 'ok' | 'unknown';

/**
 * OP-003 §8 "Stock explorer": red < 30 d, orange < 90 d, yellow < 180 d.
 *
 * `expired` is its own band and not the bottom of the red one, because an
 * expired batch is not "very near expiry" — it is stock that may not be
 * dispensed at all, and the screen says so in words as well as in colour
 * (`docs/06` §1.2 rule 3: colour is never the only signal).
 */
export function expiryBand(days: number | null): ExpiryBand {
  if (days === null) return 'unknown';
  if (days < 0) return 'expired';
  if (days < 30) return 'critical';
  if (days < 90) return 'near';
  if (days < 180) return 'watch';
  return 'ok';
}

export const EXPIRY_BAND_LABEL: Readonly<Record<ExpiryBand, string>> = {
  expired: 'Expired — cannot be dispensed',
  critical: 'Expires within 30 days',
  near: 'Expires within 90 days',
  watch: 'Expires within 180 days',
  ok: 'In date',
  unknown: 'No expiry recorded',
};

export const EXPIRY_BAND_TONE: Readonly<Record<ExpiryBand, string>> = {
  expired: 'text-danger-fg',
  critical: 'text-danger-fg',
  near: 'text-warning-fg',
  watch: 'text-warning-fg',
  ok: 'text-fg-muted',
  unknown: 'text-fg-subtle',
};
