import { describe, expect, it } from 'vitest';
import type { ReferenceRangeRow } from '../api/types';
import { parseRanges, type RangeSubject } from './ranges';
import {
  EMPTY_VITALS_FORM,
  blockingMessages,
  hasAnyMeasurement,
  parameterFor,
  parsedValue,
  previewVerdicts,
  toCreateRequest,
  VITALS_FIELDS,
  type VitalsFormState,
} from './vitals-form';

const subject: RangeSubject = { ageDays: 12_000, sex: 'female', pregnancy: 'unknown', copdScale2: false };

function ranges(): readonly ReferenceRangeRow[] {
  return [
    {
      id: 'r-sys',
      parameter: 'systolic',
      age_min_days: 0,
      age_max_days: 43_800,
      sex: 'any',
      pregnancy: null,
      scale: null,
      low_abnormal: 100,
      high_abnormal: 140,
      low_critical: 90,
      high_critical: 180,
      low_plausible: 40,
      high_plausible: 300,
      unit: 'mmHg',
    },
    {
      id: 'r-rbs',
      parameter: 'glucose_rbs',
      age_min_days: 0,
      age_max_days: 43_800,
      sex: 'any',
      pregnancy: null,
      scale: null,
      low_abnormal: 70,
      high_abnormal: 140,
      low_critical: 70,
      high_critical: 300,
      low_plausible: 10,
      high_plausible: 900,
      unit: 'mg/dL',
    },
  ];
}

function form(overrides: Partial<VitalsFormState> = {}): VitalsFormState {
  return { ...EMPTY_VITALS_FORM, ...overrides };
}

describe('the live preview', () => {
  it('flags against the hospital’s band', () => {
    const verdicts = previewVerdicts(form({ systolic: '190' }), parseRanges(ranges()), subject);
    expect(verdicts.find((v) => v.field.key === 'systolic')?.flag).toBe('critical');
  });

  /**
   * The property that stops a threshold creeping into the client: with no bands
   * — which is the *normal* state for the vitals nurse, who does not hold
   * `vitals.configure` — nothing is coloured, and in particular nothing is
   * coloured green.
   */
  it('scores nothing at all when the bands could not be read', () => {
    const verdicts = previewVerdicts(form({ systolic: '190', pulse: '72' }), null, subject);
    expect(verdicts.every((verdict) => verdict.flag === null)).toBe(true);
  });

  it('scores nothing for a parameter the hospital has not configured', () => {
    const verdicts = previewVerdicts(form({ pulse: '300' }), parseRanges(ranges()), subject);
    expect(verdicts.find((v) => v.field.key === 'pulse')?.flag).toBeNull();
  });

  it('reports a value outside the storage bounds as a field problem', () => {
    const verdicts = previewVerdicts(form({ systolic: '900' }), parseRanges(ranges()), subject);
    expect(verdicts.find((v) => v.field.key === 'systolic')?.outOfRange).toMatch(/between 40 and 300/u);
  });

  it('reports an implausible value as a reading to check, not as a finding', () => {
    const verdicts = previewVerdicts(form({ systolic: '299' }), parseRanges(ranges()), subject);
    const systolic = verdicts.find((v) => v.field.key === 'systolic');
    expect(systolic?.flag).toBe('critical');
    expect(systolic?.implausible).toBeNull();
  });
});

describe('glucose', () => {
  it('is scored against the band for the test that was done', () => {
    const rbs = form({ glucoseMgdl: '400', glucoseType: 'rbs' });
    const glucoseField = VITALS_FIELDS.find((field) => field.key === 'glucoseMgdl');
    expect(glucoseField).toBeDefined();
    if (glucoseField !== undefined) expect(parameterFor(glucoseField, rbs)).toBe('glucose_rbs');
    const verdicts = previewVerdicts(rbs, parseRanges(ranges()), subject);
    expect(verdicts.find((v) => v.field.key === 'glucoseMgdl')?.flag).toBe('critical');
  });

  it('is not scored at all until the test type is known', () => {
    const untyped = form({ glucoseMgdl: '400' });
    const verdicts = previewVerdicts(untyped, parseRanges(ranges()), subject);
    expect(verdicts.find((v) => v.field.key === 'glucoseMgdl')?.flag).toBeNull();
    expect(blockingMessages(verdicts, untyped)).toContainEqual(expect.stringContaining('which glucose test'));
  });
});

describe('what blocks a save', () => {
  it('refuses a diastolic that is not lower than the systolic', () => {
    const state = form({ systolic: '80', diastolic: '95' });
    const messages = blockingMessages(previewVerdicts(state, parseRanges(ranges()), subject), state);
    expect(messages).toContainEqual(expect.stringContaining('lower than systolic'));
  });

  it('allows a set with only the fields that were actually taken', () => {
    const state = form({ pulse: '78' });
    expect(blockingMessages(previewVerdicts(state, parseRanges(ranges()), subject), state)).toStrictEqual([]);
    expect(hasAnyMeasurement(state)).toBe(true);
  });

  it('knows an empty form has nothing to save', () => {
    expect(hasAnyMeasurement(EMPTY_VITALS_FORM)).toBe(false);
  });
});

describe('the save payload', () => {
  it('omits every field that was left blank, rather than sending zero', () => {
    const request = toCreateRequest(form({ pulse: '78' }), { patientId: 'p1' });
    expect(request).toStrictEqual({
      patientId: 'p1',
      context: 'opd_vitals_room',
      onOxygen: false,
      pulse: 78,
    });
    expect('weightKg' in request).toBe(false);
    expect('systolic' in request).toBe(false);
  });

  it('never sends a glucose value without the test type', () => {
    const request = toCreateRequest(form({ glucoseMgdl: '140' }), { patientId: 'p1' });
    expect('glucoseMgdl' in request).toBe(false);
  });

  it('sends the visit and encounter only when they were given', () => {
    const bare = toCreateRequest(form({ pulse: '70' }), { patientId: 'p1', visitId: '' });
    expect('visitId' in bare).toBe(false);
    const linked = toCreateRequest(form({ pulse: '70' }), { patientId: 'p1', visitId: 'v1' });
    expect(linked.visitId).toBe('v1');
  });

  it('parses a decimal weight without rounding it', () => {
    const request = toCreateRequest(form({ weightKg: '12.4' }), { patientId: 'p1' });
    expect(request.weightKg).toBe(12.4);
  });
});

describe('parsing a field', () => {
  it('returns nothing rather than NaN for a half-typed value', () => {
    expect(parsedValue(form({ temperatureC: '' }), 'temperatureC')).toBeNull();
    expect(parsedValue(form({ temperatureC: 'abc' }), 'temperatureC')).toBeNull();
    expect(parsedValue(form({ temperatureC: '37.2' }), 'temperatureC')).toBe(37.2);
  });
});
