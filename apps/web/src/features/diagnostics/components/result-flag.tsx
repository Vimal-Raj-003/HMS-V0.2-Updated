'use client';

import { cn } from '@vims/ui';
import { formatInterval, formatResultValue, presentFlag } from '../lib/result-flags';
import type { LabResultView } from '../api/types';

/**
 * `docs/06` §5.2 #6 `ResultFlag` — a value, its unit, its reference interval and
 * the laboratory's verdict on it.
 *
 * The contract from the design system, kept literally:
 *
 *  - **glyph + letter + colour + tabular numerals.** OP-004 §13 and `docs/06`
 *    §10 both forbid colour as the only signal; a red number beside a potassium
 *    is invisible to eight per cent of male technologists.
 *  - **critical adds a left rule** rather than a row background, so a dense
 *    worklist does not become a wall of red.
 *  - **`aria-live="assertive"` on first render in an inbox.** A critical value
 *    that appears silently in a list a screen-reader user has already read past
 *    is a critical value nobody saw.
 *
 * A delta flag is rendered beside the verdict rather than instead of it: OP-004
 * §3.3.3 makes the delta an independent signal, and a result can be perfectly
 * in range and still have moved further in six hours than a body does.
 */
export function ResultFlagCell({
  result,
  announce = false,
}: {
  readonly result: LabResultView;
  /** True in an inbox context, where a newly arrived critical must be spoken. */
  readonly announce?: boolean;
}): React.JSX.Element {
  const flag = presentFlag(result.current_flag);
  const interval = formatInterval(result.ref_low, result.ref_high, result.unit);
  const value = formatResultValue(result);

  return (
    <div
      data-testid={`result-${result.id}`}
      data-flag={result.current_flag ?? 'none'}
      className={cn('flex flex-col gap-0.5 ps-2', flag.critical && 'border-s-[3px] border-danger-border')}
      {...(announce && flag.critical ? { role: 'alert' as const, 'aria-live': 'assertive' as const } : {})}
    >
      <span className="flex items-baseline gap-2">
        <span className="font-mono text-md font-medium tabular-nums text-fg-default">{value}</span>
        <span className={cn('font-mono text-xs font-medium', flag.toneClass)} data-testid="flag-code">
          <span aria-hidden="true">{flag.glyph} </span>
          {flag.code}
        </span>
        <span className="sr-only">{flag.label}</span>
        {result.delta_flagged ? (
          <span className="font-mono text-2xs text-flag-delta" data-testid="delta-flag">
            <span aria-hidden="true">Δ </span>
            <span className="sr-only">Delta check flagged: </span>changed sharply from the previous result
          </span>
        ) : null}
        {result.current_status === 'amended' ? (
          <span className="font-mono text-2xs text-flag-corrected" data-testid="amended-flag">
            <span aria-hidden="true">✎ </span>amended v{result.current_version}
          </span>
        ) : null}
      </span>
      <span className="text-2xs text-fg-subtle">
        {interval === null ? 'No reference interval configured for this analyte' : `Reference ${interval}`}
      </span>
    </div>
  );
}

/**
 * The same verdict as a bare chip, for a worklist cell where the value is in its
 * own column.
 */
export function FlagChip({ flag }: { readonly flag: string | null }): React.JSX.Element {
  const presentation = presentFlag(flag);
  return (
    <span
      data-testid="flag-chip"
      data-flag={flag ?? 'none'}
      className={cn('font-mono text-xs font-medium', presentation.toneClass)}
      title={presentation.label}
    >
      <span aria-hidden="true">{presentation.glyph} </span>
      {presentation.code}
      <span className="sr-only"> — {presentation.label}</span>
    </span>
  );
}
