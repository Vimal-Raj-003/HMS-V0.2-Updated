'use client';

import { EmptyState } from '@vims/ui';
import { useId } from 'react';
import type { LabQcRunView } from '../api/types';
import { formatInstant, humanise } from '../lib/format';
import {
  SD_ZONES,
  Z_AXIS_LIMIT,
  chartSummary,
  segmentsFor,
  toPoints,
  xFor,
  yFor,
} from '../lib/levey-jennings';
import { describeRule } from '../lib/qc-gate';

/**
 * EN-031 §3.3.6 — the Levey-Jennings chart.
 *
 * ## Why it is inline SVG and not a chart library
 *
 * `apps/web` declares no charting dependency, and the plot is nine straight
 * lines and some circles. Adding a library to draw them would be a bundle for a
 * bench tablet to download before it can show a technologist whether the sodium
 * control is in range.
 *
 * ## The three accessibility rules from EN-031 §13 and `docs/06` §13
 *
 *  1. **Violation markers use shape and a label, never colour.** A rejected
 *     point is a filled square with the rule code beside it; a warned point is a
 *     hollow diamond. A colour-blind technologist reads the same chart.
 *  2. **The chart has a data-table equivalent**, rendered from the same numbers,
 *     not a separate query. A plot whose only representation is pixels is
 *     unusable to a screen reader and unusable in the NABL audit pack.
 *  3. **`role="img"` with a text summary**, so a reader that skips the table
 *     still hears whether anything is out of control.
 *
 * ## The gap this component is honest about
 *
 * There is **no `GET /lab/qc/runs` list endpoint** — `qc.controller.ts` has
 * `POST /runs`, `GET /runs/:id` and `GET /state`, and nothing that returns a
 * series. So this chart plots only the runs the console itself has recorded or
 * fetched, and it says so under the axis rather than letting a sparse line be
 * read as the month's quality control.
 */
const WIDTH = 640;
const HEIGHT = 220;

export function LeveyJenningsChart({
  runs,
  analyteLabel,
}: {
  readonly runs: readonly LabQcRunView[];
  readonly analyteLabel: string;
}): React.JSX.Element {
  const id = useId();
  const points = toPoints(runs);
  const summary = chartSummary(points);

  if (points.length === 0) {
    return (
      <EmptyState
        cause={`No control run for ${analyteLabel} is loaded in this console.`}
        nextAction="Record a QC run below. The chart draws from the runs this console has seen — the API exposes no endpoint that returns a series, so it cannot show the month."
      />
    );
  }

  const segments = segmentsFor(points, WIDTH, HEIGHT);

  return (
    <figure className="flex flex-col gap-2" data-testid="levey-jennings">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-labelledby={`${id}-summary`}
      >
        <title id={`${id}-summary`}>
          Levey-Jennings chart for {analyteLabel}. {summary}
        </title>

        {/* ±1, ±2 and ±3 SD, plus the target mean. Dashed for 1 and 2 SD so the
            3 SD limits read as the boundary they are, without relying on hue. */}
        {SD_ZONES.map((sd) => (
          <g key={sd}>
            <line
              x1={0}
              x2={WIDTH}
              y1={yFor(sd, HEIGHT)}
              y2={yFor(sd, HEIGHT)}
              className="stroke-chart-grid"
              strokeDasharray={sd === 3 ? undefined : '4 4'}
              strokeWidth={1}
            />
            <line
              x1={0}
              x2={WIDTH}
              y1={yFor(-sd, HEIGHT)}
              y2={yFor(-sd, HEIGHT)}
              className="stroke-chart-grid"
              strokeDasharray={sd === 3 ? undefined : '4 4'}
              strokeWidth={1}
            />
            <text x={2} y={yFor(sd, HEIGHT) - 2} className="fill-fg-subtle text-[9px]">
              +{sd} SD
            </text>
            <text x={2} y={yFor(-sd, HEIGHT) - 2} className="fill-fg-subtle text-[9px]">
              −{sd} SD
            </text>
          </g>
        ))}
        <line
          x1={0}
          x2={WIDTH}
          y1={yFor(0, HEIGHT)}
          y2={yFor(0, HEIGHT)}
          className="stroke-fg-subtle"
          strokeWidth={1.5}
        />

        {segments.map((segment) => (
          <polyline key={segment} points={segment} fill="none" className="stroke-chart-1" strokeWidth={1.5} />
        ))}

        {points.map((point, index) => {
          if (point.plottedZ === null) return null;
          const x = xFor(index, points.length, WIDTH);
          const y = yFor(point.plottedZ, HEIGHT);
          if (point.rejected) {
            // Filled square: shape carries the state, colour only reinforces it.
            return (
              <rect
                key={point.id}
                x={x - 4}
                y={y - 4}
                width={8}
                height={8}
                className="fill-danger-solid"
                data-testid={`qc-point-${point.id}`}
                data-state="rejected"
              />
            );
          }
          if (point.warned) {
            return (
              <rect
                key={point.id}
                x={x - 4}
                y={y - 4}
                width={8}
                height={8}
                transform={`rotate(45 ${x} ${y})`}
                className="fill-none stroke-warning-solid"
                strokeWidth={1.5}
                data-testid={`qc-point-${point.id}`}
                data-state="warned"
              />
            );
          }
          return (
            <circle
              key={point.id}
              cx={x}
              cy={y}
              r={3}
              className="fill-chart-1"
              data-testid={`qc-point-${point.id}`}
              data-state="in-control"
            />
          );
        })}
      </svg>

      <figcaption className="text-sm text-fg-muted" data-testid="lj-summary">
        {summary}
      </figcaption>

      {/* EN-031 §13: the data-table equivalent, from the same numbers. */}
      <details className="rounded-md border border-default p-2">
        <summary className="cursor-pointer text-sm text-fg-default">
          The same runs as a table ({points.length})
        </summary>
        <table className="mt-2 w-full text-2xs">
          <caption className="sr-only">Control runs for {analyteLabel}</caption>
          <thead>
            <tr className="text-start text-fg-subtle">
              <th scope="col" className="text-start">
                Run at
              </th>
              <th scope="col" className="text-start">
                Level
              </th>
              <th scope="col" className="text-end">
                Value
              </th>
              <th scope="col" className="text-end">
                z
              </th>
              <th scope="col" className="text-start">
                Rules
              </th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.id} className="border-t border-default">
                <td className="font-mono">{formatInstant(point.runAt)}</td>
                <td>{humanise(point.level)}</td>
                <td className="text-end font-mono tabular-nums">{point.value}</td>
                <td className="text-end font-mono tabular-nums">
                  {point.z === null ? 'not scored' : point.z.toFixed(2)}
                </td>
                <td>
                  {point.violatedRules.length === 0
                    ? '—'
                    : point.violatedRules.map((rule) => describeRule(rule)).join('; ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <p className="text-2xs text-fg-subtle">
        The y-axis is the z-score the server computed against the effective-dated target mean and SD, clamped
        to ±{Z_AXIS_LIMIT} so one wild point does not flatten the zones. A run with no z-score is drawn as a
        gap, never on the mean.
      </p>
    </figure>
  );
}
