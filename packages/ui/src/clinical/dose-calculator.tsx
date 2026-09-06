import { Scale, TriangleAlert } from 'lucide-react';
import { cn } from '../lib/cn.js';

/**
 * `DoseCalculator` — docs/06 §5.2 #18: "mg/kg (+ BSA for oncology), age/weight/
 * eGFR inputs pulled from the chart, max-dose ceiling, rounding to available
 * strengths, **shows the arithmetic** ('12 kg × 15 mg/kg = 180 mg → 5 mL of
 * 250 mg/5 mL'). Blocks > 200 % ceiling. **Missing weight = blocking empty
 * state, not a silent default.**"
 *
 * Two of those clauses are the component; the rest is layout.
 *
 * **Showing the arithmetic** is what makes the result checkable. A box that
 * prints "180 mg" asks a prescriber to trust it; one that prints
 * `12 kg × 15 mg/kg = 180 mg` lets them catch the decimal point that a tired
 * person, or this code, put in the wrong place. That is why `Calculation` is a
 * structure rather than a number — the steps are data, and they are rendered.
 *
 * **Missing weight blocks.** `prescription_items` already refuses a `per_kg`
 * line without a positive `weight_used_kg` (Phase 2 exit gate 3, met at the
 * storage layer), so a UI that quietly assumed 70 kg would be writing a row the
 * database would reject — or worse, one it would accept for an adult default on
 * a child. The weight is therefore a discriminated union, and the "no weight"
 * arm has no dose to render at all.
 */

export type PatientWeight =
  /** §5.2 #18's blocking empty state. There is no dose without a weight. */
  | { readonly kind: 'not-recorded' }
  | { readonly kind: 'recorded'; readonly kg: number; readonly measuredAt: string };

export interface DoseStep {
  /** e.g. "12 kg × 15 mg/kg". Rendered verbatim in mono. */
  readonly expression: string;
  /** e.g. "180 mg". */
  readonly result: string;
  /** Optional note, e.g. "rounded to the nearest 5 mg". */
  readonly note?: string;
}

export type DoseOutcome =
  | {
      readonly kind: 'calculated';
      readonly steps: readonly DoseStep[];
      /** The dose to prescribe, formatted with its unit. */
      readonly dose: string;
      /** How to give it — "5 mL of 250 mg/5 mL". */
      readonly administration?: string;
      /** Fraction of the maximum. 1.0 is the ceiling; > 2.0 is refused. */
      readonly fractionOfCeiling: number;
    }
  /**
   * §5.2 #18 — "Blocks > 200 % ceiling". A refusal, not a warning: the caller
   * gets no dose to submit.
   */
  | {
      readonly kind: 'over-ceiling';
      readonly steps: readonly DoseStep[];
      readonly attempted: string;
      readonly ceiling: string;
      readonly fractionOfCeiling: number;
    };

export interface DoseCalculatorLabels {
  readonly heading: string;
  /** e.g. "Weight not recorded". */
  readonly weightMissing: string;
  /** The way out of the blocking state, e.g. "Record a weight in the vitals room." */
  readonly weightMissingAction: string;
  /** e.g. "Weight" — precedes "12 kg, measured 2 h ago". */
  readonly weight: string;
  readonly measuredAt: string;
  readonly dose: string;
  readonly administration: string;
  /** e.g. "Above the maximum dose". */
  readonly overCeiling: string;
  /** e.g. "Maximum". */
  readonly ceiling: string;
  /** e.g. "attempted". */
  readonly attempted: string;
  /** e.g. "of the maximum dose" — follows a percentage. */
  readonly ofCeiling: string;
  /** Warning shown between 100% and 200%, e.g. "Above the usual maximum — confirm." */
  readonly nearCeiling?: string;
}

export interface DoseCalculatorProps {
  readonly weight: PatientWeight;
  /** Omitted while the weight is missing — there is nothing to calculate. */
  readonly outcome?: DoseOutcome;
  readonly labels: DoseCalculatorLabels;
  readonly className?: string;
}

export function DoseCalculator({
  weight,
  outcome,
  labels,
  className,
}: DoseCalculatorProps): React.JSX.Element {
  if (weight.kind === 'not-recorded') {
    return (
      <section
        data-slot="dose-calculator"
        data-state="weight-missing"
        aria-label={labels.heading}
        className={cn(
          'border-warning-border bg-warning-surface flex items-start gap-2.5 rounded-lg border p-3',
          className,
        )}
      >
        <Scale aria-hidden="true" className="text-warning-on-surface mt-0.5 size-4 shrink-0" />
        <div>
          <p className="text-warning-on-surface m-0 text-sm font-medium">{labels.weightMissing}</p>
          {/*
            A next action, not an apology. §5.2 #36's rule for empty states
            applies here too: this is the most consequential empty state in the
            product, because the alternative to blocking is a guessed weight.
          */}
          <p className="text-warning-on-surface m-0 mt-0.5 text-xs">{labels.weightMissingAction}</p>
        </div>
      </section>
    );
  }

  const over = outcome?.kind === 'over-ceiling';
  const near =
    outcome?.kind === 'calculated' && outcome.fractionOfCeiling > 1 && labels.nearCeiling !== undefined;

  return (
    <section
      data-slot="dose-calculator"
      data-state={over ? 'over-ceiling' : near ? 'near-ceiling' : 'calculated'}
      aria-label={labels.heading}
      className={cn(
        'rounded-lg border p-3',
        over ? 'border-danger-border bg-danger-surface' : 'border-default bg-layer-1',
        className,
      )}
    >
      <p className="text-fg-muted m-0 flex items-baseline gap-1.5 text-xs">
        <span className="text-fg-subtle">{labels.weight}</span>
        <span className="text-fg-default font-mono font-medium tabular-nums slashed-zero">
          {weight.kg} kg
        </span>
        <span className="text-fg-subtle">
          {labels.measuredAt} {weight.measuredAt}
        </span>
      </p>

      {outcome === undefined ? null : (
        <>
          {/*
            The arithmetic, in mono, one step per line. This is the part §5.2 #18
            asks for by name and the part that is usually dropped.
          */}
          <ol className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
            {outcome.steps.map((step) => (
              <li
                key={step.expression}
                className="text-fg-default flex flex-wrap items-baseline gap-1.5 font-mono text-xs tabular-nums slashed-zero"
              >
                <span className="text-fg-muted">{step.expression}</span>
                <span aria-hidden="true" className="text-fg-subtle">
                  =
                </span>
                <span className="font-semibold">{step.result}</span>
                {step.note === undefined ? null : (
                  <span className="text-fg-subtle font-sans">({step.note})</span>
                )}
              </li>
            ))}
          </ol>

          {outcome.kind === 'calculated' ? (
            <div className="border-default mt-2.5 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t pt-2.5">
              <span className="flex items-baseline gap-1.5">
                <span className="text-fg-subtle text-xs">{labels.dose}</span>
                <span className="text-fg-default font-mono text-lg font-semibold tabular-nums slashed-zero">
                  {outcome.dose}
                </span>
              </span>
              {outcome.administration === undefined ? null : (
                <span className="flex items-baseline gap-1.5">
                  <span className="text-fg-subtle text-xs">{labels.administration}</span>
                  <span className="text-fg-default font-mono text-sm tabular-nums slashed-zero">
                    {outcome.administration}
                  </span>
                </span>
              )}
            </div>
          ) : (
            <div className="border-danger-border mt-2.5 border-t pt-2.5">
              <p className="text-danger-on-surface m-0 flex items-center gap-1.5 text-sm font-semibold">
                <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
                {labels.overCeiling}
              </p>
              <p className="text-danger-on-surface m-0 mt-1 font-mono text-xs tabular-nums slashed-zero">
                {labels.attempted} {outcome.attempted} · {labels.ceiling} {outcome.ceiling} ·{' '}
                {Math.round(outcome.fractionOfCeiling * 100)}% {labels.ofCeiling}
              </p>
            </div>
          )}

          {near && labels.nearCeiling !== undefined ? (
            <p
              role="status"
              className="border-warning-border bg-warning-surface text-warning-on-surface m-0 mt-2 rounded-md border px-2 py-1.5 text-xs"
            >
              {labels.nearCeiling}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
