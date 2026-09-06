import { defineStories } from '../stories/story.js';
import { VitalsSparkline, type VitalPoint } from './vitals-sparkline.js';

/**
 * Fixed data, never generated. `docs/09` §2 bans ambient randomness in tests,
 * and a gallery is read the same way a test is: a specimen that redraws itself
 * on every reload cannot be compared against yesterday's screenshot.
 */
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 2, 6, 0, 0);

const stable: readonly VitalPoint[] = [
  { at: T0, value: 118 },
  { at: T0 + HOUR, value: 121 },
  { at: T0 + HOUR * 2, value: 117 },
  { at: T0 + HOUR * 3, value: 120 },
  { at: T0 + HOUR * 4, value: 119 },
  { at: T0 + HOUR * 5, value: 122 },
];

const deteriorating: readonly VitalPoint[] = [
  { at: T0, value: 124 },
  { at: T0 + HOUR, value: 131 },
  { at: T0 + HOUR * 2, value: 138 },
  { at: T0 + HOUR * 3, value: 146, abnormal: true },
  { at: T0 + HOUR * 4, value: 152, abnormal: true },
  { at: T0 + HOUR * 5, value: 161, abnormal: true },
];

const spike: readonly VitalPoint[] = [
  { at: T0, value: 76 },
  { at: T0 + HOUR, value: 78 },
  { at: T0 + HOUR * 2, value: 142, abnormal: true },
  { at: T0 + HOUR * 3, value: 81 },
  { at: T0 + HOUR * 4, value: 79 },
  { at: T0 + HOUR * 5, value: 77 },
];

export const vitalsSparklineStories = defineStories({
  slug: 'vitals-sparkline',
  component: 'VitalsSparkline',
  spec: '§5.2 #3',
  summary: 'The shape of one vital sign over a window, at the size of a table cell. A trend, not a chart.',
  stories: [
    {
      id: 'stable',
      name: 'Stable, within range',
      rationale:
        'The reference band is a neutral wash rather than a green fill: being inside the range is unremarkable and must not be the loudest thing in the cell.',
      render: () => (
        <VitalsSparkline
          series={stable}
          referenceRange={{ low: 90, high: 130 }}
          lastValueLabel="122 mmHg"
          labels={{
            parameter: 'Systolic blood pressure',
            summary:
              'Systolic blood pressure over 6 hours: 6 readings, lowest 117, highest 122, now 122, stable and within the reference range 90 to 130.',
            referenceRange: 'normal range 90 to 130',
          }}
        />
      ),
    },
    {
      id: 'deteriorating',
      name: 'Rising out of range',
      rationale:
        'The three out-of-range readings each take a ringed marker, so the abnormal points are found by shape as well as by where the line sits.',
      render: () => (
        <VitalsSparkline
          series={deteriorating}
          referenceRange={{ low: 90, high: 130 }}
          lastValueLabel="161 mmHg"
          labels={{
            parameter: 'Systolic blood pressure',
            summary:
              'Systolic blood pressure over 6 hours: 6 readings, lowest 124, highest 161, now 161, rising and above the reference range 90 to 130 for the last three readings.',
            referenceRange: 'normal range 90 to 130',
          }}
        />
      ),
    },
    {
      id: 'spike',
      name: 'Single spike',
      rationale:
        'The case the downsampler exists for. One tachycardic reading between six normal ones is the clinical content of the trend, and an every-nth-point sample is exactly what loses it.',
      render: () => (
        <VitalsSparkline
          series={spike}
          referenceRange={{ low: 60, high: 100 }}
          lastValueLabel="77 bpm"
          labels={{
            parameter: 'Heart rate',
            summary:
              'Heart rate over 6 hours: 6 readings, lowest 76, highest 142, now 77. One reading at 08:00 was 142, above the reference range 60 to 100.',
            referenceRange: 'normal range 60 to 100',
          }}
        />
      ),
    },
    {
      id: 'no-range',
      name: 'No reference interval',
      rationale: 'Some parameters have no normal range to draw. The band is omitted rather than invented.',
      render: () => (
        <VitalsSparkline
          series={stable}
          lastValueLabel="122 mmHg"
          labels={{
            parameter: 'Systolic blood pressure',
            summary: 'Systolic blood pressure over 6 hours: 6 readings, lowest 117, highest 122, now 122.',
          }}
        />
      ),
    },
    {
      id: 'single-reading',
      name: 'One reading only',
      degraded: true,
      rationale:
        'Degraded data. One point is a value, not a trend, and a flat line here would assert stability nobody has observed. The component renders the number instead.',
      render: () => (
        <VitalsSparkline
          series={[{ at: T0, value: 118 }]}
          lastValueLabel="118 mmHg"
          labels={{
            parameter: 'Systolic blood pressure',
            summary: 'Systolic blood pressure: one reading, 118.',
            insufficient: 'one reading',
          }}
        />
      ),
    },
    {
      id: 'empty',
      name: 'No readings in the window',
      degraded: true,
      rationale:
        'Degraded data. An empty cell reads as "nothing to report"; this says the window is empty, which is a different claim.',
      render: () => (
        <VitalsSparkline
          series={[]}
          labels={{
            parameter: 'Systolic blood pressure',
            summary: 'Systolic blood pressure: no readings in the last 24 hours.',
            empty: 'No readings in 24 h',
          }}
        />
      ),
    },
  ],
});
