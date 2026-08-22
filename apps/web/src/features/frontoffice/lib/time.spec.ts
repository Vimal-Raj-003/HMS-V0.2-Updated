import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayColumnLabel,
  dayKeyOf,
  daysInView,
  formatDayKey,
  isoWeekdayOf,
  minutesBetween,
  timeOf,
  weekStart,
} from './time';

/**
 * The calendar is the hospital's, not the browser's.
 *
 * A book keyed off the browser's midnight puts a 23:45 appointment on the wrong
 * day for a clerk one time zone away, and a queue that resets at the browser's
 * midnight resets at the wrong moment for a night shift.
 */
describe('hospital-time calendar', () => {
  it('reads the calendar day in the hospital’s zone, not the machine’s', () => {
    // 23:45 UTC on the 23rd is already 05:15 on the 24th in Kolkata.
    const at = new Date('2026-08-23T23:45:00.000Z');
    expect(dayKeyOf(at, 'Asia/Kolkata')).toBe('2026-08-24');
    expect(dayKeyOf(at, 'UTC')).toBe('2026-08-23');
  });

  it('renders a 24-hour clock in hospital time', () => {
    expect(timeOf(new Date('2026-08-24T03:30:00.000Z'), 'Asia/Kolkata')).toBe('09:00');
    expect(timeOf(new Date('2026-08-24T13:30:00.000Z'), 'Asia/Kolkata')).toBe('19:00');
  });

  it('renders dates as dd-MM-yyyy', () => {
    expect(formatDayKey('2026-08-24')).toBe('24-08-2026');
    expect(dayColumnLabel('2026-08-24')).toBe('Mon 24-08');
  });

  it('treats a day string as a calendar, never as an instant', () => {
    expect(isoWeekdayOf('2026-08-24')).toBe(1);
    expect(isoWeekdayOf('2026-08-30')).toBe(7);
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('starts a week on Monday', () => {
    expect(weekStart('2026-08-27')).toBe('2026-08-24');
    expect(weekStart('2026-08-30')).toBe('2026-08-24');
    expect(daysInView('2026-08-27', 'week')).toHaveLength(7);
    expect(daysInView('2026-08-27', 'day')).toEqual(['2026-08-27']);
  });

  it('never reports a negative wait — that is a clock skew, not a fact', () => {
    const later = new Date('2026-08-24T05:00:00.000Z');
    const earlier = new Date('2026-08-24T04:30:00.000Z');
    expect(minutesBetween(earlier, later)).toBe(30);
    expect(minutesBetween(later, earlier)).toBe(0);
  });
});
