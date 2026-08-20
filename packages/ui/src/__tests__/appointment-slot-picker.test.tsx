import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  AppointmentSlotPicker,
  type AppointmentSlot,
  type AppointmentSlotPickerLabels,
  type SlotDay,
} from '../clinical/appointment-slot-picker.js';
import { findAccessibilityViolations } from './axe.js';

const labels: AppointmentSlotPickerLabels = {
  gridLabel: 'Appointment book — Dr A. Menon',
  timeColumn: 'Time',
  capacity: (booked, capacity) => `${String(booked)} of ${String(capacity)} booked`,
  overbooked: (booked, limit) => `Overbooked ${String(booked)} of ${String(limit)}`,
  full: 'Full',
  open: 'Open',
  blocked: (reason) => `Blocked — ${reason}`,
  leave: (reason) => `On leave — ${reason}`,
  book: 'Book',
  move: 'Move',
  moveHint: 'Choose the slot to move this appointment to, or press Escape to cancel.',
  moveCancel: 'Cancel move',
  moveTargetLabel: (slotTime) => `Move here (${slotTime})`,
  noSlot: 'No session',
  slotSummary: (slot) => `${slot.startTime} on ${slot.dayKey}, ${slot.availability.kind}`,
  appointmentSummary: (appointment) => `Appointment for ${appointment.maskedLabel}`,
};

const days: readonly SlotDay[] = [
  { dayKey: '2026-08-24', label: 'Mon 24-08' },
  { dayKey: '2026-08-25', label: 'Tue 25-08' },
];
const times = ['09:00', '09:15', '09:30'];

const slots: readonly AppointmentSlot[] = [
  {
    slotId: 's1',
    dayKey: '2026-08-24',
    startTime: '09:00',
    availability: { kind: 'open', booked: 2, capacity: 6 },
    appointments: [{ appointmentId: 'apt_1', maskedLabel: 'RS ·8471', kind: 'appointment' }],
  },
  {
    slotId: 's2',
    dayKey: '2026-08-24',
    startTime: '09:15',
    availability: { kind: 'overbooked', booked: 7, capacity: 6, overbookLimit: 8 },
  },
  {
    slotId: 's3',
    dayKey: '2026-08-24',
    startTime: '09:30',
    availability: { kind: 'full', booked: 6, capacity: 6 },
  },
  {
    slotId: 's4',
    dayKey: '2026-08-25',
    startTime: '09:00',
    availability: { kind: 'blocked', reason: 'OT list' },
  },
  {
    slotId: 's5',
    dayKey: '2026-08-25',
    startTime: '09:15',
    availability: { kind: 'leave', reason: 'Casual leave' },
  },
];

describe('AppointmentSlotPicker — phase-01 §1.4', () => {
  it('always shows the capacity a clerk is about to exceed', () => {
    render(<AppointmentSlotPicker days={days} times={times} slots={slots} labels={labels} />);
    expect(screen.getByText('2 of 6 booked')).toBeInTheDocument();
    expect(screen.getByText('Overbooked 7 of 8')).toBeInTheDocument();
    expect(screen.getByText('Full 6 of 6 booked')).toBeInTheDocument();
  });

  it('never renders an unexplained grey square', () => {
    render(<AppointmentSlotPicker days={days} times={times} slots={slots} labels={labels} />);
    expect(screen.getByText('Blocked — OT list')).toBeInTheDocument();
    expect(screen.getByText('On leave — Casual leave')).toBeInTheDocument();
  });

  it('tells the caller when a booking is an overbooking', () => {
    const onBook = vi.fn<(slot: AppointmentSlot, context: { overbooking: boolean }) => void>();
    const { container } = render(
      <AppointmentSlotPicker days={days} times={times} slots={slots} labels={labels} onBook={onBook} />,
    );
    fireEvent.click(container.querySelector('[data-book-slot="s1"]') as HTMLElement);
    expect(onBook.mock.calls[0]?.[1]).toEqual({ overbooking: false });
    fireEvent.click(container.querySelector('[data-book-slot="s2"]') as HTMLElement);
    expect(onBook.mock.calls[1]?.[1]).toEqual({ overbooking: true });
  });

  it('offers no booking control on a blocked, leave or full slot', () => {
    const { container } = render(
      <AppointmentSlotPicker
        days={days}
        times={times}
        slots={slots}
        labels={labels}
        onBook={() => undefined}
      />,
    );
    expect(container.querySelector('[data-book-slot="s3"]')).toBeNull();
    expect(container.querySelector('[data-book-slot="s4"]')).toBeNull();
    expect(container.querySelector('[data-book-slot="s5"]')).toBeNull();
  });

  it('moves across the grid with the arrow keys on one tab stop', () => {
    const { container } = render(
      <AppointmentSlotPicker days={days} times={times} slots={slots} labels={labels} />,
    );
    const grid = screen.getByRole('grid', { name: labels.gridLabel });
    const first = container.querySelector<HTMLElement>('[data-cell="0-0"]');
    expect(first).toHaveAttribute('tabindex', '0');
    first?.focus();
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(container.querySelector('[data-cell="0-1"]'));
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(container.querySelector('[data-cell="1-1"]'));
    fireEvent.keyDown(grid, { key: 'Home' });
    expect(document.activeElement).toBe(container.querySelector('[data-cell="1-0"]'));
  });

  it('reschedules by keyboard as well as by drag (WCAG 2.2 SC 2.5.7)', () => {
    const onReschedule = vi.fn<(appointmentId: string, targetSlotId: string) => void>();
    const { container } = render(
      <AppointmentSlotPicker
        days={days}
        times={times}
        slots={slots}
        labels={labels}
        onReschedule={onReschedule}
      />,
    );
    fireEvent.click(container.querySelector('[data-move-appointment="apt_1"]') as HTMLElement);
    expect(container.querySelector('[data-move-mode="active"]')).not.toBeNull();

    const target = container.querySelector<HTMLElement>('[data-slot-id="s2"]');
    target?.focus();
    fireEvent.keyDown(target as HTMLElement, { key: 'Enter' });
    expect(onReschedule).toHaveBeenCalledWith('apt_1', 's2');
    expect(container.querySelector('[data-move-mode="active"]')).toBeNull();
  });

  it('cancels a keyboard move with Escape', () => {
    const { container } = render(
      <AppointmentSlotPicker
        days={days}
        times={times}
        slots={slots}
        labels={labels}
        onReschedule={() => undefined}
      />,
    );
    fireEvent.click(container.querySelector('[data-move-appointment="apt_1"]') as HTMLElement);
    fireEvent.keyDown(screen.getByRole('grid', { name: labels.gridLabel }), { key: 'Escape' });
    expect(container.querySelector('[data-move-mode="active"]')).toBeNull();
  });

  it('reschedules on drop', () => {
    const onReschedule = vi.fn<(appointmentId: string, targetSlotId: string) => void>();
    const { container } = render(
      <AppointmentSlotPicker
        days={days}
        times={times}
        slots={slots}
        labels={labels}
        onReschedule={onReschedule}
      />,
    );
    const target = container.querySelector<HTMLElement>('[data-slot-id="s2"]');
    fireEvent.drop(target as HTMLElement, {
      dataTransfer: { getData: () => 'apt_1' },
    });
    expect(onReschedule).toHaveBeenCalledWith('apt_1', 's2');
  });

  it('marks a slot with no session rather than leaving a hole', () => {
    const { container } = render(
      <AppointmentSlotPicker days={days} times={times} slots={slots} labels={labels} />,
    );
    const empty = container.querySelector('[data-cell="2-1"]');
    expect(empty).toHaveAttribute('aria-label', 'No session');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <AppointmentSlotPicker
        days={days}
        times={times}
        slots={slots}
        labels={labels}
        onBook={() => undefined}
        onReschedule={() => undefined}
        onSelectAppointment={() => undefined}
      />,
    );
    await expect(findAccessibilityViolations(container)).resolves.toEqual([]);
  });
});
