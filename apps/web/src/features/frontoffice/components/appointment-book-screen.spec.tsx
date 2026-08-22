import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider, TooltipProvider } from '@vims/ui';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider, type WorkspaceSession } from '@/lib/session-context';
import type { AppointmentListItem, Page, SlotView } from '../api/types';
import { AppointmentBookScreen } from './appointment-book-screen';

/**
 * The appointment book as a front desk uses it.
 *
 * What is asserted is what a clerk with a patient in front of them depends on:
 * that every slot shows the capacity it is about to exceed, that a blocked slot
 * always says something they can repeat out loud, that an appointment can be
 * moved **without a mouse** (WCAG 2.2 SC 2.5.7), and that a cancellation cannot
 * happen until both "why" and "who cancelled" have been answered — because the
 * second one decides the refund.
 */

const listSlots = vi.hoisted(() => vi.fn());
const listAppointments = vi.hoisted(() => vi.fn());
const listScheduleExceptions = vi.hoisted(() => vi.fn());
const rescheduleAppointment = vi.hoisted(() => vi.fn());
const cancelAppointment = vi.hoisted(() => vi.fn());
const bookAppointment = vi.hoisted(() => vi.fn());
const confirmAppointment = vi.hoisted(() => vi.fn());
const checkInAppointment = vi.hoisted(() => vi.fn());
const searchPatients = vi.hoisted(() => vi.fn());

vi.mock('../api/client', () => ({
  listSlots,
  listAppointments,
  listScheduleExceptions,
  rescheduleAppointment,
  cancelAppointment,
  bookAppointment,
  confirmAppointment,
  checkInAppointment,
  searchPatients,
}));

const HOSPITAL = '0192f0e2-0000-7000-8000-000000000011';
const DOCTOR = '0192f0e2-0000-7000-8000-0000000000d1';

/** Fixed so the book always has "today" to draw, whatever day the suite runs. */
function todayKey(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function slot(overrides: Partial<SlotView> = {}): SlotView {
  const day = todayKey();
  return {
    id: 'slot-0900',
    slot_date: day,
    slot_start: `${day}T03:30:00.000Z`,
    slot_end: `${day}T03:45:00.000Z`,
    capacity: 3,
    overbook_allowance: 1,
    booked_count: 1,
    online_quota: 3,
    online_booked_count: 0,
    walkin_reserve: 0,
    status: 'open',
    tele_enabled: false,
    room_key: null,
    speciality_key: null,
    consult_type_keys: null,
    available: 2,
    available_with_overbook: 3,
    ...overrides,
  };
}

function appointment(overrides: Partial<AppointmentListItem> = {}): AppointmentListItem {
  const day = todayKey();
  return {
    id: 'appt-1',
    appointment_no: 'AP-0007',
    patient_id: 'patient-1',
    lead_name: null,
    practitioner_key: DOCTOR,
    speciality_key: null,
    consult_type_key: null,
    slot_id: 'slot-0900',
    slot_start: `${day}T03:30:00.000Z`,
    slot_end: `${day}T03:45:00.000Z`,
    slot_date: day,
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

function page(items: readonly AppointmentListItem[]): Page<AppointmentListItem> {
  return { items, nextCursor: null, hasMore: false };
}

const DESK = [
  'appointment.slot.read',
  'appointment.list',
  'appointment.create',
  'appointment.update',
  'appointment.cancel',
  'visit.create',
];

function session(permissions: readonly string[]): WorkspaceSession {
  return {
    userId: 'user-1',
    displayName: 'Anitha R',
    hospitalId: HOSPITAL,
    branchId: 'branch-1',
    roles: ['receptionist'],
    permissions,
  };
}

function Harness({
  permissions,
  children,
}: {
  readonly permissions: readonly string[];
  readonly children: ReactNode;
}): React.JSX.Element {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ToastProvider>
          <SessionProvider session={session(permissions)}>{children}</SessionProvider>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.localStorage.setItem(`vims.frontoffice.${HOSPITAL}.doctor`, DOCTOR);
  listSlots.mockResolvedValue({ items: [slot()] });
  listAppointments.mockResolvedValue(page([appointment()]));
  listScheduleExceptions.mockResolvedValue({ items: [] });
});

describe('the appointment book', () => {
  it('asks for a doctor before it asks the API for anything', async () => {
    window.localStorage.clear();
    render(
      <Harness permissions={DESK}>
        <AppointmentBookScreen />
      </Harness>,
    );
    expect(await screen.findByText(/No doctor chosen/u)).toBeInTheDocument();
    expect(listSlots).not.toHaveBeenCalled();
  });

  /** Capacity is never optional: the desk always sees the figure it is about to exceed. */
  it('shows the capacity on every slot', async () => {
    render(
      <Harness permissions={DESK}>
        <AppointmentBookScreen />
      </Harness>,
    );
    expect(await screen.findByText('1 of 3 booked')).toBeInTheDocument();
  });

  it('distinguishes over-capacity from full, with the policy ceiling on it', async () => {
    listSlots.mockResolvedValue({ items: [slot({ booked_count: 3, available: 0 })] });
    render(
      <Harness permissions={DESK}>
        <AppointmentBookScreen />
      </Harness>,
    );
    expect(await screen.findByText(/Over capacity — 3 of 4 allowed/u)).toBeInTheDocument();
  });

  /**
   * A grey square the clerk cannot explain to the patient in front of them is a
   * support call. The reason lives on the schedule exception, which a
   * receptionist may not read — so the fallback still says something useful.
   */
  it('never shows a blocked slot without a reason', async () => {
    listSlots.mockResolvedValue({ items: [slot({ status: 'blocked' })] });
    render(
      <Harness permissions={DESK}>
        <AppointmentBookScreen />
      </Harness>,
    );
    expect(await screen.findByText(/Blocked — .*ask the branch administrator/u)).toBeInTheDocument();
    expect(listScheduleExceptions).not.toHaveBeenCalled();
  });

  it('uses the real reason when the session may read the schedule', async () => {
    const day = todayKey();
    listSlots.mockResolvedValue({ items: [slot({ status: 'blocked' })] });
    listScheduleExceptions.mockResolvedValue({
      items: [
        {
          id: 'ex-1',
          practitioner_key: DOCTOR,
          kind: 'blocked',
          starts_at: `${day}T03:00:00.000Z`,
          ends_at: `${day}T05:00:00.000Z`,
          is_full_day: false,
          reason: 'Theatre list',
          replacement_practitioner_key: null,
          affected_appointments: 0,
          created_at: `${day}T00:00:00.000Z`,
        },
      ],
    });
    render(
      <Harness permissions={[...DESK, 'schedule.configure']}>
        <AppointmentBookScreen />
      </Harness>,
    );
    expect(await screen.findByText('Blocked — Theatre list')).toBeInTheDocument();
  });

  /**
   * WCAG 2.2 SC 2.5.7. Dragging is offered and is never the only way: the Move
   * button puts the grid into a keyboard target-picking mode, and both paths end
   * in the same reschedule call.
   */
  it('can move an appointment without a mouse drag', async () => {
    const day = todayKey();
    listSlots.mockResolvedValue({
      items: [slot(), slot({ id: 'slot-0930', slot_start: `${day}T04:00:00.000Z` })],
    });
    rescheduleAppointment.mockResolvedValue(appointment({ slot_id: 'slot-0930' }));

    render(
      <Harness permissions={DESK}>
        <AppointmentBookScreen />
      </Harness>,
    );

    // Every appointment carries a Move button beside the drag handle.
    const move = await screen.findByRole('button', { name: /^Move Registered patient$/u });
    fireEvent.click(move);

    // The grid is now in target-picking mode — announced in the live region and
    // shown in the banner — and every droppable slot offers itself as a target.
    expect(await screen.findAllByText(/Choose the slot to move this appointment to/u)).not.toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: 'Move to 09:30' }));

    await waitFor(() => {
      expect(rescheduleAppointment).toHaveBeenCalledWith('appt-1', 'slot-0930');
    });
  });

  it('will not cancel until both why and who cancelled have been answered', async () => {
    render(
      <Harness permissions={DESK}>
        <AppointmentBookScreen />
      </Harness>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /AP-0007/u }));
    fireEvent.click(await screen.findByTestId('appointment-cancel'));

    const dialog = await screen.findByTestId('cancel-appointment-dialog');
    expect(within(dialog).getByTestId('cancel-confirm')).toBeDisabled();
    // Who cancelled is asked separately from why, because it decides the refund.
    expect(within(dialog).getByText(/refunded in full/u)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByTestId('cancel-confirm'));
    expect(cancelAppointment).not.toHaveBeenCalled();
  });

  it('offers a specific empty state when the grid is not published', async () => {
    listSlots.mockResolvedValue({ items: [] });
    listAppointments.mockResolvedValue(page([]));
    render(
      <Harness permissions={DESK}>
        <AppointmentBookScreen />
      </Harness>,
    );
    expect(await screen.findByText(/No slots are published/u)).toBeInTheDocument();
    expect(screen.getByText(/schedule has been published/u)).toBeInTheDocument();
  });

  it('does not draw a Book control for a session that may only read the book', async () => {
    render(
      <Harness permissions={['appointment.list', 'appointment.slot.read']}>
        <AppointmentBookScreen />
      </Harness>,
    );
    await screen.findByText('1 of 3 booked');
    expect(screen.queryByRole('button', { name: 'Book' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Move/u })).not.toBeInTheDocument();
  });

  it('switches between the day and the week without losing the doctor', async () => {
    render(
      <Harness permissions={DESK}>
        <AppointmentBookScreen />
      </Harness>,
    );
    await screen.findByText('1 of 3 booked');
    expect(listSlots).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('view-week'));
    // Six new days: today's slots are already in the cache under the same key,
    // which is the point of keying them per day.
    await waitFor(() => {
      expect(listSlots).toHaveBeenCalledTimes(7);
    });
    expect(listSlots.mock.calls.every((call) => call[0] === DOCTOR)).toBe(true);
  });
});
