'use client';

import { Badge, Label, Textarea } from '@vims/ui';
import { OctagonAlert, TriangleAlert } from '@/lib/icons';
import { REASON_MIN_LENGTH, ackKeyOf, type CounterAlert } from '../lib/counter';

/**
 * The allergy and interaction hard stops at the counter.
 *
 * ── What this component does not have ───────────────────────────────────────
 *
 * There is no close button, no `onDismiss`, no "acknowledge" checkbox and no
 * `open` prop. It is not a dialog: a dialog has an Escape key and a scrim to
 * click, and both of those are ways past an allergy alert that leave no trace.
 * It is a **region of the page** that exists while the alert exists and stops
 * existing when the API stops reporting it — which happens when the reason has
 * been recorded and the evaluation re-run, and at no other time.
 *
 * `docs/06` §1.2: a hard stop is "modal, cannot be dismissed, requires a
 * documented override reason". The first two are structural here. The third is
 * the textarea, and the reason it is a textarea rather than a dropdown of
 * pre-written excuses is that the only lawful way past an allergy alert is a
 * conversation with the prescriber, and no dropdown can hold what was said.
 *
 * ── Alert fatigue is a safety defect ────────────────────────────────────────
 *
 * `docs/06` §1.2 bullet 2 tracks it as one (EN-037). So the panel distinguishes
 * two things a lazier design would merge: the alerts that **hold this counter**
 * — allergy and interaction, which the pharmacist is the second net for — and
 * the hard stops that already stopped the prescriber and fire here on facts a
 * pharmacist cannot change. Both are shown. Only the first demands a reason,
 * because demanding one for the second teaches people to type "ok".
 */
export function HardStopPanel({
  blocking,
  advisory,
  reasons,
  onReasonChange,
}: {
  readonly blocking: readonly CounterAlert[];
  readonly advisory: readonly CounterAlert[];
  readonly reasons: ReadonlyMap<string, string>;
  readonly onReasonChange: (key: string, reason: string) => void;
}): React.JSX.Element | null {
  if (blocking.length === 0 && advisory.length === 0) return null;

  return (
    <section className="flex flex-col gap-3" data-testid="hard-stop-panel">
      {blocking.length === 0 ? null : (
        <div
          role="alert"
          aria-live="assertive"
          data-testid="blocking-alerts"
          className="flex flex-col gap-3 rounded-lg border-2 border-danger-border bg-danger-surface p-4"
        >
          <p className="flex items-center gap-2 text-lg font-semibold text-danger-on-surface">
            <OctagonAlert className="size-5 shrink-0" aria-hidden="true" />
            {blocking.length === 1
              ? 'This prescription has a safety hard stop'
              : `This prescription has ${String(blocking.length)} safety hard stops`}
          </p>
          <p className="text-sm text-danger-on-surface">
            You are the second safety net. This cannot be dismissed and there is no setting that turns it off.
            Telephone the prescriber; if the medicine is still to be given, write down what was decided and it
            will be recorded against the dispense.
          </p>

          {blocking.map((entry) => {
            const key = ackKeyOf(entry.dispenseItemId, entry.alert.key);
            const recorded = reasons.get(key) ?? '';
            const short = recorded.trim().length < REASON_MIN_LENGTH;
            return (
              <div
                key={key}
                data-testid={`blocking-alert-${entry.alert.key}`}
                className="flex flex-col gap-2 rounded-md border border-danger-border bg-layer-1 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="danger" icon={<OctagonAlert aria-hidden="true" />}>
                    Hard stop
                  </Badge>
                  <span className="text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                    {entry.alert.family === 'allergy' ? 'Allergy' : 'Interaction'}
                  </span>
                  <span className="font-mono text-2xs text-fg-subtle">
                    Line {entry.lineNo} · {entry.itemName}
                  </span>
                </div>
                <p className="text-md font-medium text-fg-default">{entry.alert.title}</p>
                <p className="text-sm text-fg-muted">{entry.alert.detail}</p>

                <div className="flex flex-col gap-1">
                  <Label htmlFor={`ack-${key}`}>
                    What did the prescriber say? (required — at least {REASON_MIN_LENGTH} characters)
                  </Label>
                  <Textarea
                    id={`ack-${key}`}
                    data-testid={`ack-${entry.alert.key}`}
                    rows={2}
                    value={recorded}
                    aria-describedby={`ack-help-${key}`}
                    onChange={(event) => {
                      onReasonChange(key, event.target.value);
                    }}
                    placeholder="e.g. Dr Menon telephoned 10:42 — documented reaction was a rash, not anaphylaxis; proceed."
                  />
                  <p id={`ack-help-${key}`} className="text-2xs text-fg-muted">
                    {short
                      ? 'Completion stays blocked until this says what was decided and by whom.'
                      : 'Recorded. It is written to the dispense and to the audit trail, and the prescriber sees it.'}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {advisory.length === 0 ? null : (
        <div
          data-testid="advisory-alerts"
          className="flex flex-col gap-2 rounded-lg border border-warning-border bg-warning-surface p-3"
        >
          <p className="flex items-center gap-2 text-md font-medium text-warning-on-surface">
            <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
            {advisory.length === 1
              ? 'One alert was raised for the prescriber, not for this counter'
              : `${String(advisory.length)} alerts were raised for the prescriber, not for this counter`}
          </p>
          <p className="text-sm text-warning-on-surface">
            These already stopped the person who wrote the prescription and fire on facts you cannot change
            here. They are shown so you know they exist; they do not hold the counter.
          </p>
          <ul className="flex flex-col gap-1">
            {advisory.map((entry) => (
              <li key={ackKeyOf(entry.dispenseItemId, entry.alert.key)} className="text-sm text-fg-default">
                <span className="font-mono text-2xs text-fg-subtle">Line {entry.lineNo} · </span>
                {entry.alert.title}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
