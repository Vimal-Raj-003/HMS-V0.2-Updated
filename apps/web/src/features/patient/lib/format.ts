import { formatClinicalTimestamp } from '@vims/ui';
import type { PatientSex } from '@vims/ui';
import type { PatientListItem } from '../api/types';

/**
 * `docs/06` §8: dates render `dd-MM-yyyy`, times `HH:mm` on a 24-hour clock, and
 * always in the **hospital's** time zone rather than the browser's. Phase 1 has
 * no per-hospital time-zone read on the client yet, so the default is the seeded
 * one; the parameter exists so wiring it later is a one-line change rather than a
 * hunt through every screen. Same constant, same reasoning, as
 * `features/admin/lib/format.ts`.
 */
export const HOSPITAL_TIME_ZONE = 'Asia/Kolkata';

export function formatTimestamp(iso: string | null, timeZone = HOSPITAL_TIME_ZONE): string {
  if (iso === null) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return formatClinicalTimestamp(at, { timeZone, withYear: true });
}

/** A bare date, without the time — a date of birth is not an instant. */
export function formatDate(iso: string | null, timeZone = HOSPITAL_TIME_ZONE): string {
  if (iso === null) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
    .format(at)
    .replace(/\//g, '-');
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-IN').format(value);
}

const SEXES: ReadonlySet<PatientSex> = new Set<PatientSex>(['male', 'female', 'other', 'unknown']);

/**
 * The API's `gender` is a Postgres enum rendered as text. Anything outside the
 * four arms is `unknown` rather than a crash or a blank: a banner that fails to
 * render because a new enum arm was seeded is worse than one that says "unknown".
 */
export function toSex(gender: string): PatientSex {
  return SEXES.has(gender as PatientSex) ? (gender as PatientSex) : 'unknown';
}

/**
 * The pre-formatted age string `PatientBanner` and `PatientSearchCombobox` expect
 * (`docs/06` §8): `45 y`, `8 m`, `12 d`.
 *
 * Neonates are counted in days and infants in months because "0 y" on a banner is
 * the paediatric dosing error waiting to happen. `dobIsEstimated` is surfaced with
 * a `~` so nobody reads an age-only registration as a known birthday.
 */
export function formatAge(
  input: {
    readonly dob: string | null;
    readonly dob_is_estimated?: boolean;
    readonly age_years?: number | null;
    readonly age_months?: number | null;
    readonly age_days?: number | null;
  },
  now: Date = new Date(),
): string {
  const prefix = input.dob_is_estimated === true ? '~' : '';

  if (input.dob !== null) {
    const born = new Date(input.dob);
    if (!Number.isNaN(born.getTime())) {
      const days = Math.floor((now.getTime() - born.getTime()) / 86_400_000);
      if (days < 0) return '—';
      if (days < 31) return `${prefix}${days} d`;
      const months = monthsBetween(born, now);
      if (months < 24) return `${prefix}${months} m`;
      return `${prefix}${Math.floor(months / 12)} y`;
    }
  }

  const years = input.age_years ?? null;
  if (years !== null && years > 0) return `${prefix}${years} y`;
  const months = input.age_months ?? null;
  if (months !== null && months > 0) return `${prefix}${months} m`;
  const days = input.age_days ?? null;
  if (days !== null && days >= 0) return `${prefix}${days} d`;
  return '—';
}

function monthsBetween(from: Date, to: Date): number {
  const months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  return to.getDate() < from.getDate() ? months - 1 : months;
}

/**
 * Splits the server's `full_name` into the family/given halves `PatientBanner`
 * emphasises separately.
 *
 * The API returns one generated column, and the desk's convention (OP-001 §5's
 * printed label, `docs/06` §4.2's "family name emphasised") is `FAMILY, Given`.
 * When the name has no comma — a single-name patient, which is common — the whole
 * string is the given name and the family half is empty, rather than guessing.
 */
export function splitName(fullName: string): { readonly familyName: string; readonly givenName: string } {
  const comma = fullName.indexOf(',');
  if (comma >= 0) {
    return {
      familyName: fullName.slice(0, comma).trim(),
      givenName: fullName.slice(comma + 1).trim(),
    };
  }
  const parts = fullName.trim().split(/\s+/);
  if (parts.length <= 1) return { familyName: '', givenName: fullName.trim() };
  const family = parts[parts.length - 1] ?? '';
  return { familyName: family, givenName: parts.slice(0, -1).join(' ') };
}

/**
 * The last four digits of a mobile, and nothing else.
 *
 * `PatientSearchResult` has no field that can hold a full phone number, by design
 * (`docs/06` §5.2 #42): a result list is visible from the other side of a counter.
 * This is the projection that keeps it that way.
 */
export function mobileLast4(mobile: string): string | undefined {
  const digits = mobile.replace(/\D/g, '');
  return digits.length < 4 ? undefined : digits.slice(-4);
}

/** A `snake_case` column or JSON key rendered as a sentence (`docs/06` §1.1 #2). */
export function humaniseFieldName(field: string): string {
  const words = field
    .replace(/[_.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  if (words.length === 0) return field;
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/** Renders an arbitrary history value; `null` stays `null` so the row can show an em dash. */
export function renderValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length === 0 ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const rendered = value.map((entry) => renderValue(entry) ?? '—');
    return rendered.length === 0 ? null : rendered.join(', ');
  }
  return JSON.stringify(value);
}

const BLOOD_GROUPS: Readonly<Record<string, string>> = {
  a_pos: 'A+',
  a_neg: 'A−',
  b_pos: 'B+',
  b_neg: 'B−',
  ab_pos: 'AB+',
  ab_neg: 'AB−',
  o_pos: 'O+',
  o_neg: 'O−',
  bombay: 'Bombay (hh)',
  unknown: 'Not known',
};

export function formatBloodGroup(code: string): string {
  return BLOOD_GROUPS[code] ?? code;
}

/**
 * The one-line summary a search result reads out to a screen reader.
 * `docs/06` §7: enough to disambiguate two people with the same name, and no more.
 */
export function describeSearchResult(row: PatientListItem, now?: Date): string {
  const age = formatAge({ ...row, age_years: row.age_years }, now);
  return `${row.full_name}, ${row.gender}, ${age}, UHID ${row.uhid}`;
}
