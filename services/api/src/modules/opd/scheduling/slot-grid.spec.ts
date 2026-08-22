import { describe, expect, it } from 'vitest';
import {
  SENIOR_CITIZEN_AGE,
  addDays,
  expandSessions,
  isoWeekday,
  priorityFor,
  type TemplateSession,
} from './slot-grid.js';

/**
 * The grid arithmetic, without a database.
 *
 * These are the cases that produce a wrong clinic rather than an error: a
 * session that does not divide evenly, a buffer that must not be double-counted,
 * a horizon that starts mid-week, and the priority weights OP-001 §5 states
 * numerically.
 */

function session(overrides: Partial<TemplateSession> = {}): TemplateSession {
  return {
    templateId: '00000000-0000-0000-0000-000000000001',
    weekday: 1,
    startTime: '09:00',
    endTime: '10:00',
    slotMinutes: 15,
    bufferMinutes: 0,
    capacityPerSlot: 1,
    overbookAllowance: 0,
    onlineQuotaPct: 100,
    walkinReserve: 0,
    consultTypeKeys: [],
    teleEnabled: false,
    roomKey: null,
    specialityKey: null,
    ...overrides,
  };
}

describe('isoWeekday', () => {
  it('numbers Monday 1 and Sunday 7', () => {
    // 2026-08-24 is a Monday.
    expect(isoWeekday(new Date('2026-08-24T00:00:00Z'))).toBe(1);
    expect(isoWeekday(new Date('2026-08-30T00:00:00Z'))).toBe(7);
  });
});

describe('expandSessions', () => {
  it('produces one slot per interval and stops at the session end', () => {
    const slots = expandSessions([session()], '2026-08-24', '2026-08-24');
    expect(slots.map((s) => s.localStart)).toEqual(['09:00:00', '09:15:00', '09:30:00', '09:45:00']);
    expect(slots.map((s) => s.localEnd)).toEqual(['09:15:00', '09:30:00', '09:45:00', '10:00:00']);
  });

  /**
   * Truncation, not rounding. A 25-minute slot in a one-hour clinic gives two
   * appointments and stops; a third would run to 10:15 and the patient would
   * arrive to a doctor who has gone.
   */
  it('never creates a slot that runs past the end of the session', () => {
    const slots = expandSessions([session({ slotMinutes: 25 })], '2026-08-24', '2026-08-24');
    expect(slots.map((s) => s.localStart)).toEqual(['09:00:00', '09:25:00']);
  });

  it('steps by slot + buffer but keeps the slot itself the configured length', () => {
    const slots = expandSessions(
      [session({ slotMinutes: 20, bufferMinutes: 10 })],
      '2026-08-24',
      '2026-08-24',
    );
    expect(slots.map((s) => [s.localStart, s.localEnd])).toEqual([
      ['09:00:00', '09:20:00'],
      ['09:30:00', '09:50:00'],
    ]);
  });

  it('only emits on the session’s weekday, across a horizon that starts mid-week', () => {
    // Wednesday 2026-08-26 → Wednesday 2026-09-02, Monday sessions only.
    const slots = expandSessions([session()], '2026-08-26', '2026-09-02');
    expect([...new Set(slots.map((s) => s.localDate))]).toEqual(['2026-08-31']);
  });

  it('floors the online quota so the counter always keeps a place', () => {
    const slots = expandSessions(
      [session({ capacityPerSlot: 3, onlineQuotaPct: 50 })],
      '2026-08-24',
      '2026-08-24',
    );
    expect(slots[0]?.onlineQuota).toBe(1);
  });

  it('returns nothing when the clinic closes before it opens', () => {
    expect(
      expandSessions([session({ startTime: '17:00', endTime: '09:00' })], '2026-08-24', '2026-08-24'),
    ).toHaveLength(0);
  });
});

describe('addDays', () => {
  it('crosses a month boundary on the calendar', () => {
    expect(addDays('2026-08-30', 3)).toBe('2026-09-02');
  });
});

describe('priorityFor', () => {
  const base = {
    fromAppointment: false,
    emergency: false,
    ageYears: 30,
    isDifferentlyAbled: false,
    isPregnant: false,
    isStaff: false,
    isVip: false,
  };

  it('weights an emergency above everything else', () => {
    expect(priorityFor({ ...base, emergency: true, fromAppointment: true }).rank).toBe(100);
  });

  it('puts an appointment ahead of a walk-in', () => {
    expect(priorityFor({ ...base, fromAppointment: true }).rank).toBe(50);
    expect(priorityFor(base).rank).toBe(0);
  });

  it('adds twenty for a senior citizen, pregnancy or disability — once, not thrice', () => {
    expect(priorityFor({ ...base, ageYears: SENIOR_CITIZEN_AGE }).rank).toBe(20);
    expect(priorityFor({ ...base, isPregnant: true }).rank).toBe(20);
    expect(priorityFor({ ...base, isDifferentlyAbled: true }).rank).toBe(20);
    expect(priorityFor({ ...base, ageYears: 82, isPregnant: true, isDifferentlyAbled: true }).rank).toBe(20);
  });

  it('adds ten for staff on top of the other weights', () => {
    expect(priorityFor({ ...base, fromAppointment: true, isStaff: true, ageYears: 70 }).rank).toBe(80);
  });

  it('always records why somebody was moved up the queue', () => {
    expect(priorityFor({ ...base, fromAppointment: true, isPregnant: true }).reason).toBe(
      'Appointment + Pregnant',
    );
    expect(priorityFor(base).reason).toBe('Walk-in');
  });
});
