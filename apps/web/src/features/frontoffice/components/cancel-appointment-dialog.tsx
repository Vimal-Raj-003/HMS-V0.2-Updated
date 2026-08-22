'use client';

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  Button,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Label,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@vims/ui';
import { useEffect, useId, useState } from 'react';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { CANCEL_REASON_LABELS } from '../lib/appointment-book';
import type { AppointmentCancelReason, AppointmentListItem, CancelledByParty } from '../api/types';
import { APPOINTMENT_CANCEL_REASONS, CANCELLED_BY_PARTIES } from '../api/types';

/** Narrowing rather than casting: the select hands back a `string`, and a value that is
 *  not in the catalogue must not reach the API as if it were. */
function asCancelReason(value: string): AppointmentCancelReason | null {
  return (APPOINTMENT_CANCEL_REASONS as readonly string[]).includes(value)
    ? (value as AppointmentCancelReason)
    : null;
}

function asCancelledBy(value: string): CancelledByParty | null {
  return (CANCELLED_BY_PARTIES as readonly string[]).includes(value) ? (value as CancelledByParty) : null;
}

/**
 * Cancelling an appointment — `docs/06` §6.9 friction level 4, plus one field the
 * generic reason dialog has no room for.
 *
 * **Who cancelled is not the same question as why.** OP-001 §5's refund rule
 * turns on it: "100 % if cancelled ≥ 24 h, else 0, **always full if the hospital
 * cancels**". A reason code alone cannot answer that, which is why the API takes
 * `cancelledBy` as its own required field and why this dialog exists rather than
 * a call to `ConfirmWithReasonDialog`. Defaulting it would quietly decide a
 * refund on the patient's behalf, so it starts unset and confirm stays disabled
 * until somebody says.
 *
 * Built on the hard-stop `AlertDialog`: no ESC, no click-outside, no close X.
 */
export function CancelAppointmentDialog({
  appointment,
  onClose,
  onConfirm,
  pending,
  error,
}: {
  readonly appointment: AppointmentListItem | null;
  readonly onClose: () => void;
  readonly onConfirm: (input: {
    readonly reason: AppointmentCancelReason;
    readonly cancelledBy: CancelledByParty;
    readonly note: string;
  }) => void;
  readonly pending: boolean;
  readonly error: unknown;
}): React.JSX.Element | null {
  const fieldId = useId();
  const [reason, setReason] = useState<string>('');
  const [cancelledBy, setCancelledBy] = useState<string>('');
  const [note, setNote] = useState('');

  const open = appointment !== null;

  useEffect(() => {
    if (open) return;
    setReason('');
    setCancelledBy('');
    setNote('');
  }, [open]);

  if (appointment === null) return null;

  const reasonCode = asCancelReason(reason);
  const party = asCancelledBy(cancelledBy);
  const noteRequired = reasonCode === 'other';
  const canConfirm =
    reasonCode !== null && party !== null && (!noteRequired || note.trim().length > 0) && !pending;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <AlertDialogContent data-testid="cancel-appointment-dialog">
        <DialogHeader>
          <AlertDialogTitle>Cancel appointment {appointment.appointment_no}?</AlertDialogTitle>
          <AlertDialogDescription>
            The slot is released immediately and the patient is notified. Who cancelled decides the refund, so
            it is asked separately from why.
          </AlertDialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${fieldId}-reason`} required>
              Reason
            </Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger id={`${fieldId}-reason`} data-testid="cancel-reason" aria-required="true">
                <SelectValue placeholder="Choose a reason" />
              </SelectTrigger>
              <SelectContent>
                {APPOINTMENT_CANCEL_REASONS.map((code) => (
                  <SelectItem key={code} value={code}>
                    {CANCEL_REASON_LABELS[code] ?? code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <fieldset className="flex flex-col gap-1">
            <legend className="inline-flex items-center gap-1 text-md font-medium text-fg-default">
              Cancelled by
              <span className="text-danger-fg" role="img" aria-label="required">
                *
              </span>
            </legend>
            <RadioGroup value={cancelledBy} onValueChange={setCancelledBy} className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm text-fg-default">
                <RadioGroupItem value="patient" data-testid="cancelled-by-patient" />
                The patient asked — the standard refund window applies
              </label>
              <label className="flex items-center gap-2 text-sm text-fg-default">
                <RadioGroupItem value="hospital" data-testid="cancelled-by-hospital" />
                The hospital cancelled — the patient is refunded in full
              </label>
            </RadioGroup>
          </fieldset>

          <div className="flex flex-col gap-1">
            <Label htmlFor={`${fieldId}-note`} required={noteRequired}>
              Note
            </Label>
            <Textarea
              id={`${fieldId}-note`}
              data-testid="cancel-note"
              value={note}
              aria-required={noteRequired}
              placeholder={noteRequired ? 'Required when the reason is "Other"' : 'Optional'}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </div>

          {error === null || error === undefined ? null : <ProblemCard error={error} />}
        </DialogBody>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Keep the appointment
          </Button>
          <Button
            variant="danger"
            data-testid="cancel-confirm"
            disabled={!canConfirm}
            onClick={() => {
              if (!canConfirm || reasonCode === null || party === null) return;
              onConfirm({ reason: reasonCode, cancelledBy: party, note: note.trim() });
            }}
          >
            {pending ? 'Cancelling…' : 'Cancel the appointment'}
          </Button>
        </DialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
