/**
 * Calendar arithmetic in the **hospital's** time zone, not the browser's.
 *
 * `docs/06` §8: times render `HH:mm` on a 24-hour clock in hospital time, dates
 * `dd-MM-yyyy`. The reason this file exists rather than a `new Date()` here and
 * there: an appointment book keyed off the browser's midnight puts a 23:45
 * appointment on the wrong day for a clerk one time zone away, and a queue that
 * resets at the browser's midnight resets at the wrong moment for a night shift.
 *
 * Every function takes the calendar day as a `YYYY-MM-DD` string, which is what
 * the API's `date` parameters are, so no instant is ever reinterpreted.
 */

/** Phase 0 has no per-hospital time-zone read on the client yet; the parameter exists so wiring it is one line. */
export const HOSPITAL_TIME_ZONE = 'Asia/Kolkata';

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** `YYYY-MM-DD` for an instant, in the hospital's zone. */
export function dayKeyOf(at: Date, timeZone = HOSPITAL_TIME_ZONE): string {
  // `en-CA` renders ISO order (`2026-08-22`) natively, which avoids reassembling
  // parts by hand and getting the padding wrong for single-digit months.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** `HH:mm` for an instant, in the hospital's zone, 24-hour. */
export function timeOf(at: Date, timeZone = HOSPITAL_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
}

/** `dd-MM-yyyy` (docs/06 §8) for a `YYYY-MM-DD` calendar day. */
export function formatDayKey(dayKey: string): string {
  const [year, month, day] = dayKey.split('-');
  if (year === undefined || month === undefined || day === undefined) return dayKey;
  return `${day}-${month}-${year}`;
}

/** `Mon 24-08` — the appointment book's column header. */
export function dayColumnLabel(dayKey: string): string {
  const [year, month, day] = dayKey.split('-');
  if (year === undefined || month === undefined || day === undefined) return dayKey;
  return `${DAY_NAMES[isoWeekdayOf(dayKey) - 1] ?? ''} ${day}-${month}`;
}

/**
 * ISO-8601 weekday (1 = Monday … 7 = Sunday) of a calendar day.
 *
 * The day string is read as a UTC midnight purely as a **calendar**, never as an
 * instant, so nothing here can be shifted by the machine's own zone — the same
 * rule `services/api`'s `slot-grid.ts` follows for the same reason.
 */
export function isoWeekdayOf(dayKey: string): number {
  const at = new Date(`${dayKey}T00:00:00Z`);
  const day = at.getUTCDay();
  return day === 0 ? 7 : day;
}

/** `dayKey` shifted by whole days, still as a calendar. */
export function addDays(dayKey: string, days: number): string {
  const at = new Date(`${dayKey}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** The Monday of `dayKey`'s ISO week. */
export function weekStart(dayKey: string): string {
  return addDays(dayKey, -(isoWeekdayOf(dayKey) - 1));
}

/** The days a view covers: one for `day`, Monday–Sunday for `week`. */
export function daysInView(anchor: string, view: 'day' | 'week'): readonly string[] {
  if (view === 'day') return [anchor];
  const monday = weekStart(anchor);
  return [0, 1, 2, 3, 4, 5, 6].map((offset) => addDays(monday, offset));
}

/** Whole minutes between two instants, floored at zero — a negative wait is a clock skew, not a fact. */
export function minutesBetween(from: Date, to: Date): number {
  const delta = Math.floor((to.getTime() - from.getTime()) / 60_000);
  return delta > 0 ? delta : 0;
}

/** Whole seconds between two instants, floored at zero. */
export function secondsBetween(from: Date, to: Date): number {
  const delta = Math.floor((to.getTime() - from.getTime()) / 1000);
  return delta > 0 ? delta : 0;
}

/** `dd-MM HH:mm` in hospital time — the compact stamp `docs/06` §1.2.10 uses. */
export function formatStamp(iso: string | null, timeZone = HOSPITAL_TIME_ZONE): string {
  if (iso === null) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return `${formatDayKey(dayKeyOf(at, timeZone)).slice(0, 5)} ${timeOf(at, timeZone)}`;
}
