/**
 * OP-007 §5 — the age/sex/pregnancy-aware abnormal and critical bands, applied.
 *
 * **Nothing in this file contains a threshold.** Every number comes from
 * `clinical.vitals_reference_ranges`, which is hospital-configurable and
 * effective-dated, which is what "abnormal/critical thresholds by
 * age/sex/pregnancy from EN-029 effective-dated ranges" means. A threshold
 * compiled into the API is a threshold a hospital cannot change without a
 * release, and OP-007 §16 Q3 says hospitals will change them.
 *
 * **The band convention, stated once.** A row carries four optional bounds:
 * `low_plausible/high_plausible`, `low_abnormal/high_abnormal` and
 * `low_critical/high_critical`. They are *bounds of an acceptable band*, nested
 * outwards — which is exactly what the migration's `vitals_reference_ranges_band_order`
 * CHECK enforces (`low_critical <= low_abnormal`, `high_critical >= high_abnormal`).
 * So:
 *
 *   value outside [low_plausible, high_plausible]  → not a finding, a typo: refused
 *   value outside [low_critical,  high_critical]   → critical
 *   value outside [low_abnormal,  high_abnormal]   → abnormal
 *   otherwise                                      → normal
 *
 * Bounds are inclusive: a value *equal* to a bound is inside the band. The
 * OP-007 §5.1 table is inconsistent about its own boundaries ("< 100 or ≥ 140"
 * for systolic versus "< 60 or > 100" for pulse), so one convention is chosen
 * and applied everywhere rather than reproducing the inconsistency.
 */

export type VitalFlag = 'normal' | 'abnormal' | 'critical';

/** A reference row, with its decimals already parsed out of `pg`'s strings. */
export interface ReferenceRange {
  readonly id: string;
  readonly parameter: string;
  readonly ageMinDays: number;
  readonly ageMaxDays: number;
  /** `any`, or a specific `patient.PatientGender` value. */
  readonly sex: string;
  /** `null` when the row does not vary by pregnancy status. */
  readonly pregnancy: string | null;
  /** SpO2 scale 1 (default) or 2 (hypercapnic COPD). `null` for every other parameter. */
  readonly scale: number | null;
  readonly lowAbnormal: number | null;
  readonly highAbnormal: number | null;
  readonly lowCritical: number | null;
  readonly highCritical: number | null;
  readonly lowPlausible: number | null;
  readonly highPlausible: number | null;
  readonly unit: string;
}

/** Everything about the patient that can move a band. */
export interface RangeSubject {
  /** `null` when the date of birth is unknown; no age band can then be chosen. */
  readonly ageDays: number | null;
  readonly sex: string;
  readonly pregnancy: string;
  /** Set by a doctor. Switches SpO2 to the RCP scale-2 target band. */
  readonly copdScale2: boolean;
}

/** One measured value, named by the reference-range `parameter` it is scored against. */
export interface Reading {
  readonly parameter: string;
  readonly value: number;
}

export interface RangeEvaluation {
  /** `{parameter: verdict}` — what lands in `clinical.vitals.flags`. */
  readonly flags: Readonly<Record<string, VitalFlag>>;
  readonly overall: VitalFlag;
  /** Parameters at each level, in reading order, for the alert row and its event. */
  readonly abnormal: readonly string[];
  readonly critical: readonly string[];
}

export interface PlausibilityBreach {
  readonly parameter: string;
  readonly value: number;
  readonly low: number | null;
  readonly high: number | null;
  readonly unit: string;
}

/** The scale a parameter is scored on for this patient. Only SpO2 has two. */
function scaleFor(parameter: string, subject: RangeSubject): number {
  return parameter === 'spo2' && subject.copdScale2 ? 2 : 1;
}

/**
 * The most specific active range for one parameter and one patient.
 *
 * Specificity is ordered deliberately: a row that names the patient's sex beats
 * one that says `any`, a row that names their pregnancy status beats one that
 * says nothing, and between two rows that tie, the **narrower age band** wins —
 * because a neonatal row and an all-ages row both match a two-day-old, and the
 * neonatal one is the one that means something. `id` is the final tie-break so
 * the choice is deterministic rather than dependent on row order.
 *
 * Returns `null` when nothing matches, which is not an error: a hospital that
 * has not configured a band for head circumference simply does not flag it.
 */
export function selectRange(
  ranges: readonly ReferenceRange[],
  parameter: string,
  subject: RangeSubject,
): ReferenceRange | null {
  const { ageDays } = subject;
  if (ageDays === null) return null;

  const scale = scaleFor(parameter, subject);
  let best: ReferenceRange | null = null;
  let bestScore = -1;
  let bestSpan = Number.POSITIVE_INFINITY;

  for (const range of ranges) {
    if (range.parameter !== parameter) continue;
    if ((range.scale ?? 1) !== scale) continue;
    if (ageDays < range.ageMinDays || ageDays > range.ageMaxDays) continue;
    if (range.sex !== 'any' && range.sex !== subject.sex) continue;
    if (range.pregnancy !== null && range.pregnancy !== subject.pregnancy) continue;

    const score = (range.sex === 'any' ? 0 : 4) + (range.pregnancy === null ? 0 : 2);
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

/** One value against one band. See the header for the convention. */
export function flagValue(range: ReferenceRange, value: number): VitalFlag {
  if (range.lowCritical !== null && value < range.lowCritical) return 'critical';
  if (range.highCritical !== null && value > range.highCritical) return 'critical';
  if (range.lowAbnormal !== null && value < range.lowAbnormal) return 'abnormal';
  if (range.highAbnormal !== null && value > range.highAbnormal) return 'abnormal';
  return 'normal';
}

const SEVERITY: Readonly<Record<VitalFlag, number>> = { normal: 0, abnormal: 1, critical: 2 };

/**
 * Scores every reading that has a band, and returns the per-parameter verdicts
 * plus the worst of them.
 *
 * A reading with no configured band contributes nothing — neither a flag nor a
 * reassurance. Recording it as `normal` would be a claim the hospital never
 * made.
 */
export function evaluateReadings(
  ranges: readonly ReferenceRange[],
  readings: readonly Reading[],
  subject: RangeSubject,
): RangeEvaluation {
  const flags: Record<string, VitalFlag> = {};
  const abnormal: string[] = [];
  const critical: string[] = [];
  let overall: VitalFlag = 'normal';

  for (const reading of readings) {
    const range = selectRange(ranges, reading.parameter, subject);
    if (range === null) continue;

    const flag = flagValue(range, reading.value);
    flags[reading.parameter] = flag;
    if (flag === 'critical') critical.push(reading.parameter);
    else if (flag === 'abnormal') abnormal.push(reading.parameter);
    if (SEVERITY[flag] > SEVERITY[overall]) overall = flag;
  }

  return { flags, overall, abnormal, critical };
}

/**
 * OP-007 §5: "plausibility ranges block impossible values".
 *
 * Separate from flagging, and checked first, because an implausible value is not
 * a finding — it is a typo, and a typo that reaches the NEWS2 calculation
 * produces a score that sends a well patient to the ER or keeps a sick one out
 * of it. The database enforces a hard floor of its own; this returns the
 * hospital-configured bound so the message can name it.
 */
export function checkPlausibility(
  ranges: readonly ReferenceRange[],
  readings: readonly Reading[],
  subject: RangeSubject,
): readonly PlausibilityBreach[] {
  const breaches: PlausibilityBreach[] = [];

  for (const reading of readings) {
    const range = selectRange(ranges, reading.parameter, subject);
    if (range === null) continue;
    const { lowPlausible: low, highPlausible: high } = range;
    if ((low !== null && reading.value < low) || (high !== null && reading.value > high)) {
      breaches.push({
        parameter: reading.parameter,
        value: reading.value,
        low,
        high,
        unit: range.unit,
      });
    }
  }

  return breaches;
}
