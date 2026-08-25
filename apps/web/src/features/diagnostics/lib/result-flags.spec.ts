import { describe, expect, it } from 'vitest';
import { LAB_RESULT_FLAGS } from '../api/types';
import { formatInterval, formatResultValue, isCriticalFlag, presentFlag } from './result-flags';

/**
 * `docs/06` §3.5 and OP-004 §13 — a flag is colour **and** symbol, never colour
 * alone, and "not flagged" is not "normal".
 */

describe('how a verdict is drawn', () => {
  it('gives every flag the API can send a glyph, a code and words', () => {
    for (const flag of LAB_RESULT_FLAGS) {
      const presentation = presentFlag(flag);
      expect(presentation.glyph.length, flag).toBeGreaterThan(0);
      expect(presentation.code.length, flag).toBeGreaterThan(0);
      expect(presentation.label.length, flag).toBeGreaterThan(2);
      // A raw hex would break the theme and `docs/06` §11 forbids it outright.
      expect(presentation.toneClass, flag).toMatch(/^text-(flag|fg)-/u);
    }
  });

  it('marks exactly the two flags the database calls critical', () => {
    expect(isCriticalFlag('critical_high')).toBe(true);
    expect(isCriticalFlag('critical_low')).toBe(true);
    expect(isCriticalFlag('high')).toBe(false);
    expect(isCriticalFlag('abnormal')).toBe(false);
    expect(isCriticalFlag(null)).toBe(false);
    expect(presentFlag('critical_high').critical).toBe(true);
    expect(presentFlag('high').critical).toBe(false);
  });

  it('draws an unflagged result as pending, never as a green tick', () => {
    // A green tick over an unflagged value is a lie the screen tells with
    // confidence.
    const presentation = presentFlag(null);
    expect(presentation.label).toMatch(/not yet flagged/iu);
    expect(presentation.toneClass).toBe('text-flag-pending');
  });

  it('renders a flag it does not recognise as unrecognised rather than as normal', () => {
    const presentation = presentFlag('brand_new_flag');
    expect(presentation.label).toMatch(/Unrecognised flag/iu);
    expect(presentation.critical).toBe(false);
  });
});

describe('the value and its interval', () => {
  const base = {
    value_numeric: null,
    value_operator: null,
    value_coded: null,
    value_multi: [] as readonly string[],
    value_text: null,
    unit: null,
  };

  it('keeps the operator, because <0.01 is a different statement from 0.01', () => {
    expect(formatResultValue({ ...base, value_numeric: 0.01, value_operator: '<', unit: 'ng/mL' })).toBe(
      '<0.01 ng/mL',
    );
  });

  it('renders a coded, a multi-select and a text result', () => {
    expect(formatResultValue({ ...base, value_coded: 'Reactive' })).toBe('Reactive');
    expect(formatResultValue({ ...base, value_multi: ['E. coli', 'Klebsiella'] })).toBe(
      'E. coli, Klebsiella',
    );
    expect(formatResultValue({ ...base, value_text: 'No growth after 48 h' })).toBe('No growth after 48 h');
  });

  it('says a result has no value rather than showing an empty cell', () => {
    expect(formatResultValue(base)).toBe('No value recorded');
  });

  it('returns null for an interval the laboratory has not configured', () => {
    // An invented `0–0` is worse than an empty reference column.
    expect(formatInterval(null, null, 'mmol/L')).toBeNull();
    expect(formatInterval(3.5, 5.1, 'mmol/L')).toBe('3.5–5.1 mmol/L');
    expect(formatInterval(null, 5.1, 'mmol/L')).toBe('≤ 5.1 mmol/L');
    expect(formatInterval(3.5, null, null)).toBe('≥ 3.5');
  });
});
