import { describe, expect, it } from 'vitest';
import type { AppointmentListItem, ScheduleExceptionRow, SlotView } from '../api/types';
import {
  REASON_NOT_VISIBLE,
  availabilityOf,
  buildBookGrid,
  exceptionCovers,
  maskLeadName,
  reasonForBlockedSlot,
} from './appointment-book';

function slot(overrides: Partial<SlotView> = {}): SlotView {
  return {
    id: 'slot-1',
    slot_date: '2026-08-24',
    slot_start: '2026-08-24T03:30:00.000Z', // 09:00 IST
    slot_end: '2026-08-24T03:45:00.000Z',
    capacity: 3,
    overbook_allowance: 2,
    booked_count: 0,
    online_quota: 3,
    online_booked_count: 0,
    walkin_reserve: 0,
    status: 'open',
    tele_enabled: false,
    room_key: null,
    speciality_key: null,
    consult_type_keys: null,
    available: 3,
    available_with_overbook: 5,
    ...overrides,
  };
}

function appointment(overrides: Partial<AppointmentListItem> = {}): AppointmentListItem {
  return {
    id: 'appt-1',
    appointment_no: 'AP-0001',
    patient_id: 'patient-1',
    lead_name: null,
    practitioner_key: 'doc-1',
    speciality_key: null,
    consult_type_key: null,
    slot_id: 'slot-1',
    slot_start: '2026-08-24T03:30:00.000Z',
    slot_end: '2026-08-24T03:45:00.000Z',
    slot_date: '2026-08-24',
    channel: 'counter',
    status: 'booked',
    is_tele: false,
    is_overbooked: false,
    visit_id: null,
    checked_in_at: null,
    confirmed_at: null,
    cancelled_at: null,
    ...overrides,
  };
}

describe('slot availability', () => {
  it('always carries the capacity a clerk is about to exceed', () => {
    const open = availabilityOf(slot({ booked_count: 1 }), undefined);
    expect(open).toEqual({ kind: 'open', booked: 1, capacity: 3 });
  });

  /**
   * "Past capacity but inside the doctor's allowance" and "no room at all" are
   * different decisions — one needs `appointment.overbook` and an approver, the
   * other needs a different slot — so they are different states, not one grey box.
   */
  it('separates over-capacity-but-allowed from genuinely full', () => {
    expect(availabilityOf(slot({ booked_count: 3 }), undefined)).toEqual({
      kind: 'overbooked',
      booked: 3,
      capacity: 3,
      overbookLimit: 5,
    });
    expect(availabilityOf(slot({ booked_count: 5 }), undefined)).toEqual({
      kind: 'full',
      booked: 5,
      capacity: 3,
    });
    expect(availabilityOf(slot({ booked_count: 3, overbook_allowance: 0 }), undefined)).toEqual({
      kind: 'full',
      booked: 3,
      capacity: 3,
    });
  });

  it('blocks regardless of how few people are booked into it', () => {
    const availability = availabilityOf(slot({ status: 'blocked', booked_count: 0 }), undefined);
    expect(availability.kind).toBe('blocked');
  });
});

describe('why a slot is blocked', () => {
  const exception = (overrides: Partial<ScheduleExceptionRow> = {}): ScheduleExceptionRow => ({
    id: 'ex-1',
    practitioner_key: 'doc-1',
    kind: 'blocked',
    starts_at: '2026-08-24T03:00:00.000Z',
    ends_at: '2026-08-24T05:00:00.000Z',
    is_full_day: false,
    reason: 'Theatre list',
    replacement_practitioner_key: null,
    affected_appointments: 0,
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  });

  it('is inclusive at the start and exclusive at the end', () => {
    expect(exceptionCovers(exception(), '2026-08-24T03:00:00.000Z')).toBe(true);
    expect(exceptionCovers(exception(), '2026-08-24T04:59:00.000Z')).toBe(true);
    // A 13:00 slot must not be swallowed by a block that ends at 13:00, or the
    // whole afternoon clinic disappears.
    expect(exceptionCovers(exception(), '2026-08-24T05:00:00.000Z')).toBe(false);
  });

  it('uses the real reason when the session may read the exceptions', () => {
    expect(reasonForBlockedSlot(slot({ status: 'blocked' }), [exception()])).toEqual({
      kind: 'blocked',
      reason: 'Theatre list',
    });
  });

  it('distinguishes leave from an administrative block', () => {
    expect(reasonForBlockedSlot(slot({ status: 'blocked' }), [exception({ kind: 'leave' })])).toEqual({
      kind: 'leave',
      reason: 'Theatre list',
    });
  });

  /**
   * A receptionist cannot read schedule exceptions, so the reason is not
   * available to them. A grey square they cannot explain to the patient in front
   * of them is a support call; this sentence at least tells them who to ask.
   */
  it('never leaves a blocked slot without something to say', () => {
    expect(reasonForBlockedSlot(slot({ status: 'blocked' }), undefined).reason).toBe(REASON_NOT_VISIBLE);
    expect(reasonForBlockedSlot(slot({ status: 'blocked' }), []).reason).toBe(REASON_NOT_VISIBLE);
  });
});

describe('the book grid', () => {
  it('places appointments in their slot and sorts the row keys', () => {
    const grid = buildBookGrid({
      days: ['2026-08-24'],
      slotsByDay: {
        '2026-08-24': [
          slot({ id: 'b', slot_start: '2026-08-24T04:30:00.000Z' }),
          slot({ id: 'a', slot_start: '2026-08-24T03:30:00.000Z' }),
        ],
      },
      appointmentsByDay: { '2026-08-24': [appointment({ slot_id: 'a' })] },
      timeZone: 'Asia/Kolkata',
    });

    expect(grid.times).toEqual(['09:00', '10:00']);
    const first = grid.slots.find((entry) => entry.slotId === 'a');
    expect(first?.appointments).toHaveLength(1);
    expect(first?.appointments?.[0]?.token).toBe('AP-0001');
  });

  it('drops cancelled and rescheduled appointments — they no longer hold the slot', () => {
    const grid = buildBookGrid({
      days: ['2026-08-24'],
      slotsByDay: { '2026-08-24': [slot()] },
      appointmentsByDay: {
        '2026-08-24': [
          appointment({ id: 'x', status: 'cancelled' }),
          appointment({ id: 'y', status: 'rescheduled' }),
          appointment({ id: 'z', status: 'confirmed' }),
        ],
      },
      timeZone: 'Asia/Kolkata',
    });
    expect(grid.slots[0]?.appointments).toHaveLength(1);
    expect(grid.slots[0]?.appointments?.[0]?.appointmentId).toBe('z');
  });

  /**
   * An appointment whose slot vanished — the grid was republished under it — is
   * surfaced rather than silently dropped. Somebody is still expecting to be
   * seen at that time.
   */
  it('reports an appointment whose slot is not on the grid instead of losing it', () => {
    const grid = buildBookGrid({
      days: ['2026-08-24'],
      slotsByDay: { '2026-08-24': [slot({ id: 'a' })] },
      appointmentsByDay: { '2026-08-24': [appointment({ slot_id: 'gone' })] },
      timeZone: 'Asia/Kolkata',
    });
    expect(grid.orphanAppointments).toHaveLength(1);
    expect(grid.slots[0]?.appointments).toBeUndefined();
  });

  it('renders a week as seven columns even when only one day is published', () => {
    const days = ['2026-08-24', '2026-08-25', '2026-08-26'];
    const grid = buildBookGrid({
      days,
      slotsByDay: { '2026-08-25': [slot()] },
      appointmentsByDay: {},
      timeZone: 'Asia/Kolkata',
    });
    expect(grid.days.map((day) => day.dayKey)).toEqual(days);
    expect(grid.days[0]?.label).toBe('Mon 24-08');
  });
});

describe('privacy on a shared desk', () => {
  it('masks a lead name to a given name and a surname initial', () => {
    expect(maskLeadName('Ramesh Subramanian')).toBe('Ramesh S.');
    expect(maskLeadName('  Priya   Nair ')).toBe('Priya N.');
    expect(maskLeadName('Cher')).toBe('Cher');
    expect(maskLeadName('')).toBe('—');
  });
});
