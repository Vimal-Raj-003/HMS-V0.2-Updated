import { describe, expect, it } from 'vitest';
import type { ReferenceRangeRow } from '../api/types';
import {
  ageDaysAt,
  flagFor,
  parseRanges,
  plausibilityBreach,
  selectRange,
  worstFlag,
  type ParsedRange,
  type RangeSubject,
} from './ranges';

/**
 * The bands are the hospital's, and this file proves the client never invents
 * one.
 *
 * Every number below is **supplied by the test**, standing in for a row of
 * `clinical.vitals_reference_ranges`. If somebody later hard-codes a threshold
 * in `ranges.ts`, the `no bands configured` cases here start returning a verdict
 * instead of `null` and fail.
 */

function row(overrides: Partial<ReferenceRangeRow> = {}): ReferenceRangeRow {
  return {
    id: 'r1',
    parameter: 'systolic',
    age_min_days: 0,
    age_max_days: 43_800,
    sex: 'any',
    pregnancy: null,
    scale: null,
    low_abnormal: '100',
    high_abnormal: '140',
    low_critical: '90',
    high_critical: '180',
    low_plausible: '40',
    high_plausible: '300',
    unit: 'mmHg',
    ...overrides,
  };
}

const adult: RangeSubject = { ageDays: 12_000, sex: 'male', pregnancy: 'unknown', copdScale2: false };

describe('parsing the configured bands', () => {
  it('turns pg decimal strings into numbers', () => {
    const [parsed] = parseRanges([row()]);
    expect(parsed?.lowAbnormal).toBe(100);
    expect(parsed?.highCritical).toBe(180);
  });

  it('drops a row with no parameter rather than defaulting one', () => {
    expect(parseRanges([row({ parameter: '' })])).toHaveLength(0);
  });

  it('drops a row whose age bounds will not parse, rather than treating it as all ages', () => {
    expect(parseRanges([row({ age_min_days: Number.NaN })])).toHaveLength(0);
  });
});

describe('choosing the band that applies', () => {
  it('prefers the row that names the patient’s sex over the one that says any', () => {
    const ranges = parseRanges([row({ id: 'a' }), row({ id: 'b', sex: 'male' })]);
    expect(selectRange(ranges, 'systolic', adult)?.id).toBe('b');
  });

  it('prefers the narrower age band when two rows tie', () => {
    const ranges = parseRanges([
      row({ id: 'wide', age_min_days: 0, age_max_days: 43_800 }),
      row({ id: 'narrow', age_min_days: 6570, age_max_days: 43_800 }),
    ]);
    expect(selectRange(ranges, 'systolic', adult)?.id).toBe('narrow');
  });

  it('switches SpO2 to the scale-2 row when the COPD flag is set', () => {
    const ranges = parseRanges([
      row({ id: 's1', parameter: 'spo2', scale: 1 }),
      row({ id: 's2', parameter: 'spo2', scale: 2 }),
    ]);
    expect(selectRange(ranges, 'spo2', { ...adult, copdScale2: true })?.id).toBe('s2');
    expect(selectRange(ranges, 'spo2', adult)?.id).toBe('s1');
  });

  it('chooses nothing when the age is unknown, because no age band can apply', () => {
    const ranges = parseRanges([row()]);
    expect(selectRange(ranges, 'systolic', { ...adult, ageDays: null })).toBeNull();
  });

  it('chooses nothing for a parameter the hospital has not configured', () => {
    const ranges = parseRanges([row()]);
    expect(selectRange(ranges, 'head_circ_cm', adult)).toBeNull();
  });
});

describe('applying a band', () => {
  const band = parseRanges([row()])[0] as ParsedRange;

  it('treats a value equal to a bound as inside it', () => {
    expect(flagFor(band, 100)).toBe('normal');
    expect(flagFor(band, 140)).toBe('normal');
  });

  it('flags outside the abnormal bounds', () => {
    expect(flagFor(band, 99)).toBe('abnormal');
    expect(flagFor(band, 141)).toBe('abnormal');
  });

  it('flags outside the critical bounds', () => {
    expect(flagFor(band, 89)).toBe('critical');
    expect(flagFor(band, 181)).toBe('critical');
  });

  /**
   * The property that matters most: with no configured band there is **no
   * verdict**. A client that returns `normal` here is a client that has invented
   * a threshold, and a green tick over an unscored value is a lie told with
   * confidence.
   */
  it('returns no verdict at all when no band applies', () => {
    expect(flagFor(null, 220)).toBeNull();
    expect(flagFor(null, 0)).toBeNull();
  });

  it('reports an implausible value as a typo rather than a finding', () => {
    expect(plausibilityBreach(band, 'systolic', 500)).toMatchObject({ parameter: 'systolic', high: 300 });
    expect(plausibilityBreach(band, 'systolic', 120)).toBeNull();
    expect(plausibilityBreach(null, 'systolic', 500)).toBeNull();
  });
});

describe('summarising a set of verdicts', () => {
  it('takes the worst', () => {
    expect(worstFlag(['normal', 'abnormal', 'critical'])).toBe('critical');
    expect(worstFlag(['normal', 'abnormal'])).toBe('abnormal');
    expect(worstFlag(['normal'])).toBe('normal');
  });

  it('reports nothing scored as nothing, not as normal', () => {
    expect(worstFlag([null, null])).toBeNull();
    expect(worstFlag([])).toBeNull();
  });
});

describe('age in days', () => {
  it('counts whole days', () => {
    expect(ageDaysAt('2020-01-01', new Date('2020-01-31T00:00:00Z'))).toBe(30);
  });

  it('refuses an unknown or future date of birth rather than guessing', () => {
    expect(ageDaysAt(null, new Date())).toBeNull();
    expect(ageDaysAt('', new Date())).toBeNull();
    expect(ageDaysAt('not-a-date', new Date())).toBeNull();
    expect(ageDaysAt('2030-01-01', new Date('2020-01-01T00:00:00Z'))).toBeNull();
  });
});
