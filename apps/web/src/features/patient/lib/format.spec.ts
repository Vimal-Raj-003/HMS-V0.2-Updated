import { describe, expect, it } from 'vitest';
import { formatAge, formatDate, mobileLast4, splitName, toSex } from './format';

const NOW = new Date('2026-08-22T09:00:00.000Z');

describe('age', () => {
  it('counts a neonate in days, an infant in months and everybody else in years', () => {
    // "0 y" on a paediatric banner is the dosing error waiting to happen, which
    // is why the unit changes rather than the number rounding to zero.
    expect(formatAge({ dob: '2026-08-12T00:00:00.000Z' }, NOW)).toBe('10 d');
    expect(formatAge({ dob: '2026-02-22T00:00:00.000Z' }, NOW)).toBe('6 m');
    expect(formatAge({ dob: '1981-04-12T00:00:00.000Z' }, NOW)).toBe('45 y');
  });

  it('marks an estimated date of birth so nobody reads it as a known birthday', () => {
    expect(formatAge({ dob: '1981-01-01T00:00:00.000Z', dob_is_estimated: true }, NOW)).toBe('~45 y');
  });

  it('falls back to the stored age components when there is no date of birth', () => {
    expect(formatAge({ dob: null, age_years: 62 }, NOW)).toBe('62 y');
    expect(formatAge({ dob: null, age_years: 0, age_months: 5 }, NOW)).toBe('5 m');
    expect(formatAge({ dob: null, age_years: 0, age_months: 0, age_days: 3 }, NOW)).toBe('3 d');
  });

  it('says so rather than guessing when nothing is known', () => {
    expect(formatAge({ dob: null }, NOW)).toBe('—');
  });

  it('does not render a negative age for a date in the future', () => {
    expect(formatAge({ dob: '2030-01-01T00:00:00.000Z' }, NOW)).toBe('—');
  });
});

describe('names', () => {
  it('splits the server’s “FAMILY, Given” into the two halves the banner emphasises', () => {
    expect(splitName('SHARMA, Ramesh Kumar')).toEqual({ familyName: 'SHARMA', givenName: 'Ramesh Kumar' });
  });

  it('treats a single-name patient as all given name rather than inventing a surname', () => {
    expect(splitName('Lakshmi')).toEqual({ familyName: '', givenName: 'Lakshmi' });
  });

  it('falls back to the last word when there is no comma', () => {
    expect(splitName('Ramesh Kumar Sharma')).toEqual({
      familyName: 'Sharma',
      givenName: 'Ramesh Kumar',
    });
  });
});

describe('the only part of a mobile number a result list may show', () => {
  it('returns the last four digits, ignoring the country code and punctuation', () => {
    expect(mobileLast4('+91 98450-12345')).toBe('2345');
  });

  it('returns nothing rather than a partial number when there are too few digits', () => {
    expect(mobileLast4('12')).toBeUndefined();
  });
});

describe('sex', () => {
  it('maps the four enum arms and treats anything else as unknown rather than crashing', () => {
    expect(toSex('female')).toBe('female');
    expect(toSex('nonbinary')).toBe('unknown');
  });
});

describe('dates', () => {
  it('renders dd-MM-yyyy in the hospital’s zone, never the browser’s', () => {
    // 19:00 UTC on the 11th is already the 12th in Asia/Kolkata, and the
    // hospital's day is the one on the paper register.
    expect(formatDate('2026-08-11T19:00:00.000Z')).toBe('12-08-2026');
  });

  it('renders an em dash for a missing date rather than “Invalid Date”', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate('not a date')).toBe('—');
  });
});
