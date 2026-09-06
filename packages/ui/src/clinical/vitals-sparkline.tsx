import { useId } from 'react';
import { cn } from '../lib/cn.js';

/**
 * `VitalsSparkline` — docs/06 §5.2 #3: "`param, series, window(24h/72h/stay),
 * refRange`. Line + reference band + last value + arrow; abnormal points marked
 * with glyph. ≤ 200 points (downsampled server-side). Not interactive on TV.
 * `role="img"` with a text summary (min/max/last/trend)."
 *
 * **Inline SVG, no charting library.** `CLAUDE.md` §2 names Recharts/ECharts for
 * charts, and that stands for the analytics dashboards of Phase 11 — but a
 * sparkline is forty points in a 120×32 box, rendered a dozen times on one ward
 * screen. A charting runtime there costs a hydration boundary and ~40 KB per
 * route to draw two paths, and it brings its own colours and its own tooltip
 * that would have to be fought back to the tokens. The `dataviz` skill's own
 * guidance is to build the marks in plain HTML/SVG; this is that.
 *
 * What the skill's mark specs pin down, and what is implemented below:
 *   - 2 px lines, ≥ 8 px markers, a recessive grid, no marker on every point;
 *   - **abnormal points carry a glyph**, so the out-of-range ones are not
 *     distinguished by colour alone — the same rule as `ResultFlag`;
 *   - the reference band is a *band*, drawn under the line in a neutral wash,
 *     not a pair of red threshold lines that shout at a normal patient;
 *   - one series, so there is no legend: §6 of the skill says the title names it.
 *
 * The single most important behaviour is the empty and the near-empty case. A
 * sparkline of one reading is not a trend and must not draw a flat line implying
 * stability, so `series` shorter than two renders the value alone.
 */

export interface VitalPoint {
  /** Epoch milliseconds. Ordering is not assumed; the component sorts. */
  readonly at: number;
  readonly value: number;
  /**
   * Set when the reading is outside the reference range. Supplied rather than
   * derived: "abnormal" for a vital sign depends on age, pregnancy and the
   * patient's own baseline, and that judgement belongs with the service that
   * has the chart, not with a drawing component.
   */
  readonly abnormal?: boolean;
}

export interface VitalsSparklineLabels {
  /** e.g. "Systolic blood pressure". Names the series, so no legend is needed. */
  readonly parameter: string;
  /**
   * The whole chart as a sentence, for `role="img"`. e.g. "Systolic blood
   * pressure over 24 hours: 12 readings, lowest 104, highest 148, now 132,
   * rising." Supplied by the caller because it has the units and the locale.
   */
  readonly summary: string;
  /** e.g. "normal range 90 to 120". Announced, and drawn as the band. */
  readonly referenceRange?: string;
  /** Shown when there are fewer than two readings, e.g. "One reading only". */
  readonly insufficient?: string;
  /** Shown when there are none, e.g. "No readings in this window". */
  readonly empty?: string;
}

export interface VitalsSparklineProps {
  readonly series: readonly VitalPoint[];
  readonly labels: VitalsSparklineLabels;
  /** Drawn as a band behind the line. Omit when the parameter has no range. */
  readonly referenceRange?: { readonly low: number; readonly high: number };
  /** The most recent value, already formatted with its unit ("132 mmHg"). */
  readonly lastValueLabel?: string;
  readonly width?: number;
  readonly height?: number;
  readonly className?: string;
}

/** §5.2 #3 — "≤ 200 points (downsampled server-side)"; enforced here as well. */
const MAX_POINTS = 200;

/**
 * Largest-Triangle-Three-Buckets, which is the downsampler that keeps the
 * *peaks*. A naive every-nth-point sample is what loses the one tachycardic
 * spike in an overnight series, and losing it silently is worse than not
 * drawing the chart.
 */
function downsample(points: readonly VitalPoint[], threshold: number): readonly VitalPoint[] {
  if (points.length <= threshold || threshold < 3) return points;
  const bucketSize = (points.length - 2) / (threshold - 2);
  const sampled: VitalPoint[] = [points[0] as VitalPoint];
  let a = 0;

  for (let i = 0; i < threshold - 2; i += 1) {
    const nextStart = Math.floor((i + 1) * bucketSize) + 1;
    const nextEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, points.length);
    let avgX = 0;
    let avgY = 0;
    for (let j = nextStart; j < nextEnd; j += 1) {
      avgX += points[j]?.at ?? 0;
      avgY += points[j]?.value ?? 0;
    }
    const count = Math.max(1, nextEnd - nextStart);
    avgX /= count;
    avgY /= count;

    const rangeStart = Math.floor(i * bucketSize) + 1;
    const rangeEnd = Math.floor((i + 1) * bucketSize) + 1;
    const pointA = points[a] as VitalPoint;
    let best = rangeStart;
    let bestArea = -1;
    for (let j = rangeStart; j < Math.min(rangeEnd, points.length); j += 1) {
      const p = points[j] as VitalPoint;
      const area = Math.abs(
        (pointA.at - avgX) * (p.value - pointA.value) - (pointA.at - p.at) * (avgY - pointA.value),
      );
      if (area > bestArea) {
        bestArea = area;
        best = j;
      }
    }
    // An abnormal reading is never dropped, whatever its triangle area: the
    // outliers are the clinical content of a vitals trend.
    const abnormalInBucket = points
      .slice(rangeStart, Math.min(rangeEnd, points.length))
      .find((p) => p.abnormal === true);
    sampled.push(abnormalInBucket ?? (points[best] as VitalPoint));
    a = best;
  }

  sampled.push(points[points.length - 1] as VitalPoint);
  return sampled;
}

export function VitalsSparkline({
  series,
  labels,
  referenceRange,
  lastValueLabel,
  width = 132,
  height = 36,
  className,
}: VitalsSparklineProps): React.JSX.Element {
  const bandId = useId();

  const ordered = [...series].sort((x, y) => x.at - y.at);

  if (ordered.length === 0) {
    return (
      <span
        data-slot="vitals-sparkline"
        data-state="empty"
        className={cn('text-fg-subtle text-2xs inline-flex items-center', className)}
      >
        {labels.empty ?? labels.parameter}
      </span>
    );
  }

  const last = ordered[ordered.length - 1] as VitalPoint;

  if (ordered.length === 1) {
    // One reading is a value, not a trend. Drawing a flat line here would say
    // "stable", which is a claim nobody has made.
    return (
      <span
        data-slot="vitals-sparkline"
        data-state="single"
        className={cn('inline-flex items-baseline gap-1.5', className)}
      >
        <span className="text-fg-default font-mono text-sm tabular-nums slashed-zero">
          {lastValueLabel ?? String(last.value)}
        </span>
        <span className="text-fg-subtle text-2xs">{labels.insufficient ?? ''}</span>
      </span>
    );
  }

  const points = downsample(ordered, MAX_POINTS);
  const values = points.map((p) => p.value);
  const lo = Math.min(...values, referenceRange?.low ?? Number.POSITIVE_INFINITY);
  const hi = Math.max(...values, referenceRange?.high ?? Number.NEGATIVE_INFINITY);
  // A completely flat series would divide by zero; give it a nominal span so the
  // line sits on the centreline rather than at the top of the box.
  const span = hi - lo || 1;
  const padY = 3;
  const plotH = height - padY * 2;
  const firstAt = points[0]?.at ?? 0;
  const lastAt = last.at;
  const spanX = lastAt - firstAt || 1;

  const x = (at: number): number => ((at - firstAt) / spanX) * (width - 2) + 1;
  const y = (v: number): number => padY + (1 - (v - lo) / span) * plotH;

  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.at).toFixed(2)} ${y(p.value).toFixed(2)}`)
    .join(' ');
  const abnormal = points.filter((p) => p.abnormal === true);

  const bandTop = referenceRange === undefined ? 0 : y(referenceRange.high);
  const bandBottom = referenceRange === undefined ? 0 : y(referenceRange.low);

  return (
    <span
      data-slot="vitals-sparkline"
      data-state="series"
      className={cn('inline-flex items-center gap-2', className)}
    >
      {/*
        One image with one sentence. A screen reader gets `labels.summary`
        (min/max/last/trend) rather than a hundred <title> nodes it would have to
        walk — §5.2 #3, and the skill's rule that a table view exists for the
        detail. The SVG itself is inert.
      */}
      <svg
        role="img"
        aria-label={labels.summary}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="overflow-visible"
        focusable="false"
      >
        {referenceRange === undefined ? null : (
          <rect
            x={0}
            y={Math.min(bandTop, bandBottom)}
            width={width}
            height={Math.max(1, Math.abs(bandBottom - bandTop))}
            // A neutral wash, not a status colour: being *inside* the reference
            // range is the unremarkable case and must not be tinted green, or the
            // eye starts reading the background instead of the line.
            fill="var(--chart-grid)"
            rx={2}
          />
        )}

        <path
          id={bandId}
          d={path}
          fill="none"
          stroke="var(--chart-1)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />

        {/*
          Abnormal readings get a ring *and* a shape, never colour alone. The
          2 px surface-coloured halo is the skill's overlap rule: it keeps a
          marker legible where it sits on top of the line.
        */}
        {abnormal.map((p) => (
          <circle
            key={p.at}
            cx={x(p.at)}
            cy={y(p.value)}
            r={3.5}
            fill="var(--chart-plot-bg)"
            stroke="var(--flag-abnormal)"
            strokeWidth={2}
          />
        ))}

        {/* The last point is always marked: it is the value being acted on. */}
        <circle
          cx={x(last.at)}
          cy={y(last.value)}
          r={last.abnormal === true ? 3.5 : 2.5}
          fill={last.abnormal === true ? 'var(--flag-abnormal)' : 'var(--chart-1)'}
          stroke="var(--chart-plot-bg)"
          strokeWidth={1.5}
        />
      </svg>

      {lastValueLabel === undefined ? null : (
        <span
          className={cn(
            'font-mono text-sm tabular-nums slashed-zero',
            last.abnormal === true ? 'text-flag-abnormal font-semibold' : 'text-fg-default',
          )}
          aria-hidden="true"
        >
          {lastValueLabel}
        </span>
      )}
    </span>
  );
}
