'use client';

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AppointmentSlotPicker,
  Badge,
  Button,
  EmptyState,
  SkeletonList,
  useToast,
  type AppointmentSlot,
  type AppointmentSlotPickerLabels,
  type ScheduledAppointment,
} from '@vims/ui';
import { useCallback, useMemo, useState } from 'react';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import {
  bookAppointment,
  cancelAppointment,
  checkInAppointment,
  confirmAppointment,
  listAppointments,
  listScheduleExceptions,
  listSlots,
  rescheduleAppointment,
} from '../api/client';
import { frontOfficeKeys } from '../api/keys';
import type {
  AppointmentCancelReason,
  AppointmentListItem,
  BookAppointmentRequest,
  CancelledByParty,
  ScheduleExceptionRow,
  SlotView,
} from '../api/types';
import { APPOINTMENT_STATUS_LABELS, buildBookGrid, appointmentLabel } from '../lib/appointment-book';
import { useRemembered } from '../lib/remembered';
import { useShortcuts, type Shortcut } from '../lib/shortcuts';
import { addDays, dayKeyOf, daysInView, formatDayKey, formatStamp } from '../lib/time';
import { BookAppointmentDialog, type BookTarget } from './book-appointment-dialog';
import { CancelAppointmentDialog } from './cancel-appointment-dialog';
import { ContextField, isIdentifier } from './context-field';
import { ShortcutBar } from './keyboard-sheet';

/**
 * The appointment book — OP-001 §8 "calendar (day/week) per doctor; drag-to-reschedule;
 * slot capacity meter", `docs/prompts/phase-01` §1.4 and §1.8.
 *
 * The grid itself is `AppointmentSlotPicker` from `@vims/ui`, unmodified, and
 * that is deliberate: it already implements the two things that are easy to get
 * wrong. Capacity is part of every bookable availability, so a slot whose numbers
 * are unknown *cannot be rendered* — the desk always sees the figure it is about
 * to exceed. And dragging is never the only way to move an appointment: every
 * one has a **Move** button that puts the grid into a keyboard target-picking
 * mode, which is what WCAG 2.2 SC 2.5.7 requires and what a clerk with one hand
 * on a phone actually uses.
 *
 * What this screen adds is the data: a day or a week of slots and appointments
 * for one doctor, fetched per day so a week that is half published still draws,
 * and the mutations, each with the friction its permission demands.
 */

const PICKER_LABELS: AppointmentSlotPickerLabels = {
  gridLabel: 'Appointment slots',
  timeColumn: 'Time',
  capacity: (booked, capacity) => `${String(booked)} of ${String(capacity)} booked`,
  overbooked: (booked, limit) => `Over capacity — ${String(booked)} of ${String(limit)} allowed`,
  full: 'Full',
  open: 'Open',
  blocked: (reason) => `Blocked — ${reason}`,
  leave: (reason) => `On leave — ${reason}`,
  book: 'Book',
  move: 'Move',
  moveHint: 'Choose the slot to move this appointment to, then press Enter. Escape cancels.',
  moveCancel: 'Cancel move',
  moveTargetLabel: (slotTime) => `Move to ${slotTime}`,
  noSlot:
    'No slot published at this time — the doctor’s grid does not cover it, or the day is leave or a holiday.',
  slotSummary: (slot) => summariseSlot(slot),
  appointmentSummary: (appointment) => summariseAppointment(appointment),
};

function summariseSlot(slot: AppointmentSlot): string {
  const availability = slot.availability;
  switch (availability.kind) {
    case 'open':
      return `${slot.startTime}, open, ${String(availability.booked)} of ${String(availability.capacity)} booked`;
    case 'full':
      return `${slot.startTime}, full, ${String(availability.booked)} of ${String(availability.capacity)} booked`;
    case 'overbooked':
      return `${slot.startTime}, over capacity, ${String(availability.booked)} booked against a ceiling of ${String(availability.overbookLimit)}`;
    case 'blocked':
      return `${slot.startTime}, blocked. ${availability.reason}`;
    case 'leave':
      return `${slot.startTime}, doctor on leave. ${availability.reason}`;
  }
}

function summariseAppointment(appointment: ScheduledAppointment): string {
  return `Appointment ${appointment.token ?? ''}, ${appointment.maskedLabel}, ${appointment.kind}`;
}

export function AppointmentBookScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = frontOfficeKeys(hospitalId);
  const queryClient = useQueryClient();
  const { publish } = useToast();

  const [doctorKey, setDoctorKey] = useRemembered(hospitalId, 'doctor');
  const [anchor, setAnchor] = useState(() => dayKeyOf(new Date()));
  const [view, setView] = useState<'day' | 'week'>('day');
  const [bookTarget, setBookTarget] = useState<BookTarget | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<AppointmentListItem | null>(null);

  const canBook = granted.has('appointment.create');
  const canUpdate = granted.has('appointment.update');
  const canCancel = granted.has('appointment.cancel');
  const canCheckIn = granted.has('visit.create');
  const canOverbook = granted.has('appointment.overbook');
  const canReadExceptions = granted.has('schedule.configure');

  const days = useMemo(() => daysInView(anchor, view), [anchor, view]);
  const ready = isIdentifier(doctorKey);

  const slotQueries = useQueries({
    queries: days.map((day) => ({
      queryKey: keys.slots(doctorKey, day),
      queryFn: () => listSlots(doctorKey, day),
      enabled: ready,
      staleTime: 15_000,
    })),
  });

  const appointmentQueries = useQueries({
    queries: days.map((day) => ({
      queryKey: keys.appointments(doctorKey, day),
      queryFn: () => listAppointments({ doctor: doctorKey, date: day }, undefined),
      enabled: ready,
      staleTime: 15_000,
    })),
  });

  // Readable only by whoever configures the grid. Without it a blocked slot still
  // carries a reason, but a generic one — see `reasonForBlockedSlot`.
  const exceptionsQuery = useQuery({
    queryKey: keys.exceptions(doctorKey),
    queryFn: ({ signal }) => listScheduleExceptions(doctorKey, { signal }),
    enabled: ready && canReadExceptions,
    staleTime: 300_000,
  });

  const loading =
    ready && (slotQueries.some((query) => query.isPending) || appointmentQueries.some((q) => q.isPending));
  const error =
    slotQueries.find((query) => query.error !== null)?.error ??
    appointmentQueries.find((query) => query.error !== null)?.error ??
    null;

  // Built on every render rather than memoised: `useQueries` returns a fresh
  // result array each time, so any dependency list would either be a lie or a
  // stringified timestamp join, and the grid is a few dozen cells.
  const slotsByDay: Record<string, readonly SlotView[]> = {};
  const appointmentsByDay: Record<string, readonly AppointmentListItem[]> = {};
  days.forEach((day, index) => {
    slotsByDay[day] = slotQueries[index]?.data?.items ?? [];
    appointmentsByDay[day] = appointmentQueries[index]?.data?.items ?? [];
  });
  const exceptions: readonly ScheduleExceptionRow[] | undefined = exceptionsQuery.data?.items;
  const grid = buildBookGrid({
    days,
    slotsByDay,
    appointmentsByDay,
    ...(exceptions === undefined ? {} : { exceptions }),
  });

  const allAppointments = appointmentQueries.flatMap((query) => query.data?.items ?? []);

  const selected = allAppointments.find((appointment) => appointment.id === selectedId) ?? null;

  const invalidate = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: keys.book() });
    void queryClient.invalidateQueries({ queryKey: keys.bookAppointments() });
  }, [queryClient, keys]);

  const book = useMutation({
    mutationFn: (body: BookAppointmentRequest) => bookAppointment(body),
    onSuccess: (appointment) => {
      invalidate();
      setBookTarget(null);
      publish({
        title: `Booked ${appointment.appointment_no}`,
        description: `${formatStamp(appointment.slot_start)} — the slot is held.`,
        severity: 'success',
      });
    },
  });

  const reschedule = useMutation({
    mutationFn: (input: { readonly id: string; readonly slotId: string }) =>
      rescheduleAppointment(input.id, input.slotId),
    onSuccess: (appointment) => {
      invalidate();
      publish({
        title: `Moved ${appointment.appointment_no}`,
        description: `Now at ${formatStamp(appointment.slot_start)}.`,
        severity: 'success',
      });
    },
  });

  const confirm = useMutation({
    mutationFn: (id: string) => confirmAppointment(id),
    onSuccess: (appointment) => {
      invalidate();
      publish({ title: `Confirmed ${appointment.appointment_no}`, severity: 'success' });
    },
  });

  const checkIn = useMutation({
    mutationFn: (id: string) => checkInAppointment(id, { payerType: 'self', sourceChannel: 'counter' }),
    onSuccess: (result) => {
      invalidate();
      publish({
        title: `Token ${result.tokenDisplay}`,
        description: `Visit ${result.visitNo} opened. Hand the slip to the patient.`,
        severity: 'success',
      });
    },
  });

  const cancel = useMutation({
    mutationFn: (input: {
      readonly id: string;
      readonly reason: AppointmentCancelReason;
      readonly cancelledBy: CancelledByParty;
      readonly note: string;
    }) =>
      cancelAppointment(
        input.id,
        {
          reason: input.reason,
          cancelledBy: input.cancelledBy,
          ...(input.note === '' ? {} : { note: input.note }),
        },
        // The policy engine refuses `appointment.cancel` outright without this
        // header, so the coded reason travels as the header too.
        input.note === '' ? input.reason : `${input.reason}: ${input.note}`,
      ),
    onSuccess: (appointment) => {
      invalidate();
      setCancelling(null);
      setSelectedId(null);
      publish({
        title: `Cancelled ${appointment.appointment_no}`,
        description: 'The slot is released and the patient has been notified.',
        severity: 'success',
      });
    },
  });

  const shortcuts: readonly Shortcut[] = useMemo(
    () => [
      {
        key: 'd',
        label: 'Day view',
        keys: ['D'],
        run: () => {
          setView('day');
        },
      },
      {
        key: 'w',
        label: 'Week view',
        keys: ['W'],
        run: () => {
          setView('week');
        },
      },
      {
        key: '[',
        label: 'Previous',
        keys: ['['],
        run: () => {
          setAnchor((current) => addDays(current, view === 'day' ? -1 : -7));
        },
      },
      {
        key: ']',
        label: 'Next',
        keys: [']'],
        run: () => {
          setAnchor((current) => addDays(current, view === 'day' ? 1 : 7));
        },
      },
      {
        key: 't',
        label: 'Today',
        keys: ['T'],
        run: () => {
          setAnchor(dayKeyOf(new Date()));
        },
      },
      {
        key: 'c',
        label: 'Cancel selected',
        keys: ['C'],
        enabled: canCancel,
        run: () => {
          if (selected !== null) setCancelling(selected);
        },
      },
      {
        key: 'k',
        label: 'Check in selected',
        keys: ['K'],
        enabled: canCheckIn,
        run: () => {
          if (selected !== null) checkIn.mutate(selected.id);
        },
      },
      { key: 'r', label: 'Refresh', keys: ['R'], run: invalidate },
    ],
    [view, selected, canCancel, canCheckIn, checkIn, invalidate],
  );

  useShortcuts(shortcuts);

  const rangeLabel =
    view === 'day'
      ? formatDayKey(anchor)
      : `${formatDayKey(days[0] ?? anchor)} – ${formatDayKey(days.at(-1) ?? anchor)}`;

  return (
    <section className="flex flex-col gap-4" data-testid="appointment-book">
      <PageHeader
        eyebrow="Front office"
        title="Appointment book"
        description="A doctor's day or week. Capacity is on every slot; a blocked slot always says why. Drag an appointment to move it, or use Move for the same thing from the keyboard."
        primaryAction={
          <Button
            variant="primary"
            onClick={() => {
              setAnchor(dayKeyOf(new Date()));
            }}
          >
            Today
          </Button>
        }
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              aria-label="Previous"
              onClick={() => {
                setAnchor((current) => addDays(current, view === 'day' ? -1 : -7));
              }}
            >
              ‹
            </Button>
            <Button
              variant="secondary"
              size="sm"
              aria-label="Next"
              onClick={() => {
                setAnchor((current) => addDays(current, view === 'day' ? 1 : 7));
              }}
            >
              ›
            </Button>
            <div role="group" aria-label="View" className="flex gap-1">
              <Button
                variant={view === 'day' ? 'primary' : 'secondary'}
                size="sm"
                aria-pressed={view === 'day'}
                data-testid="view-day"
                onClick={() => {
                  setView('day');
                }}
              >
                Day
              </Button>
              <Button
                variant={view === 'week' ? 'primary' : 'secondary'}
                size="sm"
                aria-pressed={view === 'week'}
                data-testid="view-week"
                onClick={() => {
                  setView('week');
                }}
              >
                Week
              </Button>
            </div>
          </div>
        }
        meta={<Badge tone="neutral">{rangeLabel}</Badge>}
      />

      <div className="flex flex-wrap items-end gap-4">
        <ContextField
          label="Doctor"
          testId="doctor-key"
          hint="The practitioner record key whose book this desk opens. Remembered on this device."
          value={doctorKey}
          onChange={setDoctorKey}
        />
      </div>

      {!ready ? (
        <EmptyState
          cause="No doctor chosen, so there is no book to draw."
          nextAction="Paste the practitioner record key above. This desk will remember it."
        />
      ) : error !== null ? (
        <ProblemCard error={error} onRetry={invalidate} />
      ) : loading ? (
        <SkeletonList label="Loading the appointment book" rows={8} columns={[2, 3, 3, 3]} />
      ) : grid.times.length === 0 ? (
        <EmptyState
          cause={`No slots are published for ${rangeLabel}.`}
          nextAction="Check the doctor's schedule has been published for this period, or move to another day."
          action={{
            label: 'Next day',
            onSelect: () => {
              setAnchor((current) => addDays(current, view === 'day' ? 1 : 7));
            },
          }}
        />
      ) : (
        <AppointmentSlotPicker
          days={grid.days}
          times={grid.times}
          slots={grid.slots}
          labels={PICKER_LABELS}
          {...(canBook
            ? {
                onBook: (slot: AppointmentSlot, context: { readonly overbooking: boolean }) => {
                  setBookTarget({ slot, overbooking: context.overbooking });
                },
              }
            : {})}
          {...(canUpdate
            ? {
                onReschedule: (appointmentId: string, targetSlotId: string) => {
                  reschedule.mutate({ id: appointmentId, slotId: targetSlotId });
                },
              }
            : {})}
          onSelectAppointment={(appointment) => {
            setSelectedId(appointment.appointmentId);
          }}
        />
      )}

      {grid.orphanAppointments.length > 0 ? (
        <p
          role="status"
          className="rounded-md border border-warning-border bg-warning-surface p-3 text-sm text-warning-on-surface"
        >
          {grid.orphanAppointments.length} appointment(s) in this period have no slot on the published grid —
          most likely the schedule was republished under them. They are listed in the detail panel of the
          appointment list, and they still need a time.
        </p>
      ) : null}

      {selected === null ? null : (
        <div data-testid="appointment-detail" className="rounded-lg border border-strong bg-layer-1 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-mono text-sm text-fg-default">{selected.appointment_no}</p>
              <p className="text-md font-medium text-fg-default">{appointmentLabel(selected)}</p>
              <p className="text-sm text-fg-muted">
                {formatStamp(selected.slot_start)} ·{' '}
                {APPOINTMENT_STATUS_LABELS[selected.status] ?? selected.status}
                {selected.is_overbooked ? ' · booked over capacity' : ''}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {canUpdate ? (
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="appointment-confirm"
                  disabled={confirm.isPending || selected.status !== 'booked'}
                  onClick={() => {
                    confirm.mutate(selected.id);
                  }}
                >
                  Confirm
                </Button>
              ) : null}
              {canCheckIn ? (
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="appointment-check-in"
                  disabled={checkIn.isPending}
                  onClick={() => {
                    checkIn.mutate(selected.id);
                  }}
                >
                  Check in
                </Button>
              ) : null}
              {canCancel ? (
                <Button
                  variant="danger"
                  size="sm"
                  data-testid="appointment-cancel"
                  onClick={() => {
                    setCancelling(selected);
                  }}
                >
                  Cancel
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSelectedId(null);
                }}
              >
                Close
              </Button>
            </div>
          </div>
          {confirm.error !== null ? <ProblemCard error={confirm.error} /> : null}
          {checkIn.error !== null ? <ProblemCard error={checkIn.error} /> : null}
          {reschedule.error !== null ? <ProblemCard error={reschedule.error} /> : null}
        </div>
      )}

      {reschedule.error !== null && selected === null ? <ProblemCard error={reschedule.error} /> : null}

      <BookAppointmentDialog
        target={bookTarget}
        canOverbook={canOverbook}
        pending={book.isPending}
        error={book.error}
        onClose={() => {
          setBookTarget(null);
          book.reset();
        }}
        onSubmit={(body) => {
          book.mutate(body);
        }}
      />

      <CancelAppointmentDialog
        appointment={cancelling}
        pending={cancel.isPending}
        error={cancel.error}
        onClose={() => {
          setCancelling(null);
          cancel.reset();
        }}
        onConfirm={(input) => {
          if (cancelling === null) return;
          cancel.mutate({ id: cancelling.id, ...input });
        }}
      />

      <ShortcutBar shortcuts={shortcuts} label="Appointment book shortcuts" />
    </section>
  );
}
