import { formatClinicalTimestamp } from '@vims/ui';

/**
 * `docs/06` §8: dates render `dd-MM-yyyy`, times `HH:mm` on a 24-hour clock, and
 * always in the **hospital's** time zone rather than the browser's. An
 * administrator in Dubai reviewing a Bangalore hospital's audit trail must read
 * the times the ward staff saw, or the trail cannot be reconciled with a paper
 * register.
 *
 * Phase 0 has no per-hospital time-zone read on the client yet, so the default
 * is the seeded one; the parameter exists so that wiring it up later is a
 * one-line change rather than a hunt through every screen.
 */
export const HOSPITAL_TIME_ZONE = 'Asia/Kolkata';

export function formatTimestamp(iso: string | null, timeZone = HOSPITAL_TIME_ZONE): string {
  if (iso === null) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return formatClinicalTimestamp(at, { timeZone, withYear: true });
}

/** `en-IN` grouping for counts (`1,23,456`), tabular numerals come from the token layer. */
export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-IN').format(value);
}

/**
 * A `snake_case` column or JSON key rendered as a sentence.
 *
 * `docs/06` §1.1 heuristic 2 forbids DB words in the UI. The audit log stores
 * arbitrary JSON documents whose keys come from whichever module wrote the row,
 * so there is no catalogue to look a label up in — humanising the key is the
 * honest best effort, and it is applied consistently rather than per screen.
 */
export function humaniseFieldName(field: string): string {
  const words = field
    .replace(/[_.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  if (words.length === 0) return field;
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/**
 * Renders an arbitrary audit value for display.
 *
 * `null` is returned as `null` — not as the string "null" — because the diff
 * viewer renders an absent value as an explicit em-dash-style empty marker, and
 * "null" on a screen reads as a value that was actually stored.
 */
export function renderAuditValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length === 0 ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const rendered = value.map((entry) => renderAuditValue(entry) ?? '—');
    return rendered.length === 0 ? null : rendered.join(', ');
  }
  return JSON.stringify(value);
}
