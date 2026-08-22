'use client';

import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vims/ui';
import { useId, useState } from 'react';
import { OctagonAlert } from '@/lib/icons';
import { ActionUnavailable } from '@/features/frontoffice/components/frontoffice-gate';
import { VITALS_ALERT_ACTIONS, type VitalsAlertAction, type VitalsAlertView } from '../api/types';
import { formatInstant } from '../lib/numbers';

/**
 * OP-007 §3.2.4 — the mandatory action prompt on a critical reading.
 *
 * "Critical → **mandatory action prompt**: repeat measurement, notify the doctor
 * immediately, … nurse notes action taken; hard-stop cannot forward without
 * doctor ack." So this panel:
 *
 *  - **cannot be dismissed.** There is no close button, no "later", and it is
 *    not a toast. `docs/06` §10 lists "a dismissible toast saying 'possible
 *    allergy'" as the anti-pattern, and a critical potassium-equivalent that
 *    scrolled past is the failure the whole module exists to prevent;
 *  - names the parameters that crossed, not just "critical";
 *  - separates the two people. Recording *what was done* is the nurse's; the
 *    **acknowledgement** is the doctor's, gated on `vitals.alert.acknowledge`,
 *    which OP-007 §12 gives to doctors and not to the vitals nurse. A nurse
 *    therefore sees what is outstanding and who must close it, rather than a
 *    button that would be refused.
 *
 * Two capabilities OP-007 §6 lists are **not** offered here, because the API
 * does not implement them and a button that cannot work is worse than an
 * explained absence: `POST /vitals/records/{id}/send-to-er` (the one-click ER
 * escalation) and `POST /vitals/records/{id}/forward` (hand-back to the doctor's
 * queue). Both are reported as gaps.
 */
export function CriticalActionPrompt({
  alerts,
  parameters,
  canAcknowledge,
  onAcknowledge,
  acknowledging,
}: {
  readonly alerts: readonly VitalsAlertView[];
  readonly parameters: readonly string[];
  readonly canAcknowledge: boolean;
  readonly onAcknowledge: (alertId: string, action: VitalsAlertAction, note: string) => void;
  readonly acknowledging: boolean;
}): React.JSX.Element | null {
  const actionId = useId();
  const noteId = useId();
  const [action, setAction] = useState<VitalsAlertAction>('doctor_informed');
  const [note, setNote] = useState('');

  const open = alerts.filter((alert) => alert.acknowledged_at === null);
  if (alerts.length === 0) return null;

  return (
    <section
      role="alert"
      aria-live="assertive"
      data-testid="critical-action-prompt"
      className="rounded-lg border-2 border-danger-border bg-danger-surface p-4"
    >
      <h2 className="flex items-center gap-2 text-md font-semibold text-danger-on-surface">
        <OctagonAlert className="size-5 shrink-0" aria-hidden="true" />
        Critical reading — this needs an action now
      </h2>
      <p className="mt-1 text-sm text-danger-on-surface">
        {parameters.length === 0
          ? 'The server flagged this observation set as critical.'
          : `Out of range: ${parameters.join(', ')}.`}{' '}
        Repeat the measurement, tell the doctor, and record what you did. The patient is not forwarded until a
        doctor acknowledges this.
      </p>

      <ul className="mt-3 flex flex-col gap-1" data-testid="critical-alert-list">
        {alerts.map((alert) => (
          <li key={alert.id} className="text-2xs text-danger-on-surface">
            <span className="font-medium">{alert.level === 'critical' ? 'Critical' : 'Abnormal'}</span> ·{' '}
            {alert.parameters.join(', ')} ·{' '}
            {alert.acknowledged_at === null
              ? 'not yet acknowledged by a doctor'
              : `acknowledged ${formatInstant(alert.acknowledged_at)}`}
          </li>
        ))}
      </ul>

      {open.length === 0 ? (
        <p className="mt-3 text-sm text-danger-on-surface" data-testid="critical-closed">
          Every alert on this reading has been acknowledged.
        </p>
      ) : canAcknowledge ? (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="flex min-w-56 flex-col gap-1">
            <Label htmlFor={actionId}>What was done</Label>
            <Select
              value={action}
              onValueChange={(value) => {
                setAction(value as VitalsAlertAction);
              }}
            >
              <SelectTrigger id={actionId} data-testid="critical-action" className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VITALS_ALERT_ACTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {ACTION_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex min-w-64 flex-1 flex-col gap-1">
            <Label htmlFor={noteId}>Note for the record</Label>
            <Input
              id={noteId}
              data-testid="critical-note"
              className="h-11"
              value={note}
              autoComplete="off"
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </div>
          <Button
            variant="danger"
            data-testid="critical-acknowledge"
            disabled={acknowledging}
            onClick={() => {
              const first = open[0];
              if (first !== undefined) onAcknowledge(first.id, action, note);
            }}
          >
            Acknowledge and record
          </Button>
        </div>
      ) : (
        <div className="mt-4">
          <ActionUnavailable
            title="A doctor has to acknowledge this"
            because="Acknowledging a critical observation is the doctor's half of the loop — it is what closes the alert and releases the patient to the consultation. Call the doctor to the station, or send the alert through so they acknowledge it on their console."
            permission="vitals.alert.acknowledge"
          />
        </div>
      )}
    </section>
  );
}

const ACTION_LABELS: Readonly<Record<VitalsAlertAction, string>> = {
  repeat: 'Repeated the measurement',
  doctor_informed: 'Informed the doctor',
  sent_to_er: 'Sent the patient to the ER',
  none: 'No action taken yet',
};
