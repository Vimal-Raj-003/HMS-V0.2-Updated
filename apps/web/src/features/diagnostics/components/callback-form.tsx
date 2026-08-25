'use client';

import { Input, Label, RadioGroup, RadioGroupItem, Textarea } from '@vims/ui';
import { useId } from 'react';
import { LAB_NOTIFY_METHODS } from '../api/types';
import { callbackProblems, type CallbackFormState } from '../lib/critical';

/**
 * The D-10 communication record, for a critical laboratory value or a critical
 * imaging finding.
 *
 * One component for both because the obligation is one obligation: somebody was
 * told and repeated the value back, **or** nobody could be reached and the alert
 * was escalated to a named tier. The two APIs express it differently — a
 * discriminated union in OP-004, one object with a refinement in OP-008 — and
 * `lib/critical.ts` translates. The person filling it in should not have to know
 * which.
 *
 * ── Why the escalation arm is exactly as easy to fill in ────────────────────
 *
 * `docs/DECISIONS.md` D-10 is explicit: if "nobody could be reached" were harder
 * to record than "I spoke to Dr Rao", the pressure would fall back onto
 * withholding the report — which is the hazard the decision exists to remove.
 * Both arms are two fields. The escalation arm is labelled as a tracked
 * exception on the NABL KPI, which is what it is, and not as a failure.
 *
 * The form never posts. It reports what is still missing through
 * `callbackProblems`, and its owner decides what to do with that.
 */
export function CallbackForm({
  form,
  onChange,
  disabled = false,
}: {
  readonly form: CallbackFormState;
  readonly onChange: (next: CallbackFormState) => void;
  readonly disabled?: boolean;
}): React.JSX.Element {
  const id = useId();
  const problems = callbackProblems(form);

  function set<K extends keyof CallbackFormState>(key: K, value: CallbackFormState[K]): void {
    onChange({ ...form, [key]: value });
  }

  return (
    <div className="flex flex-col gap-3" data-testid="callback-form">
      <fieldset className="flex flex-col gap-2" disabled={disabled}>
        <legend className="text-sm font-medium text-fg-default">What happened when you called?</legend>
        <RadioGroup
          value={form.outcome}
          onValueChange={(value) => {
            set('outcome', value === 'clinician_unreachable_escalated' ? value : 'read_back_confirmed');
          }}
          className="flex flex-col gap-2"
        >
          <div className="flex items-start gap-2">
            <RadioGroupItem value="read_back_confirmed" id={`${id}-readback`} />
            <Label htmlFor={`${id}-readback`} className="font-normal">
              I spoke to a clinician and they repeated the value back to me
            </Label>
          </div>
          <div className="flex items-start gap-2">
            <RadioGroupItem value="clinician_unreachable_escalated" id={`${id}-escalated`} />
            <Label htmlFor={`${id}-escalated`} className="font-normal">
              I could not reach the clinician, so I escalated it
              <span className="block text-2xs text-fg-subtle">
                A tracked exception on the NABL critical-value indicator — not a failure, and not a bypass.
              </span>
            </Label>
          </div>
        </RadioGroup>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-method`}>How did you contact them?</Label>
          <select
            id={`${id}-method`}
            data-testid="callback-method"
            disabled={disabled}
            className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md text-fg-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            value={form.method}
            onChange={(event) => {
              set('method', event.target.value as CallbackFormState['method']);
            }}
          >
            {LAB_NOTIFY_METHODS.map((method) => (
              <option key={method} value={method}>
                {METHOD_LABELS[method]}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-attempts`}>How many attempts?</Label>
          <Input
            id={`${id}-attempts`}
            data-testid="callback-attempts"
            inputMode="numeric"
            disabled={disabled}
            value={form.attemptCount}
            onChange={(event) => {
              set('attemptCount', event.target.value);
            }}
          />
        </div>
      </div>

      {form.outcome === 'read_back_confirmed' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-name`}>Who did you speak to?</Label>
            <Input
              id={`${id}-name`}
              data-testid="callback-name"
              disabled={disabled}
              value={form.notifiedToName}
              onChange={(event) => {
                set('notifiedToName', event.target.value);
              }}
            />
            <p className="text-2xs text-fg-subtle">A person, not a ward. NABL asks who, by name.</p>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-role`}>Their role</Label>
            <Input
              id={`${id}-role`}
              data-testid="callback-role"
              disabled={disabled}
              value={form.notifiedToRole}
              onChange={(event) => {
                set('notifiedToRole', event.target.value);
              }}
            />
          </div>
          <div className="flex flex-col gap-1 sm:col-span-2">
            <Label htmlFor={`${id}-readback-value`}>What did they read back?</Label>
            <Input
              id={`${id}-readback-value`}
              data-testid="callback-readback"
              disabled={disabled}
              value={form.readBackValue}
              onChange={(event) => {
                set('readBackValue', event.target.value);
              }}
            />
            <p className="text-2xs text-fg-subtle">
              The value and the units as they said them. "Informed" is not a read-back.
            </p>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-level`}>Escalation tier reached</Label>
            <Input
              id={`${id}-level`}
              data-testid="callback-level"
              inputMode="numeric"
              disabled={disabled}
              value={form.escalatedToLevel}
              onChange={(event) => {
                set('escalatedToLevel', event.target.value);
              }}
            />
            <p className="text-2xs text-fg-subtle">
              1 is the ordering clinician’s cover, rising to the medical superintendent.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-esc-role`}>Escalated to which role?</Label>
            <Input
              id={`${id}-esc-role`}
              data-testid="callback-escalated-role"
              disabled={disabled}
              value={form.escalatedToRole}
              onChange={(event) => {
                set('escalatedToRole', event.target.value);
              }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-remarks`}>Anything else worth recording</Label>
        <Textarea
          id={`${id}-remarks`}
          data-testid="callback-remarks"
          rows={2}
          disabled={disabled}
          value={form.remarks}
          onChange={(event) => {
            set('remarks', event.target.value);
          }}
        />
      </div>

      {problems.length === 0 ? null : (
        <ul data-testid="callback-problems" className="flex flex-col gap-1 text-sm text-warning-fg">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const METHOD_LABELS: Readonly<Record<(typeof LAB_NOTIFY_METHODS)[number], string>> = {
  phone: 'Telephone',
  in_person: 'In person',
  secure_message: 'Secure message',
  video: 'Video call',
  pager: 'Pager',
  sms: 'SMS',
};
