'use client';

import { useId } from 'react';
import { formatInstant } from '../lib/numbers';

/**
 * The last few readings of one parameter, as a trend.
 *
 * Two rules from `docs/06` §7 shape this:
 *
 *  - **the chart has a text alternative, and the text alternative is the data.**
 *    A visually-hidden table carries every point with its timestamp, so a screen
 *    reader gets the numbers rather than "graphic"; sighted users get the shape.
 *  - **no colour of its own.** The stroke is `currentColor`, so the line takes
 *    the semantic token of whatever it sits in and follows light, dark and
 *    high-contrast themes. `docs/06` §11 forbids a colour literal outside the
 *    token files, and a hard-coded stroke is exactly the thing that survives
 *    review and then disappears on a ward TV.
 *
 * A single point is drawn as a point, not as a line of length zero, and an empty
 * series renders the reason it is empty rather than an axis with nothing on it.
 */
export interface TrendPoint {
  readonly at: string;
  readonly value: number;
}

export function VitalsSparkline({
  points,
  label,
  unit,
}: {
  readonly points: readonly TrendPoint[];
  readonly label: string;
  readonly unit: string;
}): React.JSX.Element {
  const tableId = useId();

  if (points.length === 0) {
    return (
      <p className="text-2xs text-fg-muted" data-testid="sparkline-empty">
        {label}: no earlier reading on file.
      </p>
    );
  }

  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series would divide by zero; drawing it down the middle is truthful.
  const span = max - min === 0 ? 1 : max - min;
  const width = 120;
  const height = 28;
  const step = points.length === 1 ? 0 : width / (points.length - 1);

  const coordinates = points.map((point, index) => {
    const x = points.length === 1 ? width / 2 : index * step;
    const y = height - ((point.value - min) / span) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const last = points[points.length - 1];

  return (
    <figure className="flex items-center gap-2" data-testid="vitals-sparkline">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        className="text-fg-muted"
        role="img"
        aria-describedby={tableId}
        aria-label={`${label} trend, ${String(points.length)} readings, latest ${String(last?.value ?? 0)} ${unit}`}
      >
        {points.length === 1 ? (
          <circle cx={width / 2} cy={height / 2} r="2.5" fill="currentColor" />
        ) : (
          <polyline
            points={coordinates.join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
      </svg>
      <figcaption className="text-2xs text-fg-muted">
        {label} {last === undefined ? '' : `${String(last.value)} ${unit}`}
      </figcaption>
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
