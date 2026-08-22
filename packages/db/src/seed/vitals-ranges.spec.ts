import { describe, expect, it } from 'vitest';
import { ADULT_RANGES } from './clinical.js';

/**
 * The seeded vitals reference ranges, checked against ordinary clinical values.
 *
 * These rows decide whether a nurse sees green, amber or red, and they were
 * wrong: `OP-007 §5.1` tabulates the **amber** and **red** bands, and six
 * parameters had those numbers copied straight into the columns that bound the
 * **normal** band. The effect is an inversion rather than a near miss — a
 * temperature of 37.0 °C read amber while 38.5 °C read normal, a pain score of 2
 * read amber, and a BMI of 21 read amber because 23–24.9 (the WHO Asian
 * *overweight* band) had been recorded as normal.
 *
 * Worse, `spo2` carried no critical bound at all, so §5.1's "SpO2 < 92 %
 * critical" could not fire for any patient at any saturation. A reading of 70 %
 * produced an amber flag.
 *
 * A schema CHECK cannot catch this: every one of those rows satisfied
 * `low_critical <= low_abnormal <= high_abnormal <= high_critical`. Only a test
 * that knows what a healthy adult looks like can, which is what this is.
 */

type Band = 'normal' | 'abnormal' | 'critical';

interface Bounds {
  readonly lowAbnormal: number | null;
  readonly highAbnormal: number | null;
  readonly lowCritical: number | null;
  readonly highCritical: number | null;
}

function adultBounds(parameter: string): Bounds {
  const row = ADULT_RANGES.find(
    (r) => r[0] === parameter && r[1] === 6570 && r[2] === 43800 && r[3] === 'any',
  );
  if (row === undefined) throw new Error(`no adult range seeded for "${parameter}"`);
  return { lowAbnormal: row[4], highAbnormal: row[5], lowCritical: row[6], highCritical: row[7] };
}

/**
 * The same reading the service applies: outside the normal band is amber,
 * outside the amber band is red.
 */
function classify(value: number, b: Bounds): Band {
  if (b.lowCritical !== null && value < b.lowCritical) return 'critical';
  if (b.highCritical !== null && value > b.highCritical) return 'critical';
  if (b.lowAbnormal !== null && value < b.lowAbnormal) return 'abnormal';
  if (b.highAbnormal !== null && value > b.highAbnormal) return 'abnormal';
  return 'normal';
}

describe('seeded adult vitals ranges', () => {
  /** A healthy adult must read green on every parameter. */
  const HEALTHY: ReadonlyArray<readonly [string, number]> = [
    ['systolic', 118],
    ['diastolic', 76],
    ['pulse', 72],
    ['spo2', 98],
    ['temperature_c', 36.8],
    ['resp_rate', 16],
    ['glucose_rbs', 110],
    ['glucose_fbs', 88],
    ['pain_score', 1],
    ['bmi', 21.5],
  ];

  it.each(HEALTHY)('reads an ordinary %s of %s as normal', (parameter, value) => {
    expect(classify(value, adultBounds(parameter))).toBe('normal');
  });

  /**
   * Each of these is a value `OP-007 §5.1` names as red. A parameter with no
   * critical bound silently downgrades every one of them to amber, which is
   * exactly the defect this file exists for.
   */
  const CRITICAL: ReadonlyArray<readonly [string, number]> = [
    ['spo2', 88],
    ['spo2', 70],
    ['temperature_c', 39.4],
    ['temperature_c', 34.6],
    ['systolic', 84],
    ['systolic', 196],
    ['pulse', 44],
    ['pulse', 132],
    ['glucose_rbs', 62],
    ['glucose_rbs', 340],
    ['glucose_fbs', 54],
    ['pain_score', 9],
    ['bmi', 33],
  ];

  it.each(CRITICAL)('reads a critical %s of %s as critical', (parameter, value) => {
    expect(classify(value, adultBounds(parameter))).toBe('critical');
  });

  /** Values §5.1 names as amber must be amber — neither green nor red. */
  const ABNORMAL: ReadonlyArray<readonly [string, number]> = [
    ['spo2', 93],
    ['temperature_c', 38.2],
    ['temperature_c', 35.6],
    ['glucose_rbs', 180],
    ['glucose_fbs', 112],
    ['pain_score', 5],
    ['bmi', 24],
  ];

  it.each(ABNORMAL)('reads an abnormal %s of %s as abnormal', (parameter, value) => {
    expect(classify(value, adultBounds(parameter))).toBe('abnormal');
  });

  /**
   * Every parameter that `§5.1` gives a red threshold to must carry one. This is
   * the assertion that fails on the original `spo2` row, where the critical
   * bounds were null and no saturation could ever be red.
   */
  it.each(['spo2', 'temperature_c', 'systolic', 'pulse', 'glucose_rbs', 'glucose_fbs', 'bmi'])(
    'gives %s at least one critical bound',
    (parameter) => {
      const b = adultBounds(parameter);
      expect(
        b.lowCritical !== null || b.highCritical !== null,
        `${parameter} can never raise a critical alert`,
      ).toBe(true);
    },
  );

  /** The ordering the schema CHECK enforces, asserted here too so a bad row fails before it reaches a database. */
  it.each(ADULT_RANGES.map((r) => [r[0], r[1], r] as const))(
    'orders the bands of %s (from day %s)',
    (_parameter, _ageMin, row) => {
      const [, , , , lowAb, highAb, lowCrit, highCrit] = row;
      if (lowCrit !== null && lowAb !== null) expect(lowCrit).toBeLessThanOrEqual(lowAb);
      if (highCrit !== null && highAb !== null) expect(highCrit).toBeGreaterThanOrEqual(highAb);
      if (lowAb !== null && highAb !== null) expect(lowAb).toBeLessThanOrEqual(highAb);
    },
  );
});
