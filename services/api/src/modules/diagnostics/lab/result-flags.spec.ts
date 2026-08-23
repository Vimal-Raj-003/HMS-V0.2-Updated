import { describe, expect, it } from 'vitest';
import {
  NO_INTERVAL,
  deltaBreached,
  flagCoded,
  flagNumeric,
  isAbsurd,
  isCriticalFlag,
  toEventFlag,
  type ReferenceInterval,
} from './result-flags.js';

/**
 * The interpretation of a measured value — the code that decides whether a
 * potassium starts a phone call.
 *
 * The intervals below are the seeded adult potassium band from
 * `packages/db/src/seed/diagnostics.ts`: normal 3.5–5.1, panic outside 2.5–6.0.
 * They are written out rather than imported so that a change to the seed shows
 * up here as a decision rather than as a silently different test.
 */
const potassium: ReferenceInterval = {
  low: 3.5,
  high: 5.1,
  criticalLow: 2.5,
  criticalHigh: 6.0,
  textNormal: null,
  criticalCodedValues: [],
};

describe('numeric flagging', () => {
  it('calls a value inside the band normal', () => {
    expect(flagNumeric(4.2, potassium)).toBe('normal');
  });

  it('flags low and high without reaching for the panic bounds', () => {
    expect(flagNumeric(3.2, potassium)).toBe('low');
    expect(flagNumeric(5.6, potassium)).toBe('high');
  });

  it('flags a panic value critical', () => {
    expect(flagNumeric(6.8, potassium)).toBe('critical_high');
    expect(flagNumeric(2.1, potassium)).toBe('critical_low');
  });

  it('treats a value exactly on a panic bound as critical', () => {
    // Inclusive on purpose: the false negative here is an unreported panic
    // value, so a borderline number goes the safe way.
    expect(flagNumeric(6.0, potassium)).toBe('critical_high');
    expect(flagNumeric(2.5, potassium)).toBe('critical_low');
  });

  it('treats a value exactly on the normal bound as normal', () => {
    expect(flagNumeric(5.1, potassium)).toBe('normal');
    expect(flagNumeric(3.5, potassium)).toBe('normal');
  });

  it('says normal when there is no interval at all, and never critical', () => {
    // An analyte with no reference range cannot be flagged, and inventing a
    // flag from nothing would be worse than admitting there is none.
    expect(flagNumeric(999, NO_INTERVAL)).toBe('normal');
    expect(isCriticalFlag(flagNumeric(999, NO_INTERVAL))).toBe(false);
  });
});

describe('coded flagging', () => {
  const hiv: ReferenceInterval = {
    low: null,
    high: null,
    criticalLow: null,
    criticalHigh: null,
    textNormal: 'Non-reactive',
    criticalCodedValues: ['Reactive'],
  };

  it('raises the critical machinery for a coded panic value', () => {
    // `critical_high` rather than a flag of its own: `is_critical` is what the
    // alert trigger fires on, and it is true for exactly the two critical flags.
    expect(flagCoded('Reactive', hiv)).toBe('critical_high');
    expect(isCriticalFlag(flagCoded('Reactive', hiv))).toBe(true);
  });

  it('matches case-insensitively, because a bench types what it types', () => {
    expect(flagCoded('  reactive ', hiv)).toBe('critical_high');
  });

  it('calls the declared normal value normal and anything else abnormal', () => {
    expect(flagCoded('Non-reactive', hiv)).toBe('normal');
    expect(flagCoded('Equivocal', hiv)).toBe('abnormal');
  });

  it('says indeterminate rather than normal when nothing declares what normal is', () => {
    expect(flagCoded('Whatever', NO_INTERVAL)).toBe('indeterminate');
  });
});

describe('absurd bounds', () => {
  it('refuses a physically impossible value', () => {
    expect(isAbsurd(1400, { absurdLow: 0.5, absurdHigh: 12 })).toBe(true);
    expect(isAbsurd(0.1, { absurdLow: 0.5, absurdHigh: 12 })).toBe(true);
  });

  it('leaves a merely critical value alone — absurd is not abnormal', () => {
    expect(isAbsurd(6.8, { absurdLow: 0.5, absurdHigh: 12 })).toBe(false);
  });

  it('accepts everything when no bounds are configured', () => {
    expect(isAbsurd(1e9, { absurdLow: null, absurdHigh: null })).toBe(false);
  });
});

describe('delta check', () => {
  it('fires on an absolute change at or beyond the threshold', () => {
    const rule = { mode: 'absolute', threshold: 1.5, action: 'flag' };
    expect(deltaBreached(6.0, { value: 4.0, hoursAgo: 6 }, rule)).toBe(true);
    expect(deltaBreached(4.5, { value: 4.0, hoursAgo: 6 }, rule)).toBe(false);
  });

  it('fires on a percentage change', () => {
    const rule = { mode: 'percent', threshold: 25, action: 'hold' };
    expect(deltaBreached(5.0, { value: 4.0, hoursAgo: 2 }, rule)).toBe(true);
    expect(deltaBreached(4.4, { value: 4.0, hoursAgo: 2 }, rule)).toBe(false);
  });

  it('does not divide by a previous value of zero', () => {
    const rule = { mode: 'percent', threshold: 25, action: 'flag' };
    expect(deltaBreached(5, { value: 0, hoursAgo: 1 }, rule)).toBe(false);
  });

  it('fires on a rate per hour', () => {
    const rule = { mode: 'rate_per_hour', threshold: 0.5, action: 'flag' };
    expect(deltaBreached(6.0, { value: 4.0, hoursAgo: 2 }, rule)).toBe(true);
    expect(deltaBreached(6.0, { value: 4.0, hoursAgo: 10 }, rule)).toBe(false);
  });

  it('does not fire on a mode nobody can evaluate', () => {
    expect(
      deltaBreached(99, { value: 1, hoursAgo: 1 }, { mode: 'vibes', threshold: 1, action: 'hold' }),
    ).toBe(false);
  });
});

describe('the event flag vocabulary', () => {
  it('passes the five it shares through unchanged', () => {
    expect(toEventFlag('critical_high')).toBe('critical_high');
    expect(toEventFlag('low')).toBe('low');
  });

  it('collapses the qualitative flags to abnormal', () => {
    expect(toEventFlag('reactive')).toBe('abnormal');
    expect(toEventFlag('indeterminate')).toBe('abnormal');
  });
});
