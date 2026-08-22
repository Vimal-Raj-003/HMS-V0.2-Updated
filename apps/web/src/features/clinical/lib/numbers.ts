/**
 * Decimals arrive from the API as strings, never as JSON numbers.
 *
 * `pg` returns `numeric` as text so that a temperature of 36.6 or a weight of
 * 12.4 kg is not rounded through IEEE-754 on the way to a chart axis or a
 * per-kilogram dose. This is the one place they are parsed, so "the value the
 * screen shows" and "the value the arithmetic used" cannot diverge.
 *
 * A value that does not parse comes back as `null` rather than `NaN`. `NaN`
 * spreads silently through comparisons — `NaN > high` is `false`, which would
 * flag an unparseable critical value as normal.
 */
export function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A measurement rendered for a clinician, with its unit.
 *
 * Trailing zeros are kept where the source had them: 36.60 °C and 36.6 °C are
 * the same temperature, but a screen that silently reformats one as the other
 * is a screen a nurse stops trusting to show exactly what was recorded.
 */
export function formatMeasure(value: string | number | null | undefined, unit: string): string {
  const parsed = toNumber(value);
  if (parsed === null) return '—';
  return `${typeof value === 'string' ? value : String(parsed)} ${unit}`.trim();
}

/** `dd-MM-yyyy HH:mm` in the browser's zone — `docs/06` §8 for clinical records. */
export function formatInstant(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(at.getDate())}-${pad(at.getMonth() + 1)}-${String(at.getFullYear())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** `dd-MM-yyyy`, for a date with no meaningful time of day. */
export function formatDay(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(at.getDate())}-${pad(at.getMonth() + 1)}-${String(at.getFullYear())}`;
}
