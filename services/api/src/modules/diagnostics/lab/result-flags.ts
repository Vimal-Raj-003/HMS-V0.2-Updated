/**
 * OP-004 §3.3.3 — the interpretation of a measured value: the flag, the panic
 * bound, the absurd bound and the delta check.
 *
 * Pure, and separate from the service, for one reason: this is the code that
 * decides whether a potassium of 6.8 starts a phone call. It has to be testable
 * without a database, a request or a tenant, and it has to be readable by
 * somebody who knows laboratories and not TypeScript.
 *
 * ── Where the boundaries fall, and why ──────────────────────────────────────
 *
 * A panic bound is **inclusive**: a potassium exactly on the critical-high
 * limit is critical. The normal band is **exclusive**: a value exactly on the
 * upper limit of normal is normal. Both choices push a borderline value towards
 * the safer answer, which is the only defensible direction for a rule whose
 * false negative is an unreported panic value.
 *
 * ── Absurd is not abnormal ──────────────────────────────────────────────────
 *
 * `mdm_lab_tests.absurd_low/high` bound what is physically possible, not what is
 * healthy. A sodium of 1400 is a decimal point in the wrong place; flagging it
 * critical would send somebody running to a bedside for a typing error, so it is
 * refused at entry instead. That is a different decision from the panic bounds
 * and it is deliberately a different pair of columns.
 */

export type ResultFlag =
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
  | 'indeterminate';

export interface ReferenceInterval {
  readonly low: number | null;
  readonly high: number | null;
  readonly criticalLow: number | null;
  readonly criticalHigh: number | null;
  readonly textNormal: string | null;
  readonly criticalCodedValues: readonly string[];
}

export const NO_INTERVAL: ReferenceInterval = {
  low: null,
  high: null,
  criticalLow: null,
  criticalHigh: null,
  textNormal: null,
  criticalCodedValues: [],
};

/** Exactly the two flags `lab_result_versions_critical_agrees` calls critical. */
export function isCriticalFlag(flag: ResultFlag): boolean {
  return flag === 'critical_low' || flag === 'critical_high';
}

export function flagNumeric(value: number, interval: ReferenceInterval): ResultFlag {
  if (interval.criticalLow !== null && value <= interval.criticalLow) return 'critical_low';
  if (interval.criticalHigh !== null && value >= interval.criticalHigh) return 'critical_high';
  if (interval.low !== null && value < interval.low) return 'low';
  if (interval.high !== null && value > interval.high) return 'high';
  return 'normal';
}

/**
 * A coded answer — "Reactive", "Growth of E. coli", "Detected".
 *
 * A coded critical is reported as `critical_high` rather than as a flag of its
 * own. That is not a modelling accident: `lab_result_versions_critical_agrees`
 * makes `is_critical` true for exactly `critical_low` and `critical_high`, and
 * the alert trigger fires on `is_critical`. Inventing a third critical flag
 * would mean a reactive HIV screen that raises no alert, which is the failure
 * this whole phase exists to prevent. The direction is meaningless for a coded
 * value; the obligation to telephone somebody is not.
 */
export function flagCoded(value: string, interval: ReferenceInterval): ResultFlag {
  const normalised = value.trim().toLowerCase();
  if (interval.criticalCodedValues.some((c) => c.trim().toLowerCase() === normalised)) {
    return 'critical_high';
  }
  if (interval.textNormal !== null && interval.textNormal.trim().toLowerCase() === normalised) {
    return 'normal';
  }
  if (interval.textNormal !== null) return 'abnormal';
  return 'indeterminate';
}

export interface AbsurdBounds {
  readonly absurdLow: number | null;
  readonly absurdHigh: number | null;
}

export function isAbsurd(value: number, bounds: AbsurdBounds): boolean {
  if (bounds.absurdLow !== null && value < bounds.absurdLow) return true;
  if (bounds.absurdHigh !== null && value > bounds.absurdHigh) return true;
  return false;
}

export interface DeltaRule {
  /** `absolute` | `percent` | `rate_per_hour`. */
  readonly mode: string;
  readonly threshold: number;
  readonly action: string;
}

export interface DeltaPrevious {
  readonly value: number;
  readonly hoursAgo: number;
}

/**
 * `OP-004 §3.3.3` — "delta check uses last final result of same test for patient
 * within window". Returns whether the rule fired; the *window* is applied by the
 * query that finds the previous value, because a rule cannot look one up.
 */
export function deltaBreached(value: number, previous: DeltaPrevious, rule: DeltaRule): boolean {
  const difference = Math.abs(value - previous.value);
  switch (rule.mode) {
    case 'absolute':
      return difference >= rule.threshold;
    case 'percent': {
      // A previous value of zero has no meaningful percentage change. Treating
      // it as an infinite one would flag every follow-up of a zero, and a flag
      // that always fires is a flag nobody reads.
      if (previous.value === 0) return false;
      return (difference / Math.abs(previous.value)) * 100 >= rule.threshold;
    }
    case 'rate_per_hour': {
      if (previous.hoursAgo <= 0) return false;
      return difference / previous.hoursAgo >= rule.threshold;
    }
    default:
      // An unrecognised mode is a configuration error, and the safe reading of
      // a rule nobody can evaluate is that it did not fire — the value is still
      // stored, still flagged against its reference interval, and still visible.
      return false;
  }
}

/** `lab.result.final` carries a narrower flag vocabulary than the column does. */
export function toEventFlag(
  flag: ResultFlag,
): 'normal' | 'low' | 'high' | 'critical_low' | 'critical_high' | 'abnormal' {
  switch (flag) {
    case 'normal':
    case 'low':
    case 'high':
    case 'critical_low':
    case 'critical_high':
      return flag;
    case 'abnormal':
    case 'positive':
    case 'negative':
    case 'reactive':
    case 'non_reactive':
    case 'indeterminate':
      // The event vocabulary is narrower than the column's on purpose: a
      // consumer building an ABDM DiagnosticReport needs "is this outside the
      // interval", not the laboratory's full flag set.
      return 'abnormal';
  }
}
