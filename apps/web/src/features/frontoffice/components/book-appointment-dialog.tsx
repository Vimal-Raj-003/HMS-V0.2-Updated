'use client';

import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
} from '@vims/ui';
import { useEffect, useId, useState } from 'react';
import { ProblemCard } from '@/features/admin/components/problem-card';
import type { AppointmentSlot } from '@vims/ui';
import type { BookAppointmentRequest, PatientListItem } from '../api/types';
import { searchPatients } from '../api/client';

/**
 * Booking one slot.
 *
 * OP-001 §4 lets an appointment be held either by a registered patient or by an
 * unregistered **lead** (a name and a mobile number), and the server enforces
 * exactly that with a `refine`. The dialog mirrors it as two mutually exclusive
 * modes rather than one form with optional fields, because a half-filled form
 * that fails validation on submit is how a call-centre agent loses a caller.
 *
 * Overbooking is never implicit. When the chosen slot is already at capacity the
 * dialog says so, requires the box to be ticked, and — if the session does not
 * hold `appointment.overbook` — says who does instead of offering a control that
 * would be refused.
 */
export interface BookTarget {
  readonly slot: AppointmentSlot;
  readonly overbooking: boolean;
}

export function BookAppointmentDialog({
  target,
  onClose,
  onSubmit,
  canOverbook,
  pending,
  error,
}: {
  readonly target: BookTarget | null;
  readonly onClose: () => void;
  readonly onSubmit: (body: BookAppointmentRequest) => void;
  readonly canOverbook: boolean;
  readonly pending: boolean;
  readonly error: unknown;
}): React.JSX.Element {
  const fieldId = useId();
  const [mode, setMode] = useState<'patient' | 'lead'>('patient');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly PatientListItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<PatientListItem | null>(null);
  const [leadName, setLeadName] = useState('');
  const [leadMobile, setLeadMobile] = useState('');
  const [isTele, setIsTele] = useState(false);
  const [overbook, setOverbook] = useState(false);
  const [notes, setNotes] = useState('');

  const open = target !== null;

  useEffect(() => {
    if (open) return;
    setMode('patient');
    setQuery('');
    setResults([]);
    setSelected(null);
    setLeadName('');
    setLeadMobile('');
    setIsTele(false);
    setOverbook(false);
    setNotes('');
  }, [open]);

  const runSearch = async (): Promise<void> => {
    const trimmed = query.trim();
    if (trimmed.length < 3) return;
    setSearching(true);
    try {
      const page = await searchPatients({ q: trimmed });
      setResults(page.items);
    } catch {
      // The error is rendered by the parent's problem card on submit; a failed
      // lookup must not take the dialog down mid-booking.
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const overbookingBlocked = target?.overbooking === true && !canOverbook;
  const overbookingUnconfirmed = target?.overbooking === true && canOverbook && !overbook;
  const identified =
    mode === 'patient' ? selected !== null : leadName.trim().length > 0 && leadMobile.trim().length >= 6;
  const canSubmit = identified && !overbookingBlocked && !overbookingUnconfirmed && !pending;

  const submit = (): void => {
    if (target === null || !canSubmit) return;
    const trimmedNotes = notes.trim();
    onSubmit({
      slotId: target.slot.slotId,
      ...(mode === 'patient' && selected !== null
        ? { patientId: selected.id }
        : { leadName: leadName.trim(), leadMobile: leadMobile.trim() }),
      channel: 'counter',
      isTele,
      overbook: target.overbooking && canOverbook ? overbook : false,
      ...(trimmedNotes === '' ? {} : { notes: trimmedNotes }),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent closeLabel="Close" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Book {target === null ? '' : target.slot.startTime}</DialogTitle>
          <DialogDescription>
            The slot is held the moment this is confirmed. A retry of the same confirmation returns the same
            appointment rather than taking a second slot.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          <div role="group" aria-label="Who is this appointment for" className="flex gap-2">
            <Button
              variant={mode === 'patient' ? 'primary' : 'secondary'}
              size="sm"
              aria-pressed={mode === 'patient'}
              onClick={() => {
                setMode('patient');
              }}
            >
              Registered patient
            </Button>
            <Button
              variant={mode === 'lead' ? 'primary' : 'secondary'}
              size="sm"
              aria-pressed={mode === 'lead'}
              onClick={() => {
                setMode('lead');
              }}
            >
              Not registered yet
            </Button>
          </div>

          {mode === 'patient' ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${fieldId}-search`}>Find the patient</Label>
              <div className="flex gap-2">
                <Input
                  id={`${fieldId}-search`}
                  data-testid="book-patient-search"
                  value={query}
                  placeholder="Name, UHID or mobile"
                  autoComplete="off"
                  onChange={(event) => {
                    setQuery(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void runSearch();
                    }
                  }}
                />
                <Button
                  variant="secondary"
                  onClick={() => {
                    void runSearch();
                  }}
                >
                  Search
                </Button>
              </div>
              {searching ? <p className="text-sm text-fg-muted">Searching…</p> : null}
              {!searching && results.length === 0 && query.trim().length >= 3 ? (
                <p className="text-sm text-fg-muted">
                  Nobody matched. Register the patient first, or book them as not registered yet.
                </p>
              ) : null}
              <ul className="flex flex-col gap-1" aria-label="Search results">
                {results.map((patient) => (
                  <li key={patient.id}>
                    <button
                      type="button"
                      data-testid={`book-patient-${patient.uhid}`}
                      aria-pressed={selected?.id === patient.id}
                      onClick={() => {
                        setSelected(patient);
                      }}
                      className={`flex min-h-11 w-full items-center gap-3 rounded-md border px-3 text-start text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                        selected?.id === patient.id
                          ? 'border-accent-border bg-accent-surface text-accent-on-surface'
                          : 'border-default bg-layer-1 text-fg-default'
                      }`}
                    >
                      <span className="font-mono text-xs">{patient.uhid}</span>
                      <span className="min-w-0 flex-1 truncate">{patient.full_name}</span>
                      <span className="text-xs text-fg-muted">
                        {patient.age_years === null ? '' : `${String(patient.age_years)} y `}
                        {patient.gender}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${fieldId}-lead-name`} required>
                  Name
                </Label>
                <Input
                  id={`${fieldId}-lead-name`}
                  data-testid="book-lead-name"
                  value={leadName}
                  autoComplete="off"
                  onChange={(event) => {
                    setLeadName(event.target.value);
                  }}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${fieldId}-lead-mobile`} required>
                  Mobile
                </Label>
                <Input
                  id={`${fieldId}-lead-mobile`}
                  data-testid="book-lead-mobile"
                  value={leadMobile}
                  inputMode="tel"
                  autoComplete="off"
                  onChange={(event) => {
                    setLeadMobile(event.target.value);
                  }}
                />
              </div>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm text-fg-default">
            <Checkbox
              checked={isTele}
              onCheckedChange={(checked) => {
                setIsTele(checked === true);
              }}
            />
            Teleconsultation
          </label>

          {target?.overbooking === true ? (
            canOverbook ? (
              <div className="rounded-md border border-warning-border bg-warning-surface p-3">
                <p className="text-sm font-medium text-warning-on-surface">
                  This slot is already at capacity.
                </p>
                <p className="mt-1 text-sm text-warning-on-surface">
                  Overbooking is a decision about the doctor&apos;s clinical load, not a booking convenience.
                  The appointment will be flagged and your name recorded against it.
                </p>
                <label className="mt-2 flex items-center gap-2 text-sm text-warning-on-surface">
                  <Checkbox
                    checked={overbook}
                    data-testid="book-overbook"
                    onCheckedChange={(checked) => {
                      setOverbook(checked === true);
                    }}
                  />
                  I am deliberately booking beyond capacity
                </label>
              </div>
            ) : (
              <div role="note" className="rounded-md border border-strong bg-layer-1 p-3">
                <p className="text-sm font-medium text-fg-default">This slot is already at capacity.</p>
                <p className="mt-1 text-sm text-fg-muted">
                  Booking past capacity is held by the head of department and the branch administrator under{' '}
                  <span className="font-mono text-2xs">appointment.overbook</span>. Offer the patient another
                  slot, or ask one of them to book this one.
                </p>
              </div>
            )
          ) : null}

          <div className="flex flex-col gap-1">
            <Label htmlFor={`${fieldId}-notes`}>Note for the desk</Label>
            <Textarea
              id={`${fieldId}-notes`}
              value={notes}
              onChange={(event) => {
                setNotes(event.target.value);
              }}
            />
          </div>

          {error === null || error === undefined ? null : <ProblemCard error={error} />}
        </DialogBody>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" data-testid="book-confirm" disabled={!canSubmit} onClick={submit}>
            {pending ? 'Booking…' : 'Book this slot'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
