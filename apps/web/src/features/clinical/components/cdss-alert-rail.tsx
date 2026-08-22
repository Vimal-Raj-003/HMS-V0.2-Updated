'use client';

import { Badge, Button, ConfirmWithReasonDialog, type ConfirmWithReasonLabels } from '@vims/ui';
import { useState } from 'react';
import { Info, OctagonAlert, TriangleAlert } from '@/lib/icons';
import type { EvaluationView, OverrideInput } from '../api/types';
import { classify, degradedNotice, familyLabel, type SubmissionGate } from '../lib/cdss';
import { OVERRIDE_REASONS, overrideReasonLabel } from '../lib/override-reasons';
import { formatInstant } from '../lib/numbers';

/**
 * EN-029 §8 — the inline alert rail, and the single most important piece of UI
 * in this feature.
 *
 * ## A hard stop has no way past it on this screen
 *
 * When a floor rule fires, this component renders a red card and **no control
 * that submits anything**. There is no "prescribe anyway", no disabled
 * "override" waiting to be enabled, no confirmation dialog with a scary word in
 * it. `docs/06` §10 lists "a dismissible toast saying 'possible allergy'" as the
 * defect and "hard stop for a documented allergy match" as the correct
 * behaviour; EN-029 §3.2.7 says the only lawful ways forward are **a different
 * order** or **a countersignature by a second clinician**, captured as a second
 * signature.
 *
 * The countersignature is deliberately *not* offered here. The person at this
 * screen is the prescriber, and the API refuses a countersignature from the
 * prescriber who raised the alert (`second-person-required`). Offering the
 * control here would put a button that looks like a bypass on exactly the screen
 * where it must not exist. What the card gives instead is the alert reference —
 * the id and the instant — which is what a consultant opens it by from their own
 * login on the consultation screen.
 *
 * ## A soft stop needs a code, not a sentence
 *
 * The override dialog is a **coded list**. `overrideSchema` on the API requires
 * `reasonCode`, the column is a foreign key into the hospital's reason master,
 * and a CHECK constraint refuses the row without it — so free text alone is
 * refused three times over, and offering it alone here would only produce a 422
 * the prescriber cannot act on. `Other` additionally demands the free text,
 * because EN-029 §5 requires ≥ 20 characters for it.
 *
 * ## Degradation is never silence
 *
 * A degraded evaluation shows a banner that cannot be dismissed. "Safety checks
 * unavailable — orders are being placed without interaction checking" is
 * EN-029's own wording for it, and the product fails closed on the floor
 * families regardless.
 */

const OVERRIDE_LABELS: ConfirmWithReasonLabels = {
  title: 'Record why you are prescribing through this alert',
  description:
    'The reason is stored against the alert, is reportable, and is what the hospital reviews when it tunes this rule. A code is required — a note on its own is not accepted.',
  reasonLabel: 'Reason',
  reasonPlaceholder: 'Choose the reason',
  notePlaceholder: 'Anything the next clinician needs to know',
  confirm: 'Record the reason',
  cancel: 'Change the prescription instead',
  typedValuePrompt: (expected) => `Type ${expected} to confirm`,
  reasonRequired: 'Choose a coded reason. Free text on its own is not accepted.',
  typedValueMismatch: 'That does not match.',
};

export function CdssAlertRail({
  evaluation,
  gate,
  overrides,
  onOverride,
  checking,
}: {
  readonly evaluation: EvaluationView | null;
  readonly gate: SubmissionGate;
  readonly overrides: readonly OverrideInput[];
  readonly onOverride: (override: OverrideInput) => void;
  readonly checking: boolean;
}): React.JSX.Element {
  const [answering, setAnswering] = useState<string | null>(null);

  const { hardStops, softStops, passive } =
    evaluation === null ? { hardStops: [], softStops: [], passive: [] } : classify(evaluation.alerts);
  const degraded = degradedNotice(evaluation);

  const total = hardStops.length + softStops.length + passive.length;
  const needsAction =
    gate.kind === 'blocked'
      ? gate.alerts.length
      : gate.kind === 'needs-coded-reason'
        ? gate.families.length
        : 0;

  return (
    <section className="flex flex-col gap-3" aria-label="Safety checks" data-testid="cdss-rail">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-md font-medium text-fg-default">Safety checks</h2>
        {checking ? (
          <Badge tone="info" data-testid="cdss-checking">
            Checking…
          </Badge>
        ) : evaluation === null ? (
          <Badge tone="neutral" data-testid="cdss-not-run">
            Not run yet
          </Badge>
        ) : (
          <Badge tone={needsAction > 0 ? 'warning' : 'success'} data-testid="cdss-summary">
            {total} check{total === 1 ? '' : 's'} —{' '}
            {needsAction === 0 ? 'nothing to action' : `${String(needsAction)} needs action`}
          </Badge>
        )}
      </div>

      {degraded === null ? null : (
        <p
          role="alert"
          data-testid="cdss-degraded"
          className="rounded-md border border-danger-border bg-danger-surface p-3 text-sm text-danger-on-surface"
        >
          {degraded} The checks that could not run are not a pass — treat this prescription as unchecked for
          them.
        </p>
      )}

      {hardStops.length === 0 ? null : (
        <div
          role="alert"
          data-testid="cdss-hard-stop"
          className="rounded-lg border-2 border-danger-border bg-danger-surface p-4"
        >
          <h3 className="flex items-center gap-2 text-md font-semibold text-danger-on-surface">
            <OctagonAlert className="size-5 shrink-0" aria-hidden="true" />
            This prescription cannot be issued
          </h3>
          <p className="mt-1 text-sm text-danger-on-surface">
            {hardStops.length === 1 ? 'A safety rule' : `${String(hardStops.length)} safety rules`} that this
            hospital cannot switch off stopped it. There is no way to send it as it stands: change the
            prescription, or ask a consultant to countersign the alert from their own login.
          </p>

          <ul className="mt-3 flex flex-col gap-3" data-testid="hard-stop-list">
            {hardStops.map((alert) => (
              <li key={alert.alertEventId} className="border-l-2 border-danger-border pl-3">
                <p className="text-sm font-medium text-danger-on-surface">
                  {familyLabel(alert.family)} — {alert.title}
                </p>
                <p className="mt-1 text-sm text-danger-on-surface">{alert.detail}</p>
                <p className="mt-1 text-sm text-danger-on-surface">{alert.suggestedAction}</p>
                <p className="mt-1 font-mono text-2xs text-fg-muted">
                  Line {alert.lineNo} · alert{' '}
                  <span data-testid="hard-stop-alert-id">{alert.alertEventId}</span> · fired{' '}
                  {formatInstant(alert.firedAt)}
                  {alert.safetyFloorKey === null ? '' : ` · rule ${alert.safetyFloorKey}`}
                </p>
              </li>
            ))}
          </ul>

          <p className="mt-3 text-2xs text-danger-on-surface">
            A countersignature is a second person’s signature, so it cannot be given here — the API refuses it
            from the prescriber who raised the alert. Read the alert reference to the consultant; they clear
            it from the consultation screen.
          </p>
        </div>
      )}

      {softStops.length === 0 ? null : (
        <ul className="flex flex-col gap-2" data-testid="cdss-soft-stops">
          {softStops.map((alert) => {
            const answered = overrides.find((override) => override.family === alert.family);
            return (
              <li
                key={alert.alertEventId}
                className="rounded-lg border border-warning-border bg-warning-surface p-3"
                data-testid={`soft-stop-${alert.family}`}
              >
                <p className="flex items-center gap-2 text-sm font-medium text-warning-on-surface">
                  <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
                  {familyLabel(alert.family)} — {alert.title}
                </p>
                <p className="mt-1 text-sm text-warning-on-surface">{alert.detail}</p>
                <p className="mt-1 text-sm text-warning-on-surface">{alert.suggestedAction}</p>

                {answered === undefined ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-2"
                    data-testid={`soft-stop-answer-${alert.family}`}
                    onClick={() => {
                      setAnswering(alert.family);
                    }}
                  >
                    Record a reason to continue
                  </Button>
                ) : (
                  <p
                    className="mt-2 text-2xs text-warning-on-surface"
                    data-testid={`soft-stop-answered-${alert.family}`}
                  >
                    Reason recorded: {overrideReasonLabel(answered.reasonCode)}
                    {answered.note === undefined || answered.note === '' ? '' : ` — ${answered.note}`}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {passive.length === 0 ? null : (
        <ul className="flex flex-col gap-1" data-testid="cdss-passive">
          {passive.map((alert) => (
            <li key={alert.alertEventId} className="flex items-start gap-2 text-2xs text-fg-muted">
              <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              <span>
                {familyLabel(alert.family)} — {alert.title}. {alert.detail}
                {alert.cleared ? ' (a countersignature has already cleared this one)' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      <ConfirmWithReasonDialog
        open={answering !== null}
        onOpenChange={(open) => {
          if (!open) setAnswering(null);
        }}
        labels={OVERRIDE_LABELS}
        reasonOptions={OVERRIDE_REASONS}
        onConfirm={(result) => {
          const family = answering;
          setAnswering(null);
          if (family === null || result.reasonCode === undefined) return;
          onOverride({
            family,
            reasonCode: result.reasonCode,
            ...(result.reasonText.trim() === '' ? {} : { note: result.reasonText.trim() }),
          });
        }}
      />
    </section>
  );
}
