'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  Badge,
  Button,
  Checkbox,
  DialogBody,
  DialogFooter,
  DialogHeader,
  Label,
  Textarea,
} from '@vims/ui';
import { useId, useState } from 'react';
import { OctagonAlert } from '@/lib/icons';
import type { ApiProblem } from '@/lib/api';
import { useSession } from '@/lib/session-context';
import {
  acknowledgedIds,
  canOverrideDuplicates,
  isUsableReason,
  MIN_REASON_LENGTH,
  parseDuplicateCandidates,
  type DuplicateCandidate,
} from '../lib/duplicates';

/**
 * OP-001 §3.1's duplicate hard stop, rendered as a hard stop.
 *
 * `docs/06` §6.8 defines what that means and this component is held to every
 * clause of it: an `AlertDialog` with no Escape, no click-outside and no close X;
 * the **safe** action in the primary position ("Open the existing record"); and
 * the continue-anyway path styled `danger` and reachable only through friction.
 *
 * The friction is not decoration. Passing the stop requires, in this order:
 *
 *  1. `patient.record.create_override` — a key the receptionist template
 *     deliberately does **not** hold (`role-templates.ts`), so somebody is named
 *     for the decision;
 *  2. ticking each candidate individually, which is what becomes
 *     `overrideDuplicate.acknowledgedPatientIds`; the server refuses an override
 *     that does not cover every blocking candidate, so this cannot be a single
 *     "I agree";
 *  3. a reason of at least eight characters, which is written to the new record's
 *     `created_override_reason` and into the audit register.
 *
 * **There is no automatic retry.** The failed registration is not resubmitted
 * with the override flag by any code path; the operator resubmits it, having read
 * the list. That sentence is the whole reason this component exists rather than a
 * `catch` clause in the mutation.
 */

export interface DuplicateOverride {
  readonly acknowledgedPatientIds: readonly string[];
  readonly reason: string;
}

const OVERRIDE_PERMISSION = 'patient.record.create_override';

export function DuplicateHardStop({
  problem,
  open,
  onOpenChange,
  onOpenExisting,
  onOverride,
  submitting,
}: {
  readonly problem: ApiProblem;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOpenExisting: (patientId: string) => void;
  readonly onOverride: (override: DuplicateOverride) => void;
  readonly submitting: boolean;
}): React.JSX.Element {
  const reasonId = useId();
  const { granted } = useSession();
  const candidates = parseDuplicateCandidates(problem);
  const parseable = canOverrideDuplicates(candidates);
  const holdsOverride = granted.has(OVERRIDE_PERMISSION);

  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set());
  const [reason, setReason] = useState('');
  const [showOverride, setShowOverride] = useState(false);

  const required = acknowledgedIds(candidates);
  const allAcknowledged = required.length > 0 && required.every((id) => acknowledged.has(id));
  const canSubmit = parseable && holdsOverride && allAcknowledged && isUsableReason(reason) && !submitting;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-2xl" data-testid="duplicate-hard-stop">
        <DialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <OctagonAlert className="size-5 shrink-0" aria-hidden="true" />
            This patient may already be registered
          </AlertDialogTitle>
          <AlertDialogDescription>{problem.problem.detail}</AlertDialogDescription>
        </DialogHeader>

        {/*
          The candidate list is unbounded — a shared family mobile legitimately
          returns several — so the *body* scrolls rather than the panel. Letting the
          panel grow pushes "Back to the form" off the bottom of the screen, and a
          hard stop whose safe way out is below the fold is a hard stop people learn
          to reload the page to escape.
        */}
        <DialogBody className="flex max-h-[55vh] flex-col gap-4 overflow-y-auto">
          {problem.problem.clinicalImpact === undefined ? null : (
            <p
              className="rounded-md border border-danger-border bg-danger-surface p-3 text-sm text-danger-on-surface"
              data-testid="duplicate-clinical-impact"
            >
              {problem.problem.clinicalImpact}
            </p>
          )}

          <section aria-labelledby="duplicate-candidates-heading">
            <h3 id="duplicate-candidates-heading" className="text-md font-medium text-fg-default">
              Already in this hospital&rsquo;s index
            </h3>
            <ul className="mt-2 flex flex-col gap-2">
              {candidates.map((candidate, index) => (
                <CandidateRow
                  key={candidate.patientId ?? `unparsed-${String(index)}`}
                  candidate={candidate}
                  showAcknowledgement={showOverride && parseable && holdsOverride}
                  acknowledged={candidate.patientId !== null && acknowledged.has(candidate.patientId)}
                  onAcknowledge={(next) => {
                    const id = candidate.patientId;
                    if (id === null) return;
                    setAcknowledged((current) => {
                      const updated = new Set(current);
                      if (next) updated.add(id);
                      else updated.delete(id);
                      return updated;
                    });
                  }}
                  onOpen={() => {
                    if (candidate.patientId !== null) onOpenExisting(candidate.patientId);
                  }}
                />
              ))}
            </ul>
          </section>

          {problem.problem.nextAction === undefined ? null : (
            <p className="text-sm text-fg-muted">{problem.problem.nextAction}</p>
          )}

          {showOverride ? (
            <section
              aria-labelledby="duplicate-override-heading"
              className="rounded-md border border-danger-border p-3"
              data-testid="duplicate-override-panel"
            >
              <h3 id="duplicate-override-heading" className="text-md font-medium text-danger-fg">
                Register anyway
              </h3>

              {!holdsOverride ? (
                <p className="mt-1 text-sm text-fg-muted" data-testid="override-not-permitted">
                  Registering past a suspected duplicate needs the{' '}
                  <span className="font-mono text-xs">{OVERRIDE_PERMISSION}</span> permission, which your
                  roles do not include. Ask a supervisor or medical records to register this patient, or open
                  the existing record above.
                </p>
              ) : !parseable ? (
                <p className="mt-1 text-sm text-fg-muted" data-testid="override-not-available">
                  One of the suspected duplicates above could not be read well enough to acknowledge it
                  individually, and the server will not accept a partial acknowledgement. Open the existing
                  records and register the visit against the right one.
                </p>
              ) : (
                <>
                  <p className="mt-1 text-sm text-fg-muted">
                    Tick every record above to confirm you have checked it and it is a different person, then
                    say why. The reason is stored on the new record and in the audit register.
                  </p>
                  <div className="mt-3">
                    <Label htmlFor={reasonId}>Why these are different people</Label>
                    <Textarea
                      id={reasonId}
                      value={reason}
                      rows={3}
                      data-testid="override-reason"
                      aria-describedby={`${reasonId}-hint`}
                      placeholder="e.g. Same name and date of birth, different mother's name and address; checked the Aadhaar-less ID card at the counter"
                      onChange={(event) => {
                        setReason(event.target.value);
                      }}
                    />
                    <p id={`${reasonId}-hint`} className="mt-1 text-xs text-fg-muted">
                      At least {MIN_REASON_LENGTH} characters. Somebody reading the duplicate register in six
                      months has only this sentence to go on.
                    </p>
                  </div>
                </>
              )}
            </section>
          ) : null}

          <p className="font-mono text-xs text-fg-subtle">
            Reference: <span data-testid="duplicate-reference">{problem.reference}</span>
          </p>
        </DialogBody>

        <DialogFooter>
          {/* The safe action sits in the primary position (docs/06 §6.8). */}
          <AlertDialogCancel asChild>
            <Button variant="primary" data-testid="duplicate-back-to-form">
              Back to the form
            </Button>
          </AlertDialogCancel>

          {/* `docs/06` §4.1: never render an item the user cannot use. A disabled
              "Register as a new patient" in front of somebody who will never hold
              `patient.record.create_override` is an invitation to keep clicking it.
              The explanation in the panel above is what they get instead. */}
          {showOverride && holdsOverride && parseable ? (
            <AlertDialogAction asChild>
              <Button
                variant="danger"
                disabled={!canSubmit}
                data-testid="duplicate-register-anyway"
                onClick={(event) => {
                  // Radix closes the dialog on an Action click. When the request
                  // is refused again — a candidate that appeared since — the
                  // clerk must still be looking at the stop, so closing is left
                  // to the caller.
                  event.preventDefault();
                  if (!canSubmit) return;
                  onOverride({ acknowledgedPatientIds: required, reason: reason.trim() });
                }}
              >
                Register as a new patient
              </Button>
            </AlertDialogAction>
          ) : (
            <Button
              variant="secondary"
              data-testid="duplicate-show-override"
              onClick={() => {
                setShowOverride(true);
              }}
            >
              These are different people
            </Button>
          )}
        </DialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function CandidateRow({
  candidate,
  showAcknowledgement,
  acknowledged,
  onAcknowledge,
  onOpen,
}: {
  readonly candidate: DuplicateCandidate;
  readonly showAcknowledgement: boolean;
  readonly acknowledged: boolean;
  readonly onAcknowledge: (next: boolean) => void;
  readonly onOpen: () => void;
}): React.JSX.Element {
  const checkboxId = useId();
  const score = candidate.score === null ? null : Math.round(candidate.score * 100);

  return (
    <li
      data-testid="duplicate-candidate"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-default bg-layer-1 p-3"
    >
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-display text-sm text-fg-default" data-testid="candidate-uhid">
            {candidate.uhid ?? 'UHID unreadable'}
          </span>
          {score === null ? null : (
            <Badge tone="danger" size="sm" data-testid="candidate-score">
              {score}% match
            </Badge>
          )}
        </p>
        <p className="mt-0.5 text-sm text-fg-default">{candidate.descriptor ?? candidate.raw}</p>
        {candidate.rules.length === 0 ? null : (
          <p className="mt-0.5 text-xs text-fg-muted">Matched on {candidate.rules.join(', ')}</p>
        )}
      </div>

      {candidate.patientId === null ? null : (
        <Button variant="secondary" size="sm" data-testid="candidate-open" onClick={onOpen}>
          Open this record
        </Button>
      )}

      {showAcknowledgement && candidate.patientId !== null ? (
        <span className="flex w-full items-center gap-2 border-t border-default pt-2">
          <Checkbox
            id={checkboxId}
            checked={acknowledged}
            data-testid="candidate-acknowledge"
            onCheckedChange={(checked) => {
              onAcknowledge(checked === true);
            }}
          />
          <Label htmlFor={checkboxId} className="text-sm font-normal">
            I have opened {candidate.uhid ?? 'this record'} and this is a different person
          </Label>
        </span>
      ) : null}
    </li>
  );
}
