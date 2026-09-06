'use client';

import { useId } from 'react';
import { VitalsSparkline } from '@vims/ui/clinical';
import { TREND_REFERENCE, toSparklineSeries, type TrendPoint } from '../lib/news2-presentation';
import { formatInstant } from '../lib/numbers';

/**
 * One parameter's trend on the vitals station, drawn by the design system.
 *
 * This replaces a local `VitalsSparkline` that predated the shared one. docs/06
 * §5.2 #3 puts the sparkline in the design system, and two implementations meant
 * the ward screen and the gallery could disagree about what an abnormal reading
 * looks like. What the shared component adds is the part that was missing here:
 * a **reference band** behind the line, **ringed markers on out-of-range
 * readings**, and a downsampler that keeps the peaks when a stay runs to
 * hundreds of observations.
 *
 * What this wrapper keeps from the local version is the thing worth keeping: the
 * **visually-hidden data table**. A one-sentence summary tells a screen-reader
 * user the shape; the table gives them the readings. Both are needed, and the
 * `dataviz` skill asks for a table view for exactly this reason — so the summary
 * goes to `aria-label` on the figure and the table is `aria-describedby` it.
 */

export interface VitalsTrendProps {
  readonly parameter: 'systolic' | 'pulse' | 'spo2';
  readonly label: string;
  readonly unit: string;
  readonly points: readonly TrendPoint[];
}

export function VitalsTrend({ parameter, label, unit, points }: VitalsTrendProps): React.JSX.Element {
  const tableId = useId();

  if (points.length === 0) {
    return (
      <p className="text-2xs text-fg-muted" data-testid="sparkline-empty">
        {label}: no earlier reading on file.
      </p>
    );
  }

  const reference = TREND_REFERENCE[parameter];
  const series = toSparklineSeries(points, reference);
  const values = points.map((p) => p.value);
  const last = points[points.length - 1];
  const abnormalCount = series.filter((p) => p.abnormal === true).length;

  const summary =
    `${label} trend, ${String(points.length)} readings, ` +
    `lowest ${String(Math.min(...values))}, highest ${String(Math.max(...values))}, ` +
    `latest ${String(last?.value ?? 0)} ${unit}. ` +
    `Usual range ${String(reference.low)} to ${String(reference.high)} ${unit}. ` +
    (abnormalCount === 0 ? 'All readings are within it.' : `${String(abnormalCount)} outside it.`);

  return (
    <figure className="m-0 flex items-center gap-2" data-testid="vitals-sparkline">
      <span aria-describedby={tableId}>
        <VitalsSparkline
          series={series}
          referenceRange={reference}
          // Spread rather than pass `undefined`: `exactOptionalPropertyTypes`
          // treats an explicit undefined as a different thing from an absent prop.
          {...(last === undefined ? {} : { lastValueLabel: `${String(last.value)} ${unit}` })}
          labels={{ parameter: label, summary }}
        />
      </span>
      <figcaption className="text-2xs text-fg-muted">{label}</figcaption>

      {/*
        The data, not a description of it. Kept from the component this replaced.
      */}
      <table id={tableId} className="sr-only">
        <caption>
          {label} readings in {unit}, oldest first
        </caption>
        <thead>
          <tr>
            <th scope="col">Recorded at</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={`${point.at}-${String(point.value)}`}>
              <td>{formatInstant(point.at)}</td>
              <td>
                {point.value} {unit}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
