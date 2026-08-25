import type { LabResultFlag } from '../api/types';

/**
 * How a laboratory verdict is drawn.
 *
 * `docs/06` §3.5 fixes the tokens and the glyphs, and OP-004 §13 fixes the rule
 * that makes them necessary: **flags use colour *and* symbol, never colour
 * alone.** A red number beside a potassium is listed in `docs/06` §10 as a
 * defect, and it is the exact defect a colour-blind technologist on a bright
 * bench meets.
 *
 * Three properties of this module are load-bearing:
 *
 *  1. **It never computes a flag.** The flag is `current_flag` on the result the
 *     API wrote — the same value that decided whether a phone call happens. Two
 *     implementations of a panic bound that disagree by one decimal is how a
 *     critical potassium is drawn as merely high.
 *  2. **`null` is "not flagged", not "normal".** A result whose flag the API has
 *     not set renders as pending rather than as a green tick, because a green
 *     tick over an unflagged value is a lie the screen tells with confidence.
 *  3. **An unknown flag is rendered as unknown.** If the API grows a twelfth
 *     flag, this module shows the raw code rather than silently falling through
 *     to "normal".
 */

export interface FlagPresentation {
  /** The short letter code a laboratorian reads: `HH`, `L`, `A`, `R`. */
  readonly code: string;
  /** The glyph, so the state survives greyscale and colour blindness. */
  readonly glyph: string;
  /** Full words, for the accessible name and the tooltip. */
  readonly label: string;
  /** A Tailwind class bound to a `--flag-*` token. Never a raw colour. */
  readonly toneClass: string;
  /** Critical rows carry a 3 px left rule, never a row background (`docs/06` §9.A). */
  readonly critical: boolean;
}

const PRESENTATIONS: Readonly<Record<LabResultFlag, FlagPresentation>> = {
  normal: { code: '—', glyph: '—', label: 'Within range', toneClass: 'text-flag-normal', critical: false },
  low: { code: 'L', glyph: '▼', label: 'Low', toneClass: 'text-flag-low', critical: false },
  high: { code: 'H', glyph: '▲', label: 'High', toneClass: 'text-flag-high', critical: false },
  critical_low: {
    code: 'LL',
    glyph: '▼▼',
    label: 'Critical low — panic value',
    toneClass: 'text-flag-critical-low',
    critical: true,
  },
  critical_high: {
    code: 'HH',
    glyph: '▲▲',
    label: 'Critical high — panic value',
    toneClass: 'text-flag-critical-high',
    critical: true,
  },
  abnormal: { code: 'A', glyph: '◆', label: 'Abnormal', toneClass: 'text-flag-abnormal', critical: false },
  positive: { code: 'POS', glyph: '◆', label: 'Positive', toneClass: 'text-flag-abnormal', critical: false },
  negative: { code: 'NEG', glyph: '—', label: 'Negative', toneClass: 'text-flag-normal', critical: false },
  /**
   * A reactive screen is reported by the API as `critical_high` when the test's
   * critical coded values say so; `reactive` on its own is an abnormal result
   * that has not been declared a panic value for this laboratory.
   */
  reactive: {
    code: 'REACT',
    glyph: '◆',
    label: 'Reactive',
    toneClass: 'text-flag-abnormal',
    critical: false,
  },
  non_reactive: {
    code: 'NR',
    glyph: '—',
    label: 'Non-reactive',
    toneClass: 'text-flag-normal',
    critical: false,
  },
  indeterminate: {
    code: 'IND',
    glyph: '?',
    label: 'Indeterminate — repeat advised',
    toneClass: 'text-flag-abnormal',
    critical: false,
  },
};

const NOT_FLAGGED: FlagPresentation = {
  code: '…',
  glyph: '…',
  label: 'Not yet flagged',
  toneClass: 'text-flag-pending',
  critical: false,
};

export function presentFlag(flag: string | null): FlagPresentation {
  if (flag === null) return NOT_FLAGGED;
  const known = PRESENTATIONS[flag as LabResultFlag] as FlagPresentation | undefined;
  if (known !== undefined) return known;
  return {
    code: flag,
    glyph: '?',
    label: `Unrecognised flag "${flag}" — read the numeric value and the reference interval`,
    toneClass: 'text-flag-pending',
    critical: false,
  };
}

/**
 * Exactly the two flags `lab_result_versions_critical_agrees` calls critical.
 *
 * A coded panic value (a reactive HIV screen) is reported by the API as
 * `critical_high`, because the *direction* is meaningless for a coded value but
 * the obligation to telephone somebody is not. Adding a third critical flag here
 * would mean a reactive screen that raises no alert.
 */
export function isCriticalFlag(flag: string | null): boolean {
  return flag === 'critical_low' || flag === 'critical_high';
}

/**
 * The reference interval as a laboratorian writes it.
 *
 * Returns `null` rather than a guess when the API sent no interval: an empty
 * reference column is honest, and an invented `0–0` is not.
 */
export function formatInterval(low: number | null, high: number | null, unit: string | null): string | null {
  if (low === null && high === null) return null;
  const suffix = unit === null || unit === '' ? '' : ` ${unit}`;
  if (low !== null && high !== null) return `${low}–${high}${suffix}`;
  if (low !== null) return `≥ ${low}${suffix}`;
  return `≤ ${String(high)}${suffix}`;
}

/**
 * The value as it should be read aloud, operator and all.
 *
 * `<0.01` is a different clinical statement from `0.01`, and losing the operator
 * on the way to a screen turns an undetectable troponin into a measured one.
 */
export function formatResultValue(result: {
  readonly value_numeric: number | null;
  readonly value_operator: string | null;
  readonly value_coded: string | null;
  readonly value_multi: readonly string[];
  readonly value_text: string | null;
  readonly unit: string | null;
}): string {
  const unit = result.unit === null || result.unit === '' ? '' : ` ${result.unit}`;
  if (result.value_numeric !== null) {
    const operator = result.value_operator ?? '';
    return `${operator}${result.value_numeric}${unit}`;
  }
  if (result.value_coded !== null && result.value_coded !== '') return result.value_coded;
  if (result.value_multi.length > 0) return result.value_multi.join(', ');
  if (result.value_text !== null && result.value_text !== '') return result.value_text;
  return 'No value recorded';
}
