import type { AlertView, EvaluationView, OverrideInput } from '../api/types';

/**
 * EN-029 §3.2 / §5 — the interruption ladder, decided in one place.
 *
 * The whole safety argument of the prescribing screen rests on this file, so it
 * is a pure function over the evaluation and nothing else: no fetching, no
 * state, no rendering. That makes the rule testable in isolation and makes the
 * failure mode visible — a test that deletes the hard-stop arm fails here, not
 * three components away.
 *
 * The three levels and what each one means for the UI:
 *
 *  - **hard stop** — the order cannot be placed. Not "placed with a warning",
 *    not "placed after a confirmation", not "placed by an administrator". The
 *    screen renders **no affordance that submits**, because an affordance that
 *    submits is a hard stop that isn't one. The only ways forward are to change
 *    the prescription, or for a *different* clinician holding `rx.cosign` to
 *    countersign the alert through `POST /cdss/alerts/{id}/respond`.
 *  - **soft stop** — the order may proceed only with a **coded** reason from the
 *    hospital's list. Free text alone is refused by the API (`overrideSchema`
 *    requires `reasonCode`), so free text alone is never offered.
 *  - **passive** — shown inline, blocks nothing.
 *
 * `shadow` alerts are invisible to clinicians by EN-029 §5 and are dropped here
 * rather than filtered in a renderer, so they cannot leak into a print or an
 * export by way of a component that forgot.
 */

export type AlertLevel = 'hard_stop' | 'soft_stop' | 'passive';

export interface ClassifiedAlerts {
  readonly hardStops: readonly AlertView[];
  readonly softStops: readonly AlertView[];
  readonly passive: readonly AlertView[];
}

/** A hard stop already cleared by a countersignature is no longer blocking. */
export function isBlocking(alert: AlertView): boolean {
  return alert.interruption === 'hard_stop' && !alert.cleared;
}

export function classify(alerts: readonly AlertView[]): ClassifiedAlerts {
  const hardStops: AlertView[] = [];
  const softStops: AlertView[] = [];
  const passive: AlertView[] = [];

  for (const alert of alerts) {
    switch (alert.interruption) {
      case 'shadow':
        // EN-029 §5: shadow rules are invisible to clinicians, full stop.
        break;
      case 'hard_stop':
        if (alert.cleared) passive.push(alert);
        else hardStops.push(alert);
        break;
      case 'soft_stop':
        softStops.push(alert);
        break;
      case 'passive':
        passive.push(alert);
        break;
    }
  }
  return { hardStops, softStops, passive };
}

/**
 * The families of soft stop still waiting for a coded reason.
 *
 * The API keys an override by **family**, not by alert id, so two `ddi` alerts
 * on one line are answered by one reason — which is also how a prescriber thinks
 * about it. A family whose reason has been chosen drops out of this list, and
 * when the list is empty the prescription may be submitted.
 */
export function unansweredFamilies(
  needsCodedReason: readonly AlertView[],
  overrides: readonly OverrideInput[],
): readonly string[] {
  const answered = new Set(
    overrides.filter((override) => override.reasonCode.trim() !== '').map((o) => o.family),
  );
  const families: string[] = [];
  for (const alert of needsCodedReason) {
    if (answered.has(alert.family)) continue;
    if (!families.includes(alert.family)) families.push(alert.family);
  }
  return families;
}

/**
 * What the screen may offer, as a value rather than as a pile of booleans.
 *
 * A discriminated union because the three states have genuinely different UI and
 * the dangerous mistake — rendering the submit button in the `blocked` arm — is
 * then a type error rather than a missing `&&`.
 */
export type SubmissionGate =
  /** Nothing may be submitted. There is no "anyway". */
  | { readonly kind: 'blocked'; readonly alerts: readonly AlertView[] }
  /** Submittable once every listed family carries a coded reason. */
  | { readonly kind: 'needs-coded-reason'; readonly families: readonly string[] }
  | { readonly kind: 'clear' };

export function submissionGate(
  evaluation: EvaluationView | null,
  overrides: readonly OverrideInput[],
): SubmissionGate {
  if (evaluation === null) return { kind: 'clear' };

  const blocking = evaluation.blocking.filter(isBlocking);
  if (blocking.length > 0) return { kind: 'blocked', alerts: blocking };

  const families = unansweredFamilies(evaluation.needsCodedReason, overrides);
  if (families.length > 0) return { kind: 'needs-coded-reason', families };

  return { kind: 'clear' };
}

/**
 * Whether a submit control may be **rendered at all**.
 *
 * Not "enabled": rendered. `docs/06` §10 lists a dismissible affordance over a
 * documented allergy as a defect, and a greyed-out "Prescribe anyway" is an
 * affordance a user will hunt for a way to enable. On a hard stop the control is
 * absent and a card stands in its place explaining what would clear it.
 */
export function mayRenderSubmit(gate: SubmissionGate): boolean {
  return gate.kind !== 'blocked';
}

/**
 * A degraded evaluation is never silence.
 *
 * EN-029 §5: an engine error that prevents a family from evaluating is recorded
 * and **visible**, and the product fails closed on the floor families. The
 * banner text is the screen's, but the decision that there must be one is here.
 */
export function degradedNotice(evaluation: EvaluationView | null): string | null {
  if (evaluation === null || !evaluation.degraded) return null;
  const families = evaluation.degradedFamilies.join(', ');
  return families === ''
    ? 'Some safety checks did not run. Treat this prescription as unchecked.'
    : `Some safety checks did not run: ${families}. Treat those as unchecked.`;
}

/** Human-facing names for the rule families, so a chip never reads `dose_range`. */
export const FAMILY_LABELS: Readonly<Record<string, string>> = {
  allergy: 'Allergy',
  ddi: 'Drug interaction',
  drug_disease: 'Drug–disease',
  duplicate_therapy: 'Duplicate therapy',
  dose_range: 'Dose range',
  pregnancy: 'Pregnancy',
  geriatric: 'Geriatric caution',
  paediatric_weight: 'Paediatric weight',
  schedule_guardrail: 'Schedule guardrail',
};

export function familyLabel(family: string): string {
  return FAMILY_LABELS[family] ?? family;
}
