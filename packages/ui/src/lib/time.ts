/**
 * docs/06 §1.2.10: "Clinical timestamps show `dd-MM HH:mm` in hospital time zone with
 * relative age ('+18 m') for anything in an alert or task; never bare relative time on
 * a clinical record."
 *
 * The time zone is always passed in — a component never reads the browser's zone,
 * because the hospital's zone is the clinical truth (docs/06 §8).
 */

export interface ClinicalTimestampOptions {
  /** IANA zone of the hospital, e.g. `Asia/Kolkata`. */
  readonly timeZone: string;
  /** Include the year — used on documents (`dd-MM-yyyy`), omitted in dense UI. */
  readonly withYear?: boolean;
}

/** `18-08 14:07`, or `18-08-2026 14:07` with `withYear`. Never locale-dependent. */
export function formatClinicalTimestamp(at: Date, options: ClinicalTimestampOptions): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: options.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00';

  const date =
    options.withYear === true
      ? `${get('day')}-${get('month')}-${get('year')}`
      : `${get('day')}-${get('month')}`;
  return `${date} ${get('hour')}:${get('minute')}`;
}

/**
 * Signed age in whole minutes, for the `+18 m` suffix on alerts and tasks. Returns a
 * number so the caller can localise the unit through its i18n catalogue rather than
 * receiving an English string from a component (docs/06 §8).
 */
export function relativeMinutes(at: Date, now: Date): number {
  return Math.round((now.getTime() - at.getTime()) / 60_000);
}
