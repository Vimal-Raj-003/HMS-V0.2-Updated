import type { ReferenceRangeRow, VitalFlag } from '../api/types';
import { toNumber } from './numbers';

/**
 * OP-007 §5 — the configured abnormal and critical bands, applied in the browser
 * so the nurse sees a colour as they type rather than after they save.
 *
 * **There is not a single threshold in this file, and there must never be one.**
 * Every bound comes from `clinical.vitals_reference_ranges` through
 * `GET /vitals/reference-ranges`. A threshold compiled into the client is a
 * threshold a hospital cannot change without a release, and OP-007 §16 Q3 says
 * hospitals will change them. It is also a threshold that can silently disagree
 * with the server's — and the server's is the one that raises the alert and
 * pages the doctor.
 *
 * The band convention is the API's, restated so the two cannot drift
 * (`services/api/src/modules/opd/clinical/vitals.ranges.ts`):
 *
 *   value outside [low_plausible, high_plausible]  → not a finding, a typo
 *   value outside [low_critical,  high_critical]   → critical
 *   value outside [low_abnormal,  high_abnormal]   → abnormal
 *   otherwise                                      → normal
 *
 * Bounds are **inclusive**: a value equal to a bound is inside the band.
 *
 * What the client computes is a *preview*. The record the API writes back
 * carries `flags` and `overall_flag` computed server-side against the same
 * table, and those are what the screen shows once a reading is saved. If the two
 * ever disagree, the server wins and the screen says so; that is why
 * `previewFlags` is only ever rendered on unsaved input.
 */

export interface ParsedRange {
  readonly id: string;
  readonly parameter: string;
  readonly ageMinDays: number;
  readonly ageMaxDays: number;
  readonly sex: string;
  readonly pregnancy: string | null;
  readonly scale: number | null;
  readonly lowAbnormal: number | null;
  readonly highAbnormal: number | null;
  readonly lowCritical: number | null;
  readonly highCritical: number | null;
  readonly lowPlausible: number | null;
  readonly highPlausible: number | null;
  readonly unit: string;
}

export interface RangeSubject {
  /** `null` when the date of birth is unknown; no age band can then be chosen. */
  readonly ageDays: number | null;
  readonly sex: string;
  readonly pregnancy: string;
  /** Doctor-set hypercapnic-COPD flag; switches SpO2 to the scale-2 target band. */
  readonly copdScale2: boolean;
}

/**
 * Rows the API returns as `Record<string, unknown>`, narrowed.
 *
 * A row missing its parameter or its age bounds is **dropped**, not defaulted. A
 * half-parsed band would produce a confident colour from an unknown rule, and a
 * missing band produces no colour at all — which is honest, and which the screen
 * says out loud.
 */
export function parseRanges(rows: readonly ReferenceRangeRow[]): readonly ParsedRange[] {
  const parsed: ParsedRange[] = [];
  for (const row of rows) {
    const ageMinDays = toNumber(row.age_min_days);
    const ageMaxDays = toNumber(row.age_max_days);
    if (typeof row.parameter !== 'string' || row.parameter === '') continue;
    if (ageMinDays === null || ageMaxDays === null) continue;
    parsed.push({
      id: row.id,
      parameter: row.parameter,
      ageMinDays,
      ageMaxDays,
      sex: row.sex,
      pregnancy: row.pregnancy,
      scale: toNumber(row.scale),
      lowAbnormal: toNumber(row.low_abnormal),
      highAbnormal: toNumber(row.high_abnormal),
      lowCritical: toNumber(row.low_critical),
      highCritical: toNumber(row.high_critical),
      lowPlausible: toNumber(row.low_plausible),
      highPlausible: toNumber(row.high_plausible),
      unit: typeof row.unit === 'string' ? row.unit : '',
    });
  }
  return parsed;
}

function scaleFor(parameter: string, subject: RangeSubject): number {
  return parameter === 'spo2' && subject.copdScale2 ? 2 : 1;
}

/**
 * The most specific active range for one parameter and one patient.
 *
 * The specificity order is the server's, deliberately: a row naming the
 * patient's sex beats one saying `any`, a row naming their pregnancy status
 * beats one saying nothing, and between two rows that tie the **narrower age
 * band** wins — a neonatal row and an all-ages row both match a two-day-old, and
 * the neonatal one is the one that means something. `id` is the final tie-break
 * so the choice is deterministic rather than dependent on row order.
 *
 * `null` is not an error: a hospital that has not configured a band for head
 * circumference simply does not flag it, and the screen shows the value with no
 * colour rather than a guess.
 */
export function selectRange(
  ranges: readonly ParsedRange[],
  parameter: string,
  subject: RangeSubject,
): ParsedRange | null {
  const { ageDays } = subject;
  if (ageDays === null) return null;

  const scale = scaleFor(parameter, subject);
  let best: ParsedRange | null = null;
  let bestScore = -1;
  let bestSpan = Number.POSITIVE_INFINITY;

  for (const range of ranges) {
    if (range.parameter !== parameter) continue;
    if ((range.scale ?? 1) !== scale) continue;
    if (ageDays < range.ageMinDays || ageDays > range.ageMaxDays) continue;
    if (range.sex !== 'any' && range.sex !== subject.sex) continue;
    if (range.pregnancy !== null && range.pregnancy !== subject.pregnancy) continue;

    const score = (range.sex === 'any' ? 0 : 2) + (range.pregnancy === null ? 0 : 1);
    const span = range.ageMaxDays - range.ageMinDays;
    if (score > bestScore || (score === bestScore && span < bestSpan)) {
      best = range;
      bestScore = score;
      bestSpan = span;
      continue;
    }
    if (score === bestScore && span === bestSpan && best !== null && range.id < best.id) {
      best = range;
    }
  }
  return best;
}

/** `null` when no band applies — which is "not scored", never "normal". */
export function flagFor(range: ParsedRange | null, value: number): VitalFlag | null {
  if (range === null) return null;
  if (range.lowCritical !== null && value < range.lowCritical) return 'critical';
  if (range.highCritical !== null && value > range.highCritical) return 'critical';
  if (range.lowAbnormal !== null && value < range.lowAbnormal) return 'abnormal';
  if (range.highAbnormal !== null && value > range.highAbnormal) return 'abnormal';
  return 'normal';
}

export interface PlausibilityBreach {
  readonly parameter: string;
  readonly value: number;
  readonly low: number | null;
  readonly high: number | null;
  readonly unit: string;
}

/**
 * A value outside the plausible band is a typing mistake, not a finding.
 *
 * The server refuses it. Saying so before the save is a courtesy, not a
 * substitute: this returns what to *tell* the nurse, and never decides on its
 * own that a value is acceptable.
 */
export function plausibilityBreach(
  range: ParsedRange | null,
  parameter: string,
  value: number,
): PlausibilityBreach | null {
  if (range === null) return null;
  const low = range.lowPlausible;
  const high = range.highPlausible;
  if ((low !== null && value < low) || (high !== null && value > high)) {
    return { parameter, value, low, high, unit: range.unit };
  }
  return null;
}

/** The worst of a set of verdicts. `null` (nothing scored) is not a verdict. */
export function worstFlag(flags: readonly (VitalFlag | null)[]): VitalFlag | null {
  if (flags.includes('critical')) return 'critical';
  if (flags.includes('abnormal')) return 'abnormal';
  if (flags.includes('normal')) return 'normal';
  return null;
}

/** Whole days between a date of birth and now — the only age arithmetic here. */
export function ageDaysAt(dob: string | null, now: Date): number | null {
  if (dob === null || dob === '') return null;
  const born = new Date(dob);
  if (Number.isNaN(born.getTime())) return null;
  const days = Math.floor((now.getTime() - born.getTime()) / 86_400_000);
  return days < 0 ? null : days;
}
