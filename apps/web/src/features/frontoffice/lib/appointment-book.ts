import type {
  AppointmentKind,
  AppointmentSlot,
  ScheduledAppointment,
  SlotAvailability,
  SlotDay,
} from '@vims/ui';
import type { AppointmentListItem, ScheduleExceptionRow, SlotView } from '../api/types';
import { dayColumnLabel, timeOf } from './time';

/**
 * Turning `GET /doctors/:id/slots` and `GET /appointments` into the grid
 * `AppointmentSlotPicker` draws.
 *
 * All of it is pure, because the interesting cases are all arithmetic and none
 * of them need a browser: a slot that is full but still inside the overbooking
 * allowance, a slot that is blocked, a week whose columns are not all the same
 * length, an appointment whose slot was deleted under it.
 *
 * The one rule this file enforces that the API does not is the picker's own:
 * **`blocked` and `leave` availability must carry a reason**. `SlotView` has no
 * reason column — the reason lives on the schedule exception that blocked it, and
 * reading exceptions needs `schedule.configure`, which a receptionist does not
 * hold. So the reason is taken from an exception when one is readable and matches,
 * and otherwise is an explicit sentence that tells the clerk what to say to the
 * patient standing in front of them. A grey square with no explanation is a
 * support call; "blocked — reason not visible to your role, ask the branch
 * administrator" is at least an answer.
 */

export const REASON_NOT_VISIBLE =
  'Blocked on the doctor’s schedule. The reason is recorded but is not visible to your role — ask the branch administrator.';

export interface BookGrid {
  readonly days: readonly SlotDay[];
  /** Ordered `HH:mm` row keys, ascending, deduplicated across every day in view. */
  readonly times: readonly string[];
  readonly slots: readonly AppointmentSlot[];
  /** Appointments whose slot is not in the grid — never silently dropped. */
  readonly orphanAppointments: readonly AppointmentListItem[];
}

export interface BookGridInput {
  readonly days: readonly string[];
  readonly slotsByDay: Readonly<Record<string, readonly SlotView[]>>;
  readonly appointmentsByDay: Readonly<Record<string, readonly AppointmentListItem[]>>;
  /** Readable only with `schedule.configure`; absent for a receptionist. */
  readonly exceptions?: readonly ScheduleExceptionRow[];
  readonly timeZone?: string;
}

/** Statuses that no longer occupy a slot, so they must not be drawn on the book. */
const INACTIVE_APPOINTMENT_STATUSES = new Set(['cancelled', 'rescheduled', 'no_show']);

/** Exception kinds that mean "the doctor is away" rather than "the diary is blocked". */
const LEAVE_KINDS = new Set(['leave', 'holiday', 'conference']);

/**
 * Whether an exception covers a slot.
 *
 * Inclusive at the start and exclusive at the end, which is how a 09:00–13:00
 * block should treat a 13:00 slot: not blocked. Anything else silently swallows
 * the first slot of the afternoon clinic.
 */
export function exceptionCovers(exception: ScheduleExceptionRow, slotStartIso: string): boolean {
  const start = new Date(exception.starts_at).getTime();
  const end = new Date(exception.ends_at).getTime();
  const at = new Date(slotStartIso).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || Number.isNaN(at)) return false;
  return at >= start && at < end;
}

export function reasonForBlockedSlot(
  slot: SlotView,
  exceptions: readonly ScheduleExceptionRow[] | undefined,
): { readonly kind: 'blocked' | 'leave'; readonly reason: string } {
  const match = (exceptions ?? []).find((exception) => exceptionCovers(exception, slot.slot_start));
  if (match === undefined) return { kind: 'blocked', reason: REASON_NOT_VISIBLE };
  return {
    kind: LEAVE_KINDS.has(match.kind) ? 'leave' : 'blocked',
    reason: match.reason,
  };
}

/**
 * A slot's availability, capacity always included.
 *
 * The ordering matters. `blocked` wins over any count, because a blocked slot
 * with two people already in it is still not bookable. Then `overbooked` — past
 * capacity but inside the doctor's allowance — is distinguished from `full`,
 * because they are different decisions: one needs `appointment.overbook` and an
 * approver, the other needs a different slot.
 */
export function availabilityOf(
  slot: SlotView,
  exceptions: readonly ScheduleExceptionRow[] | undefined,
): SlotAvailability {
  if (slot.status === 'blocked' || slot.status === 'cancelled') {
    const { kind, reason } = reasonForBlockedSlot(slot, exceptions);
    return kind === 'leave' ? { kind: 'leave', reason } : { kind: 'blocked', reason };
  }

  const booked = slot.booked_count;
  const capacity = slot.capacity;
  if (booked < capacity) return { kind: 'open', booked, capacity };

  const overbookLimit = capacity + slot.overbook_allowance;
  if (booked < overbookLimit) return { kind: 'overbooked', booked, capacity, overbookLimit };
  return { kind: 'full', booked, capacity };
}

/**
 * The label an appointment shows on a book that is visible across a busy desk.
 *
 * `docs/06` §1.2.8 makes masking the default on any shared surface. The
 * appointment list carries no patient name at all — only a `patient_id`, which
 * is a UUID and tells a human nothing — so the identifier shown is the
 * **appointment number**, which is the thing a clerk reads out over the phone
 * and which carries no PHI. An unregistered lead has a name in the row, and that
 * is masked to given name plus surname initial.
 */
export function maskLeadName(fullName: string): string {
  const parts = fullName
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const [first, ...rest] = parts;
  if (first === undefined) return '—';
  const last = rest.at(-1);
  if (last === undefined) return first;
  return `${first} ${last.charAt(0).toUpperCase()}.`;
}

export function appointmentLabel(appointment: AppointmentListItem): string {
  if (appointment.lead_name !== null && appointment.lead_name.length > 0) {
    return maskLeadName(appointment.lead_name);
  }
  return appointment.patient_id === null ? 'Unregistered' : 'Registered patient';
}

export function appointmentKind(appointment: AppointmentListItem): AppointmentKind {
  if (appointment.is_tele) return 'teleconsult';
  if (appointment.channel === 'counter' && appointment.status === 'checked_in') return 'walk-in';
  return 'appointment';
}

export function toScheduledAppointment(appointment: AppointmentListItem): ScheduledAppointment {
  return {
    appointmentId: appointment.id,
    maskedLabel: appointmentLabel(appointment),
    kind: appointmentKind(appointment),
    token: appointment.appointment_no,
  };
}

export function buildBookGrid(input: BookGridInput): BookGrid {
  const timeZone = input.timeZone;
  const asTime = (iso: string): string =>
    timeZone === undefined ? timeOf(new Date(iso)) : timeOf(new Date(iso), timeZone);

  const bySlotId = new Map<string, AppointmentListItem[]>();
  const orphanAppointments: AppointmentListItem[] = [];
  const knownSlotIds = new Set<string>();

  for (const day of input.days) {
    for (const slot of input.slotsByDay[day] ?? []) knownSlotIds.add(slot.id);
  }

  for (const day of input.days) {
    for (const appointment of input.appointmentsByDay[day] ?? []) {
      if (INACTIVE_APPOINTMENT_STATUSES.has(appointment.status)) continue;
      if (appointment.slot_id === null || !knownSlotIds.has(appointment.slot_id)) {
        orphanAppointments.push(appointment);
        continue;
      }
      const bucket = bySlotId.get(appointment.slot_id);
      if (bucket === undefined) bySlotId.set(appointment.slot_id, [appointment]);
      else bucket.push(appointment);
    }
  }

  const times = new Set<string>();
  const slots: AppointmentSlot[] = [];

  for (const day of input.days) {
    for (const slot of input.slotsByDay[day] ?? []) {
      const startTime = asTime(slot.slot_start);
      times.add(startTime);
      const booked = (bySlotId.get(slot.id) ?? []).map(toScheduledAppointment);
      slots.push({
        slotId: slot.id,
        dayKey: day,
        startTime,
        availability: availabilityOf(slot, input.exceptions),
        ...(booked.length === 0 ? {} : { appointments: booked }),
      });
    }
  }

  return {
    days: input.days.map((dayKey) => ({ dayKey, label: dayColumnLabel(dayKey) })),
    times: [...times].sort((a, b) => a.localeCompare(b)),
    slots,
    orphanAppointments,
  };
}

/** Human names for the statuses that appear on the book and in the detail panel. */
export const APPOINTMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  waitlisted: 'Waitlisted',
  booked: 'Booked',
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  in_progress: 'In consultation',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'Did not attend',
  rescheduled: 'Rescheduled',
};

export const CANCEL_REASON_LABELS: Readonly<Record<string, string>> = {
  patient_request: 'Patient asked to cancel',
  doctor_unavailable: 'Doctor unavailable',
  rescheduled: 'Being rescheduled',
  duplicate: 'Duplicate booking',
  no_payment: 'Advance not paid',
  clinical: 'Clinical reason',
  weather_or_force_majeure: 'Weather or force majeure',
  other: 'Other (explain below)',
};
