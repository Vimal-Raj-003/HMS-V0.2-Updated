import { describe, expect, it } from 'vitest';
import {
  checkPlausibility,
  evaluateReadings,
  flagValue,
  selectRange,
  type RangeSubject,
  type ReferenceRange,
} from './vitals.ranges.js';

/**
 * The band matcher, proved against rows shaped exactly like the ones
 * `packages/db/src/seed/clinical.ts` writes.
 *
 * The point of these tests is that **no threshold lives in the code**: every
 * expectation below moves when the row moves, and a test that hard-coded 180
 * would pass even if the evaluator ignored the table entirely.
 */

function range(overrides: Partial<ReferenceRange> & { id: string; parameter: string }): ReferenceRange {
  return {
    ageMinDays: 0,
    ageMaxDays: 43800,
    sex: 'any',
    pregnancy: null,
    scale: null,
    lowAbnormal: null,
    highAbnormal: null,
    lowCritical: null,
    highCritical: null,
    lowPlausible: null,
    highPlausible: null,
    unit: 'x',
    ...overrides,
  };
}

const adult: RangeSubject = { ageDays: 12_000, sex: 'female', pregnancy: 'no', copdScale2: false };

/** The adult systolic row from the seed: normal 100–140, critical below 90 / above 180. */
const adultSystolic = range({
  id: '11111111-1111-1111-1111-111111111111',
  parameter: 'systolic',
  ageMinDays: 6570,
  lowAbnormal: 100,
  highAbnormal: 140,
  lowCritical: 90,
  highCritical: 180,
  lowPlausible: 40,
  highPlausible: 300,
  unit: 'mmHg',
});

describe('flagValue', () => {
  it('calls a value inside the band normal', () => {
    expect(flagValue(adultSystolic, 120)).toBe('normal');
  });

  it('calls a value outside the abnormal band abnormal', () => {
    expect(flagValue(adultSystolic, 95)).toBe('abnormal');
    expect(flagValue(adultSystolic, 160)).toBe('abnormal');
  });

  it('calls a value outside the critical band critical', () => {
    expect(flagValue(adultSystolic, 190)).toBe('critical');
    expect(flagValue(adultSystolic, 80)).toBe('critical');
  });

  it('treats the bounds themselves as inside the band', () => {
    expect(flagValue(adultSystolic, 100)).toBe('normal');
    expect(flagValue(adultSystolic, 140)).toBe('normal');
    expect(flagValue(adultSystolic, 180)).toBe('abnormal');
  });

  it('follows the row rather than any built-in number', () => {
    // Same value, a hospital that widened its band: no longer critical.
    const widened = range({ ...adultSystolic, id: adultSystolic.id, highCritical: 220 });
    expect(flagValue(widened, 190)).toBe('abnormal');
  });
});

describe('selectRange', () => {
  const paediatricPulse = range({
    id: '22222222-2222-2222-2222-222222222222',
    parameter: 'pulse',
    ageMinDays: 0,
    ageMaxDays: 28,
    lowAbnormal: 120,
    highAbnormal: 160,
    unit: '/min',
  });
  const adultPulse = range({
    id: '33333333-3333-3333-3333-333333333333',
    parameter: 'pulse',
    ageMinDays: 6570,
    ageMaxDays: 43800,
    lowAbnormal: 60,
    highAbnormal: 100,
    unit: '/min',
  });

  it('picks the band the patient’s age falls in', () => {
    const neonate: RangeSubject = { ageDays: 5, sex: 'male', pregnancy: 'no', copdScale2: false };
    expect(selectRange([adultPulse, paediatricPulse], 'pulse', neonate)?.id).toBe(paediatricPulse.id);
    expect(selectRange([adultPulse, paediatricPulse], 'pulse', adult)?.id).toBe(adultPulse.id);
  });

  it('prefers the narrower band when two overlap', () => {
    const allAges = range({ ...adultPulse, id: '44444444-4444-4444-4444-444444444444', ageMinDays: 0 });
    expect(
      selectRange([allAges, paediatricPulse], 'pulse', {
        ageDays: 10,
        sex: 'male',
        pregnancy: 'no',
        copdScale2: false,
      })?.id,
    ).toBe(paediatricPulse.id);
  });

  it('prefers a pregnancy-specific row over a general one', () => {
    const pregnant = range({
      id: '55555555-5555-5555-5555-555555555555',
      parameter: 'systolic',
      ageMinDays: 4380,
      ageMaxDays: 20075,
      sex: 'female',
      pregnancy: 'yes',
      lowAbnormal: 100,
      highAbnormal: 140,
      highCritical: 160,
      unit: 'mmHg',
    });
    const subject: RangeSubject = { ageDays: 11_000, sex: 'female', pregnancy: 'yes', copdScale2: false };
    expect(selectRange([adultSystolic, pregnant], 'systolic', subject)?.id).toBe(pregnant.id);
    // 170 is abnormal on the general adult row and critical on the pregnancy row.
    expect(flagValue(pregnant, 170)).toBe('critical');
    expect(flagValue(adultSystolic, 170)).toBe('abnormal');
  });

  it('switches SpO2 to the scale-2 row only when the COPD flag is set', () => {
    const scale1 = range({
      id: '66666666-6666-6666-6666-666666666666',
      parameter: 'spo2',
      ageMinDays: 6570,
      lowAbnormal: 92,
      unit: '%',
    });
    const scale2 = range({
      id: '77777777-7777-7777-7777-777777777777',
      parameter: 'spo2',
      ageMinDays: 6570,
      scale: 2,
      lowAbnormal: 88,
      highAbnormal: 93,
      unit: '%',
    });

    expect(selectRange([scale1, scale2], 'spo2', adult)?.id).toBe(scale1.id);
    expect(selectRange([scale1, scale2], 'spo2', { ...adult, copdScale2: true })?.id).toBe(scale2.id);
    // 90 % is abnormal on scale 1 and expected on scale 2.
    expect(flagValue(scale1, 90)).toBe('abnormal');
    expect(flagValue(scale2, 90)).toBe('normal');
  });

  it('returns nothing when the date of birth is unknown, rather than guessing an age band', () => {
    expect(selectRange([adultSystolic], 'systolic', { ...adult, ageDays: null })).toBeNull();
  });

  it('returns nothing when the hospital has configured no band for the parameter', () => {
    expect(selectRange([adultSystolic], 'head_circ_cm', adult)).toBeNull();
  });
});

describe('evaluateReadings', () => {
  it('reports the worst verdict as the overall flag and names the parameters', () => {
    const pulse = range({
      id: '88888888-8888-8888-8888-888888888888',
      parameter: 'pulse',
      lowAbnormal: 60,
      highAbnormal: 100,
      lowCritical: 50,
      highCritical: 120,
      unit: '/min',
    });

    const result = evaluateReadings(
      [adultSystolic, pulse],
      [
        { parameter: 'systolic', value: 190 },
        { parameter: 'pulse', value: 105 },
      ],
      adult,
    );

    expect(result.overall).toBe('critical');
    expect(result.critical).toEqual(['systolic']);
    expect(result.abnormal).toEqual(['pulse']);
    expect(result.flags).toEqual({ systolic: 'critical', pulse: 'abnormal' });
  });

  it('records nothing for a parameter with no configured band', () => {
    const result = evaluateReadings([adultSystolic], [{ parameter: 'waist_cm', value: 200 }], adult);
    expect(result.flags).toEqual({});
    expect(result.overall).toBe('normal');
  });
});

describe('checkPlausibility', () => {
  it('reports a value outside the configured plausible bounds', () => {
    const breaches = checkPlausibility([adultSystolic], [{ parameter: 'systolic', value: 320 }], adult);
    expect(breaches).toEqual([{ parameter: 'systolic', value: 320, low: 40, high: 300, unit: 'mmHg' }]);
  });

  it('passes a value that is merely critical', () => {
    expect(checkPlausibility([adultSystolic], [{ parameter: 'systolic', value: 220 }], adult)).toEqual([]);
  });
});
