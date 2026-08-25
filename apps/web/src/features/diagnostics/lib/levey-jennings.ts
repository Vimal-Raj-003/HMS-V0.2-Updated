import type { LabQcRunView } from '../api/types';
import { blocksRelease } from './qc-gate';

/**
 * EN-031 §3.3.6 — the Levey-Jennings plot, as geometry.
 *
 * Pure and separate from the chart component, because the interesting part is
 * arithmetic that has to be right and the boring part is SVG. `docs/06` §13 and
 * EN-031 §13 also require the chart to have a **data-table equivalent**: a plot
 * whose only representation is pixels is unreadable to a screen reader and
 * unusable in the audit pack, so `toPoints` produces the rows the table renders
 * from the same numbers the line is drawn from.
 *
 * ── What is charted, and what is not ────────────────────────────────────────
 *
 * The y-axis is the **z-score the server computed**, not a mean and SD this
 * module derives. EN-031 §3.2.2 makes the target mean and SD effective-dated
 * master data under Director approval, and a chart that re-derived them from the
 * visible window would draw a different picture after every lot change — which
 * is the one thing §3.2.4 says must never be silently merged.
 *
 * A run whose `z_score` is null is plotted as a gap rather than as zero. Zero is
 * the mean, and a missing z-score drawn on the mean is a control that looks
 * perfect.
 *
 * ── The API gap this module works around ────────────────────────────────────
 *
 * There is **no `GET /lab/qc/runs` list endpoint**. `qc.controller.ts` exposes
 * `POST /runs`, `GET /runs/:id` and `GET /state` and nothing that returns a
 * series. So the chart can only plot the runs this console itself has recorded
 * or fetched by id, and the screen says so rather than drawing a sparse line and
 * letting a technologist read it as the month's QC. This is reported as an API
 * gap, not designed around.
 */

/** EN-031 §3.3.6 — the ±1/2/3 SD zones the plot is read against. */
export const SD_ZONES: readonly number[] = [1, 2, 3];

/** The plot is clamped so a wild point does not flatten the zones into a line. */
export const Z_AXIS_LIMIT = 4;

export interface LeveyJenningsPoint {
  readonly id: string;
  readonly runAt: string;
  readonly level: string;
  readonly value: number;
  /** `null` renders as a gap, never as the mean. */
  readonly z: number | null;
  /** Clamped to the axis, so an outlier stays visible at the edge. */
  readonly plottedZ: number | null;
  readonly violatedRules: readonly string[];
  /** A rejection: filled marker plus the rule label (shape, never colour alone). */
  readonly rejected: boolean;
  /** A warning-only violation (`1-2s`). Marked, but the run stands. */
  readonly warned: boolean;
}

export function toPoints(runs: readonly LabQcRunView[]): readonly LeveyJenningsPoint[] {
  return [...runs]
    .sort((left, right) => Date.parse(left.run_at) - Date.parse(right.run_at))
    .map((run) => {
      const rejected = blocksRelease(run);
      return {
        id: run.id,
        runAt: run.run_at,
        level: run.level,
        value: run.value,
        z: run.z_score,
        plottedZ: run.z_score === null ? null : clamp(run.z_score, -Z_AXIS_LIMIT, Z_AXIS_LIMIT),
        violatedRules: run.violated_rules,
        rejected,
        warned: !rejected && run.violated_rules.length > 0,
      };
    });
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Map a z-score to a y coordinate inside a box of `height` pixels.
 *
 * The mean sits in the middle and +3 SD at the top, because that is which way up
 * every laboratory's SOP draws it. Getting this inverted produces a chart that
 * is subtly, consistently wrong and that nobody notices for months.
 */
export function yFor(z: number, height: number): number {
  const fraction = (Z_AXIS_LIMIT - z) / (Z_AXIS_LIMIT * 2);
  return fraction * height;
}

export function xFor(index: number, count: number, width: number): number {
  if (count <= 1) return width / 2;
  return (index / (count - 1)) * width;
}

/**
 * The polyline for the series, with gaps where the z-score is missing.
 *
 * Returned as a list of segments rather than one string so a missing point
 * breaks the line instead of being bridged across — a bridged gap is a claim
 * that the control was in range when it was never measured.
 */
export function segmentsFor(
  points: readonly LeveyJenningsPoint[],
  width: number,
  height: number,
): readonly string[] {
  const segments: string[] = [];
  let current: string[] = [];

  points.forEach((point, index) => {
    if (point.plottedZ === null) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
      return;
    }
    current.push(
      `${xFor(index, points.length, width).toFixed(2)},${yFor(point.plottedZ, height).toFixed(2)}`,
    );
  });

  if (current.length > 1) segments.push(current.join(' '));
  return segments;
}

/**
 * The verdict sentence under the chart.
 *
 * EN-031 §8's mandated empty states are specific for a reason: "no data" tells a
 * technologist nothing, and "QC not run for Sodium on ARCHITECT-1 this shift —
 * patient results will be held after 08:30" tells them exactly what will happen
 * and when.
 */
export function chartSummary(points: readonly LeveyJenningsPoint[]): string {
  if (points.length === 0) return 'No control runs are loaded for this analyte in this console.';
  const rejections = points.filter((point) => point.rejected).length;
  const warnings = points.filter((point) => point.warned).length;
  const span = `${points.length} control ${points.length === 1 ? 'run' : 'runs'}`;

  if (rejections > 0) {
    return `${span}: ${rejections} rejected the run. Patient results for this analyte are held until the control is back in range.`;
  }
  if (warnings > 0) {
    return `${span}: ${warnings} beyond 2 SD, which is a warning and not a rejection — inspect the trend, do not stop the run.`;
  }
  return `${span}, all in control.`;
}
