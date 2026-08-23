/**
 * EN-031 §3.2 — the Westgard multi-rules, as a pure function.
 *
 * `docs/prompts/phase-03` exit gate 4 is "a Westgard 1-3s violation blocks the
 * run and requires corrective action before results release", and the block
 * itself lives in the database — `lab.qc_permits_release()` refuses to release
 * an analyte whose state is `out_of_control`. What lives here is the *decision*
 * that puts it in that state, and it is separated from the service for the same
 * reason `result-flags.ts` is: it is a rule set a chemist can check, and a
 * chemist should not have to read a transaction to check it.
 *
 * ── Two properties worth naming ─────────────────────────────────────────────
 *
 * **A rule only rejects if the laboratory configured it to reject.** The
 * function returns which rules fired *and* whether any of the firing rules
 * carries the `reject` action; nothing here decides that 1-3s is a rejection.
 * `EN-031 §5` requires the rule set to be chosen per analyte against its
 * Six-Sigma figure, and a hard-coded rule set is a laboratory that cannot make
 * that choice.
 *
 * **1-2s can never be one.** The database refuses the configuration
 * (`labq_westgard_config_1_2s_is_warning`), because at two standard deviations
 * roughly one run in twenty fails by chance, and a laboratory that repeats one
 * run in twenty stops believing its own QC. This module does not re-check it —
 * one place to decide is the point — but it is why `action` is read from the
 * configuration rather than inferred from the rule code.
 */

export interface WestgardRuleConfig {
  /** A `lab."LabWestgardRule"` label: `r_1_3s`, `r_2_2s`, `r_10x`… */
  readonly ruleCode: string;
  readonly action: 'warning' | 'reject';
  readonly enabled: boolean;
}

export interface WestgardInput {
  /** The rules in force for this analyte × instrument. */
  readonly rules: readonly WestgardRuleConfig[];
  /**
   * Z-scores for this control level, **newest first**, with the run just
   * measured at index 0. Voided points are not in here — a voided point stays
   * on the chart but is not evidence.
   */
  readonly series: readonly number[];
  /**
   * Z-scores of the *other* control levels measured in the same run. R-4s and
   * 2of3-2s are within-run rules across levels, and evaluating them against one
   * level's history is the classic way to make them never fire.
   */
  readonly peers: readonly number[];
}

export interface WestgardOutcome {
  /** Every rule that fired, in configuration order. */
  readonly violated: readonly string[];
  /** True when at least one firing rule carries the `reject` action. */
  readonly rejected: boolean;
  /** True when something fired but nothing rejects — a flagged, releasable run. */
  readonly warned: boolean;
}

export function evaluateWestgard(input: WestgardInput): WestgardOutcome {
  const current = input.series[0];
  if (current === undefined) return { violated: [], rejected: false, warned: false };

  const run = [current, ...input.peers];
  const violated: string[] = [];
  let rejected = false;

  for (const rule of input.rules) {
    if (!rule.enabled) continue;
    if (!fires(rule.ruleCode, current, run, input.series)) continue;
    violated.push(rule.ruleCode);
    if (rule.action === 'reject') rejected = true;
  }

  return { violated, rejected, warned: violated.length > 0 && !rejected };
}

function fires(
  ruleCode: string,
  current: number,
  run: readonly number[],
  series: readonly number[],
): boolean {
  switch (ruleCode) {
    case 'r_1_2s':
      return Math.abs(current) >= 2;
    case 'r_1_3s':
      return Math.abs(current) >= 3;
    case 'r_2_2s':
      // Either the last two runs of this level, or two levels of this run.
      return consecutiveSameSideBeyond(series, 2, 2) || sameSideBeyondWithin(run, 2, 2);
    case 'r_R_4s':
      // A within-run range of four standard deviations: one level high and
      // another low is random error, and it does not need either point to be
      // outside its own limits.
      return range(run) >= 4;
    case 'r_3_1s':
      return consecutiveSameSideBeyond(series, 3, 1);
    case 'r_4_1s':
      return consecutiveSameSideBeyond(series, 4, 1);
    case 'r_2of3_2s':
      return sameSideBeyondWithin(run, 2, 2) || countSameSideBeyond(series.slice(0, 3), 2) >= 2;
    case 'r_6x':
      return consecutiveSameSide(series, 6);
    case 'r_8x':
      return consecutiveSameSide(series, 8);
    case 'r_9x':
      return consecutiveSameSide(series, 9);
    case 'r_10x':
      return consecutiveSameSide(series, 10);
    case 'r_12x':
      return consecutiveSameSide(series, 12);
    case 'r_7T':
      return trending(series, 7);
    default:
      // An unclassified rule code cannot be evaluated, and guessing would be
      // worse than not firing: a rule that fires for the wrong reason trains a
      // laboratory to ignore it. The migration's enum is the source of truth
      // and a new label arrives with a case here.
      return false;
  }
}

/** `n` consecutive points on the same side of the mean, each beyond `sd`. */
function consecutiveSameSideBeyond(series: readonly number[], n: number, sd: number): boolean {
  if (series.length < n) return false;
  const window = series.slice(0, n);
  const first = window[0];
  if (first === undefined || first === 0) return false;
  const positive = first > 0;
  return window.every((z) => z > 0 === positive && Math.abs(z) >= sd);
}

/** `n` consecutive points on the same side of the mean, of any magnitude. */
function consecutiveSameSide(series: readonly number[], n: number): boolean {
  if (series.length < n) return false;
  const window = series.slice(0, n);
  const first = window[0];
  if (first === undefined || first === 0) return false;
  const positive = first > 0;
  return window.every((z) => z !== 0 && z > 0 === positive);
}

/** At least `n` of the given points on one side and beyond `sd`. */
function sameSideBeyondWithin(points: readonly number[], n: number, sd: number): boolean {
  return points.filter((z) => z >= sd).length >= n || points.filter((z) => z <= -sd).length >= n;
}

function countSameSideBeyond(points: readonly number[], sd: number): number {
  return Math.max(points.filter((z) => z >= sd).length, points.filter((z) => z <= -sd).length);
}

function range(points: readonly number[]): number {
  if (points.length < 2) return 0;
  return Math.max(...points) - Math.min(...points);
}

/** `n` points moving monotonically in one direction — a drift, not a shift. */
function trending(series: readonly number[], n: number): boolean {
  if (series.length < n) return false;
  // `series` is newest first, so a rising trend reads as a falling window here.
  const window = series.slice(0, n).reverse();
  let rising = true;
  let falling = true;
  for (let i = 1; i < window.length; i += 1) {
    const prev = window[i - 1];
    const next = window[i];
    if (prev === undefined || next === undefined) return false;
    if (next <= prev) rising = false;
    if (next >= prev) falling = false;
  }
  return rising || falling;
}
