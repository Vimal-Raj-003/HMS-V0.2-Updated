import type { AlertFatigueReport } from '../api/types';

/**
 * Exit gate 8 — "the alert-fatigue dashboard shows override rate; a deliberately
 * noisy rule can be tuned without a code change".
 *
 * The arithmetic lives here rather than in the component for the usual reason,
 * and for one specific to this report: **a rate over a tiny denominator is
 * noise, and presenting it as a percentage invites somebody to disable a rule
 * that fired twice**. `overrideRate` therefore returns `null` below a floor
 * rather than a confident number, and the screen prints "too few to judge".
 *
 * The API already computes the headline `overrideRatePct` and
 * `alertsPer1000Orders` over the whole window; what it does not compute is the
 * per-family rate, which is the number a governance committee actually tunes a
 * rule from.
 */

/** Below this many fires in the window, a percentage says more than it knows. */
export const MIN_FIRES_FOR_RATE = 10;

export function overrideRate(fires: number, overrides: number): number | null {
  if (fires < MIN_FIRES_FOR_RATE) return null;
  return Math.round((overrides / fires) * 1000) / 10;
}

export interface FamilyRow {
  readonly family: string;
  readonly fires: number;
  readonly overrides: number;
  readonly blocks: number;
  /** `null` when there were too few fires for a rate to mean anything. */
  readonly overrideRatePct: number | null;
  /** Share of every alert shown in the window. Where fatigue actually comes from. */
  readonly shareOfFiresPct: number;
}

export function familyRows(report: AlertFatigueReport): readonly FamilyRow[] {
  const total = report.fires;
  return (
    [...report.byFamily]
      .map((row) => ({
        family: row.family,
        fires: row.fires,
        overrides: row.overrides,
        blocks: row.blocks,
        overrideRatePct: overrideRate(row.fires, row.overrides),
        shareOfFiresPct: total === 0 ? 0 : Math.round((row.fires / total) * 1000) / 10,
      }))
      // Loudest first: the rule a clinician meets forty times a day is the one
      // that trains them to dismiss the one that matters.
      .sort((left, right) => right.fires - left.fires)
  );
}

export interface ReasonRow {
  readonly code: string;
  readonly count: number;
  readonly sharePct: number;
}

export function reasonRows(report: AlertFatigueReport): readonly ReasonRow[] {
  const entries = Object.entries(report.overridesByReason);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  return entries
    .map(([code, count]) => ({
      code,
      count,
      sharePct: total === 0 ? 0 : Math.round((count / total) * 1000) / 10,
    }))
    .sort((left, right) => right.count - left.count);
}

/**
 * A plain-words reading of the headline numbers.
 *
 * A dashboard that shows "override rate 68%" and nothing else is a dashboard
 * that gets screenshotted into a meeting and argued about. This says what the
 * number means, in the terms EN-029 §10 uses.
 */
export function fatigueVerdict(report: AlertFatigueReport): {
  readonly tone: 'success' | 'warning' | 'danger';
  readonly summary: string;
} {
  if (report.fires === 0) {
    return {
      tone: 'success',
      summary: 'No alert fired in this window. Either nothing was prescribed, or nothing tripped a rule.',
    };
  }
  if (report.overrideRatePct >= 50) {
    return {
      tone: 'danger',
      summary:
        'More than half of the alerts shown were overridden. A rule clinicians override by default is a rule that has stopped carrying information — review the loudest families below before adding any more.',
    };
  }
  if (report.overrideRatePct >= 25) {
    return {
      tone: 'warning',
      summary:
        'A quarter or more of the alerts shown were overridden. Worth reviewing which families account for it.',
    };
  }
  return {
    tone: 'success',
    summary: 'Most alerts shown were acted on rather than overridden.',
  };
}
