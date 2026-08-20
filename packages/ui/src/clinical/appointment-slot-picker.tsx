'use client';

import { Ban, CalendarOff, GripVertical, Move, TriangleAlert, UserPlus } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/button.js';

/**
 * `AppointmentSlotPicker` — the appointment book of docs/prompts/phase-01 §1.4 / §1.8
 * ("appointment book (day/week, drag to reschedule)").
 *
 * The availability of a slot is a discriminated union, and that is the whole safety
 * argument of this file:
 *
 *   - every bookable state (`open`, `full`, `overbooked`) carries **both** `booked` and
 *     `capacity`, so a slot whose capacity is unknown cannot be rendered — the front
 *     desk always sees the number it is about to exceed;
 *   - `overbooked` additionally carries the `overbookLimit` from the doctor's policy,
 *     so "over capacity" and "over the policy ceiling" are different, visible facts;
 *   - `blocked` and `leave` **require a reason**. A grey square that the clerk cannot
 *     explain to the patient in front of them is a support call, not a design.
 *
 * Dragging is offered, and is never the only way: WCAG 2.2 SC 2.5.7 requires a
 * single-pointer/keyboard alternative, so every appointment also has a **Move** button
 * that puts the grid into a keyboard "choose the target slot" mode. Both paths end in
 * the same `onReschedule` call.
 */

export type SlotAvailability =
  | { readonly kind: 'open'; readonly booked: number; readonly capacity: number }
  | { readonly kind: 'full'; readonly booked: number; readonly capacity: number }
  /** Past capacity but still inside the doctor's overbooking policy. */
  | {
      readonly kind: 'overbooked';
      readonly booked: number;
      readonly capacity: number;
      readonly overbookLimit: number;
    }
  /** Theatre list, admin block, meeting — reason is shown to the clerk verbatim. */
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'leave'; readonly reason: string };

export type AppointmentKind = 'appointment' | 'walk-in' | 'teleconsult' | 'follow-up';

export interface ScheduledAppointment {
  readonly appointmentId: string;
  /** Privacy default (docs/06 §1.2.8) — the book is visible across a busy front desk. */
  readonly maskedLabel: string;
  readonly kind: AppointmentKind;
  readonly token?: string;
}

export interface AppointmentSlot {
  readonly slotId: string;
  /** Column key, `yyyy-MM-dd`. */
  readonly dayKey: string;
  /** Row key, `HH:mm` in hospital time (docs/06 §8). */
  readonly startTime: string;
  readonly availability: SlotAvailability;
  readonly appointments?: readonly ScheduledAppointment[];
}

export interface SlotDay {
  readonly dayKey: string;
  /** Already-localised column header, e.g. `Mon 24-08`. */
  readonly label: string;
  readonly subLabel?: string;
}

export interface AppointmentSlotPickerLabels {
  readonly gridLabel: string;
  readonly timeColumn: string;
  readonly capacity: (booked: number, capacity: number) => string;
  readonly overbooked: (booked: number, limit: number) => string;
  readonly full: string;
  readonly open: string;
  readonly blocked: (reason: string) => string;
  readonly leave: (reason: string) => string;
  readonly book: string;
  readonly move: string;
  readonly moveHint: string;
  readonly moveCancel: string;
  readonly moveTargetLabel: (slotTime: string) => string;
  readonly noSlot: string;
  /** Whole-cell accessible sentence — state, capacity and reason together (§7). */
  readonly slotSummary: (slot: AppointmentSlot) => string;
  readonly appointmentSummary: (appointment: ScheduledAppointment) => string;
}

export interface AppointmentSlotPickerProps {
  readonly days: readonly SlotDay[];
  /** Ordered row keys (`09:00`, `09:15`, …). Explicit, so no time-string sorting. */
  readonly times: readonly string[];
  readonly slots: readonly AppointmentSlot[];
  readonly labels: AppointmentSlotPickerLabels;
  /** `overbooking` is `true` when the chosen slot is already at or past capacity. */
  readonly onBook?: (slot: AppointmentSlot, context: { readonly overbooking: boolean }) => void;
  readonly onReschedule?: (appointmentId: string, targetSlotId: string) => void;
  readonly onSelectAppointment?: (appointment: ScheduledAppointment) => void;
  readonly className?: string;
}

function isBookable(availability: SlotAvailability): boolean {
  return availability.kind === 'open' || availability.kind === 'overbooked';
}

function availabilityTone(availability: SlotAvailability): string {
  switch (availability.kind) {
    case 'open':
      return 'border-success-border bg-success-surface text-success-on-surface';
    case 'full':
      return 'border-default bg-layer-3 text-fg-muted';
    case 'overbooked':
      return 'border-warning-border bg-warning-surface text-warning-on-surface';
    case 'blocked':
      return 'border-violet-border bg-violet-surface text-violet-on-surface';
    case 'leave':
      return 'border-danger-border bg-danger-surface text-danger-on-surface';
  }
}

function availabilityText(
  availability: SlotAvailability,
  labels: AppointmentSlotPickerLabels,
): { readonly text: string; readonly icon: React.JSX.Element } {
  switch (availability.kind) {
    case 'open':
      return {
        text: labels.capacity(availability.booked, availability.capacity),
        icon: <UserPlus aria-hidden="true" className="size-3" />,
      };
    case 'full':
      return {
        text: `${labels.full} ${labels.capacity(availability.booked, availability.capacity)}`,
        icon: <Ban aria-hidden="true" className="size-3" />,
      };
    case 'overbooked':
      return {
        text: labels.overbooked(availability.booked, availability.overbookLimit),
        icon: <TriangleAlert aria-hidden="true" className="size-3" />,
      };
    case 'blocked':
      return {
        text: labels.blocked(availability.reason),
        icon: <Ban aria-hidden="true" className="size-3" />,
      };
    case 'leave':
      return {
        text: labels.leave(availability.reason),
        icon: <CalendarOff aria-hidden="true" className="size-3" />,
      };
  }
}

export function AppointmentSlotPicker({
  days,
  times,
  slots,
  labels,
  onBook,
  onReschedule,
  onSelectAppointment,
  className,
}: AppointmentSlotPickerProps): React.JSX.Element {
  const gridId = useId();
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [focusCell, setFocusCell] = useState<{ readonly row: number; readonly column: number }>({
    row: 0,
    column: 0,
  });
  /** Non-null while a keyboard "move" is in flight — the SC 2.5.7 drag alternative. */
  const [movingId, setMovingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const bySlotKey = new Map<string, AppointmentSlot>(
    slots.map((slot) => [`${slot.dayKey}|${slot.startTime}`, slot]),
  );

  useEffect(() => {
    const node = gridRef.current?.querySelector<HTMLElement>(
      `[data-cell="${String(focusCell.row)}-${String(focusCell.column)}"]`,
    );
    if (node !== null && node !== undefined && gridRef.current?.contains(document.activeElement) === true) {
      node.focus();
    }
  }, [focusCell]);

  const complete = (slot: AppointmentSlot): void => {
    if (movingId !== null) {
      onReschedule?.(movingId, slot.slotId);
      setMovingId(null);
      return;
    }
    if (!isBookable(slot.availability)) return;
    onBook?.(slot, { overbooking: slot.availability.kind === 'overbooked' });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const { row, column } = focusCell;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setFocusCell({ row: Math.min(row + 1, times.length - 1), column });
        break;
      case 'ArrowUp':
        event.preventDefault();
        setFocusCell({ row: Math.max(row - 1, 0), column });
        break;
      case 'ArrowRight':
        event.preventDefault();
        setFocusCell({ row, column: Math.min(column + 1, days.length - 1) });
        break;
      case 'ArrowLeft':
        event.preventDefault();
        setFocusCell({ row, column: Math.max(column - 1, 0) });
        break;
      case 'Home':
        event.preventDefault();
        setFocusCell({ row, column: 0 });
        break;
      case 'End':
        event.preventDefault();
        setFocusCell({ row, column: days.length - 1 });
        break;
      case 'Escape':
        if (movingId !== null) {
          event.preventDefault();
          setMovingId(null);
        }
        break;
      default:
        break;
    }
  };

  return (
    <section data-slot="appointment-slot-picker" className={cn('flex flex-col gap-2', className)}>
      {movingId === null ? null : (
        <p
          role="status"
          data-move-mode="active"
          className="flex items-center gap-2 rounded-md border border-accent-border bg-accent-surface px-3 py-2 text-md text-accent-on-surface"
        >
          <Move aria-hidden="true" className="size-4" />
          {labels.moveHint}
          <Button
            variant="ghost"
            size="sm"
            className="ms-auto"
            onClick={() => {
              setMovingId(null);
            }}
          >
            {labels.moveCancel}
          </Button>
        </p>
      )}

      <div
        ref={gridRef}
        role="grid"
        aria-label={labels.gridLabel}
        aria-colcount={days.length + 1}
        aria-rowcount={times.length + 1}
        onKeyDown={handleKeyDown}
        className="w-full overflow-x-auto"
      >
        <div role="row" className="flex border-b border-default">
          <span
            role="columnheader"
            className="w-20 shrink-0 px-2 py-1 text-2xs font-medium uppercase tracking-[0.08em] text-fg-muted"
          >
            {labels.timeColumn}
          </span>
          {days.map((day) => (
            <span
              key={day.dayKey}
              role="columnheader"
              className="min-w-40 flex-1 px-2 py-1 text-sm font-medium text-fg-default"
            >
              {day.label}
              {day.subLabel === undefined ? null : (
                <span className="ms-1 text-2xs text-fg-muted">{day.subLabel}</span>
              )}
            </span>
          ))}
        </div>

        {times.map((time, rowIndex) => (
          <div key={time} role="row" className="flex border-b border-default">
            <span
              role="rowheader"
              className="w-20 shrink-0 px-2 py-2 font-mono text-xs tabular-nums text-fg-muted"
            >
              {time}
            </span>
            {days.map((day, columnIndex) => {
              const slot = bySlotKey.get(`${day.dayKey}|${time}`);
              const isFocusCell = focusCell.row === rowIndex && focusCell.column === columnIndex;
              if (slot === undefined) {
                return (
                  <span
                    key={day.dayKey}
                    role="gridcell"
                    aria-label={labels.noSlot}
                    data-cell={`${String(rowIndex)}-${String(columnIndex)}`}
                    tabIndex={isFocusCell ? 0 : -1}
                    onFocus={() => {
                      setFocusCell({ row: rowIndex, column: columnIndex });
                    }}
                    className="min-w-40 flex-1 border-s border-default bg-sunken p-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  />
                );
              }
              const presentation = availabilityText(slot.availability, labels);
              const bookable = isBookable(slot.availability);
              const movable = movingId !== null;
              const droppable = movable || bookable;
              return (
                <div
                  key={day.dayKey}
                  role="gridcell"
                  aria-label={labels.slotSummary(slot)}
                  data-cell={`${String(rowIndex)}-${String(columnIndex)}`}
                  data-slot-id={slot.slotId}
                  data-availability={slot.availability.kind}
                  data-drop-target={dropTargetId === slot.slotId ? 'true' : undefined}
                  tabIndex={isFocusCell ? 0 : -1}
                  onFocus={() => {
                    setFocusCell({ row: rowIndex, column: columnIndex });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && droppable) {
                      event.preventDefault();
                      event.stopPropagation();
                      complete(slot);
                    }
                  }}
                  onDragOver={(event) => {
                    if (movingId === null && !droppable) return;
                    // Only a slot that can actually accept the booking advertises a drop.
                    event.preventDefault();
                    setDropTargetId(slot.slotId);
                  }}
                  onDragLeave={() => {
                    setDropTargetId((current) => (current === slot.slotId ? null : current));
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDropTargetId(null);
                    const appointmentId = event.dataTransfer.getData('text/plain');
                    if (appointmentId !== '') onReschedule?.(appointmentId, slot.slotId);
                  }}
                  className={cn(
                    'flex min-w-40 flex-1 flex-col gap-1 border-s border-default p-1',
                    // Colour is corroborating only: the state word and its icon are below.
                    availabilityTone(slot.availability),
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                    dropTargetId === slot.slotId ? 'ring-2 ring-accent-border' : '',
                  )}
                >
                  <span className="flex items-center gap-1 text-2xs font-medium">
                    {presentation.icon}
                    {presentation.text}
                  </span>

                  {(slot.appointments ?? []).map((appointment) => (
                    <span
                      key={appointment.appointmentId}
                      data-appointment-id={appointment.appointmentId}
                      draggable={onReschedule !== undefined}
                      onDragStart={(event) => {
                        event.dataTransfer.setData('text/plain', appointment.appointmentId);
                        event.dataTransfer.effectAllowed = 'move';
                      }}
                      className="flex min-h-11 items-center gap-1 rounded-sm border border-default bg-layer-1 px-1 text-2xs text-fg-default"
                    >
                      {onReschedule === undefined ? null : (
                        <GripVertical aria-hidden="true" className="size-3 text-fg-subtle" />
                      )}
                      <button
                        type="button"
                        aria-label={labels.appointmentSummary(appointment)}
                        className="min-w-0 flex-1 truncate text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                        onClick={() => {
                          onSelectAppointment?.(appointment);
                        }}
                      >
                        {appointment.token === undefined ? null : (
                          <span className="me-1 font-mono">{appointment.token}</span>
                        )}
                        {appointment.maskedLabel}
                      </button>
                      {onReschedule === undefined ? null : (
                        // SC 2.5.7 — the keyboard/single-pointer equivalent of the drag.
                        <button
                          type="button"
                          data-move-appointment={appointment.appointmentId}
                          aria-label={`${labels.move} ${appointment.maskedLabel}`}
                          aria-pressed={movingId === appointment.appointmentId}
                          className="rounded-sm p-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                          onClick={() => {
                            setMovingId((current) =>
                              current === appointment.appointmentId ? null : appointment.appointmentId,
                            );
                          }}
                        >
                          <Move aria-hidden="true" className="size-3" />
                        </button>
                      )}
                    </span>
                  ))}

                  {bookable && onBook !== undefined && movingId === null ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      data-book-slot={slot.slotId}
                      className="min-h-11"
                      onClick={() => {
                        complete(slot);
                      }}
                    >
                      {labels.book}
                    </Button>
                  ) : null}

                  {movingId !== null && droppable ? (
                    <Button
                      variant="primary"
                      size="sm"
                      data-move-target={slot.slotId}
                      className="min-h-11"
                      aria-label={labels.moveTargetLabel(slot.startTime)}
                      onClick={() => {
                        complete(slot);
                      }}
                    >
                      {labels.moveTargetLabel(slot.startTime)}
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <span id={`${gridId}-live`} aria-live="polite" className="sr-only">
        {movingId === null ? '' : labels.moveHint}
      </span>
    </section>
  );
}
