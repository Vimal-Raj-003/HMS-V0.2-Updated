import { cn } from '../lib/cn.js';

/**
 * `ResultFlag` — docs/06 §5.2 #6: "`value, unit, refLow, refHigh, flag, delta,
 * corrected`. Glyph + letter + colour + tabular numerals; critical adds a left
 * rule and `aria-live="assertive"` on first render in an inbox."
 *
 * The whole point of this component is that **colour is never the signal**.
 * §3.5 opens the result-flag table with "Glyph is mandatory", and the reason is
 * not only colour blindness: a lab result is printed, faxed, photocopied, read
 * on a ten-year-old ward monitor with the contrast wound down, and shoulder-read
 * from two metres away. So every state carries three redundant encodings — a
 * glyph (`▲▲`), a letter (`HH`), and a colour — and the first two survive all of
 * those journeys.
 *
 * The flag vocabulary is `ResultFlag` from
 * `services/api/src/modules/diagnostics/lab/result-flags.ts`, not a UI-local
 * enum. A component that invented its own list would drift from the values the
 * database actually stores, and the drift would show up as a silently unstyled
 * result rather than as a type error.
 */

/** Exactly the union the API stores. Keep in lockstep with `result-flags.ts`. */
export type ResultFlagKind =
  | 'normal'
  | 'low'
  | 'high'
  | 'critical_low'
  | 'critical_high'
  | 'abnormal'
  | 'positive'
  | 'negative'
  | 'reactive'
  | 'non_reactive'
  | 'indeterminate'
  | 'pending';

interface FlagPresentation {
  /** Mandatory (§3.5). Never rendered alone, never omitted. */
  readonly glyph: string;
  /** The letter a lab report has used for fifty years. */
  readonly letter: string;
  readonly className: string;
  /** §5.2 #6 — critical adds a left rule. */
  readonly critical: boolean;
}

const PRESENTATION: Record<ResultFlagKind, FlagPresentation> = {
  normal: { glyph: '—', letter: '', className: 'text-flag-normal', critical: false },
  low: { glyph: '▼', letter: 'L', className: 'text-flag-low', critical: false },
  high: { glyph: '▲', letter: 'H', className: 'text-flag-high', critical: false },
  critical_low: { glyph: '▼▼', letter: 'LL', className: 'text-flag-critical-low', critical: true },
  critical_high: { glyph: '▲▲', letter: 'HH', className: 'text-flag-critical-high', critical: true },
  abnormal: { glyph: '◆', letter: 'A', className: 'text-flag-abnormal', critical: false },
  // The qualitative results. `positive` and `reactive` are abnormal findings and
  // take the abnormal treatment; their negatives are not "normal" in the
  // reference-interval sense but read the same way on a report.
  positive: { glyph: '◆', letter: 'POS', className: 'text-flag-abnormal', critical: false },
  reactive: { glyph: '◆', letter: 'REAC', className: 'text-flag-abnormal', critical: false },
  negative: { glyph: '—', letter: 'NEG', className: 'text-flag-normal', critical: false },
  non_reactive: { glyph: '—', letter: 'NR', className: 'text-flag-normal', critical: false },
  // Not a result. Rendering it as normal would be a lie a clinician acts on.
  indeterminate: { glyph: '?', letter: 'IND', className: 'text-flag-abnormal', critical: false },
  pending: { glyph: '…', letter: '', className: 'text-flag-pending', critical: false },
};

export interface ResultFlagLabels {
  /** e.g. "critically high" — read out by screen readers in place of "▲▲ HH". */
  readonly flag: string;
  /** e.g. "reference 3.5 – 5.1 mmol/L". Already localised and formatted. */
  readonly referenceRange?: string;
  /** e.g. "up 1.2 since 14 Feb". */
  readonly delta?: string;
  /** e.g. "corrected — previously 4.1". */
  readonly corrected?: string;
}

export interface ResultFlagProps {
  /**
   * The result as it should read, already formatted. A number is deliberately
   * not accepted: significant figures are a property of the analyte and the
   * analyser (a potassium is 2 dp, a WBC is 1), and a component that formatted
   * them would be guessing.
   */
  readonly value: string;
  readonly unit?: string;
  readonly flag: ResultFlagKind;
  /** Shown struck through when the result supersedes one (§3.5 `--flag-corrected`). */
  readonly previousValue?: string;
  readonly labels: ResultFlagLabels;
  /**
   * §5.2 #6 — "`aria-live="assertive"` on first render in an inbox". Off by
   * default: a table of forty results that all announce themselves announces
   * nothing. The inbox opts in for the row that has just arrived.
   */
  readonly announce?: boolean;
  readonly className?: string;
}

export function ResultFlag({
  value,
  unit,
  flag,
  previousValue,
  labels,
  announce = false,
  className,
}: ResultFlagProps): React.JSX.Element {
  const presentation = PRESENTATION[flag];

  return (
    <span
      data-slot="result-flag"
      data-flag={flag}
      data-critical={presentation.critical ? 'true' : undefined}
      // A critical value is the one thing on a results screen that may
      // interrupt; everything else is read on demand.
      {...(announce && presentation.critical
        ? { role: 'alert' as const, 'aria-live': 'assertive' as const }
        : {})}
      className={cn(
        'inline-flex items-baseline gap-1.5 font-mono tabular-nums slashed-zero',
        // §5.2 #6 — the left rule, and it is a rule rather than a tinted row:
        // §2.1 reserves row backgrounds so that a dense table stays readable.
        presentation.critical && 'border-l-[3px] border-current pl-2 font-bold',
        presentation.className,
        className,
      )}
    >
      {previousValue === undefined ? null : (
        <span className="text-fg-subtle line-through" aria-hidden="true">
          {previousValue}
        </span>
      )}

      <span className="text-fg-default">{value}</span>
      {unit === undefined ? null : <span className="text-fg-muted text-2xs">{unit}</span>}

      {/*
        The glyph and the letter are decorative *to a screen reader* — it is
        given the words in `labels.flag` instead, because "▲▲ HH" read aloud is
        noise. They are the primary signal to everyone else.
      */}
      <span aria-hidden="true" className="font-semibold">
        {presentation.glyph}
        {presentation.letter === '' ? '' : ` ${presentation.letter}`}
      </span>

      <span className="sr-only">
        {labels.flag}
        {labels.referenceRange === undefined ? '' : `. ${labels.referenceRange}`}
        {labels.delta === undefined ? '' : `. ${labels.delta}`}
        {labels.corrected === undefined ? '' : `. ${labels.corrected}`}
      </span>
    </span>
  );
}

/** The presentation table, exported so `ResultTable` renders identical glyphs. */
export function resultFlagPresentation(flag: ResultFlagKind): FlagPresentation {
  return PRESENTATION[flag];
}
