/**
 * The slot grid — the one piece of scheduling arithmetic with no database in it.
 *
 * It answers "which slots does this weekly template produce between these two
 * dates", and it deliberately answers in **branch-local wall-clock strings**
 * rather than instants. Converting `2026-10-25 09:00` in `Europe/London` to an
 * instant is a job for the IANA database, and PostgreSQL carries one that is
 * patched with the operating system; reimplementing the DST arithmetic in
 * JavaScript would give a second, staler answer. So this function produces
 * `{ localDate, localStart, localEnd }` and the caller hands them to
 * `(date + time) AT TIME ZONE tz`, which is exact on both sides of a clock
 * change.
 *
 * Keeping it pure is also what makes it testable: the interesting cases —
 * a session that does not divide evenly into slots, a buffer between slots, a
 * horizon that starts mid-week — are all reachable without a container.
 */

export interface TemplateSession {
  readonly templateId: string;
  /** ISO-8601 weekday, 1 = Monday … 7 = Sunday. */
  readonly weekday: number;
  /** `HH:MM` or `HH:MM:SS`, branch-local. */
  readonly startTime: string;
  readonly endTime: string;
  readonly slotMinutes: number;
  readonly bufferMinutes: number;
  readonly capacityPerSlot: number;
  readonly overbookAllowance: number;
  readonly onlineQuotaPct: number;
  readonly walkinReserve: number;
  readonly consultTypeKeys: readonly string[];
  readonly teleEnabled: boolean;
  readonly roomKey: string | null;
  readonly specialityKey: string | null;
}

export interface GeneratedSlot {
  readonly templateId: string;
  /** `YYYY-MM-DD`, branch-local — the value that goes into `slot_date`. */
  readonly localDate: string;
  /** `HH:MM:SS`, branch-local. */
  readonly localStart: string;
  readonly localEnd: string;
  readonly capacity: number;
  readonly overbookAllowance: number;
  /** Places reservable through the website/app, derived from `online_quota_pct`. */
  readonly onlineQuota: number;
  readonly walkinReserve: number;
  readonly consultTypeKeys: readonly string[];
  readonly teleEnabled: boolean;
  readonly roomKey: string | null;
  readonly specialityKey: string | null;
}

/** Minutes since midnight for `HH:MM[:SS]`. Throws on anything else. */
export function minutesOfDay(time: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(time);
  if (match === null) throw new Error(`Not an HH:MM time: ${time}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
}

function formatTime(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
}

/** `YYYY-MM-DD` for a UTC-midnight date, without any timezone conversion. */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** ISO-8601 weekday (1 = Monday … 7 = Sunday) of a UTC-midnight date. */
export function isoWeekday(date: Date): number {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * Expands weekly sessions across `[fromDate, toDate]` inclusive.
 *
 * Dates are handled as UTC-midnight `Date`s purely as a calendar — they are
 * never interpreted as instants, which is why nothing here can be shifted by the
 * server's timezone.
 *
 * A session that does not divide evenly is truncated rather than rounded up:
 * a 09:00–10:00 session at 25-minute slots yields 09:00 and 09:25 and stops,
 * because a slot that runs past the end of the clinic is a patient waiting for
 * a doctor who has gone home.
 */
export function expandSessions(
  sessions: readonly TemplateSession[],
  fromDate: string,
  toDate: string,
): GeneratedSlot[] {
  const start = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error(`Not a YYYY-MM-DD range: ${fromDate}..${toDate}`);
  }

  const byWeekday = new Map<number, TemplateSession[]>();
  for (const session of sessions) {
    const bucket = byWeekday.get(session.weekday);
    if (bucket === undefined) byWeekday.set(session.weekday, [session]);
    else bucket.push(session);
  }

  const slots: GeneratedSlot[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const daily = byWeekday.get(isoWeekday(cursor));
    if (daily === undefined) continue;
    const localDate = formatDate(cursor);

    for (const session of daily) {
      const open = minutesOfDay(session.startTime);
      const close = minutesOfDay(session.endTime);
      const step = session.slotMinutes + session.bufferMinutes;
      if (step <= 0 || close <= open) continue;

      for (let at = open; at + session.slotMinutes <= close; at += step) {
        slots.push({
          templateId: session.templateId,
          localDate,
          localStart: formatTime(at),
          localEnd: formatTime(at + session.slotMinutes),
          capacity: session.capacityPerSlot,
          overbookAllowance: session.overbookAllowance,
          // Floor, not round: an online quota that rounds *up* to the whole
          // capacity leaves nothing at the counter for the patient standing in
          // front of the receptionist.
          onlineQuota: Math.floor((session.capacityPerSlot * session.onlineQuotaPct) / 100),
          walkinReserve: session.walkinReserve,
          consultTypeKeys: session.consultTypeKeys,
          teleEnabled: session.teleEnabled,
          roomKey: session.roomKey,
          specialityKey: session.specialityKey,
        });
      }
    }
  }

  return slots;
}

/** `YYYY-MM-DD` `days` after `date`, on the calendar rather than the clock. */
export function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return formatDate(at);
}

/**
 * OP-001 §5 token priority weights: "emergency 100, appointment on time 50,
 * senior/disabled/pregnant +20, staff +10, walk-in 0; FIFO within weight."
 *
 * Returned as a rank and a class so the token row records *why* somebody was
 * moved up the queue — a priority with no stated reason is one a waiting patient
 * cannot be given an answer about.
 */
export interface PriorityInput {
  readonly fromAppointment: boolean;
  readonly emergency: boolean;
  readonly ageYears: number | null;
  readonly isDifferentlyAbled: boolean;
  readonly isPregnant: boolean;
  readonly isStaff: boolean;
  readonly isVip: boolean;
}

export type TokenClass =
  | 'regular'
  | 'appointment'
  | 'priority_emergency'
  | 'priority_senior'
  | 'priority_pregnant'
  | 'priority_disabled'
  | 'priority_staff'
  | 'priority_vip';

export interface PriorityDecision {
  readonly rank: number;
  readonly tokenClass: TokenClass;
  readonly reason: string;
}

/** Senior-citizen threshold in India (Maintenance and Welfare of Parents Act 2007). */
export const SENIOR_CITIZEN_AGE = 60;

export function priorityFor(input: PriorityInput): PriorityDecision {
  if (input.emergency) {
    return { rank: 100, tokenClass: 'priority_emergency', reason: 'Emergency' };
  }

  let rank = input.fromAppointment ? 50 : 0;
  let tokenClass: TokenClass = input.fromAppointment ? 'appointment' : 'regular';
  const reasons: string[] = [];

  if (input.isPregnant) {
    rank += 20;
    tokenClass = 'priority_pregnant';
    reasons.push('Pregnant');
  } else if (input.isDifferentlyAbled) {
    rank += 20;
    tokenClass = 'priority_disabled';
    reasons.push('Differently abled');
  } else if (input.ageYears !== null && input.ageYears >= SENIOR_CITIZEN_AGE) {
    rank += 20;
    tokenClass = 'priority_senior';
    reasons.push('Senior citizen');
  }

  if (input.isStaff) {
    rank += 10;
    if (reasons.length === 0) tokenClass = 'priority_staff';
    reasons.push('Staff');
  }
  if (input.isVip && reasons.length === 0 && !input.fromAppointment) {
    tokenClass = 'priority_vip';
    reasons.push('VIP');
  }

  if (input.fromAppointment) reasons.unshift('Appointment');

  return { rank, tokenClass, reason: reasons.length === 0 ? 'Walk-in' : reasons.join(' + ') };
}
