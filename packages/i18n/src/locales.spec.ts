import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOCALE,
  I18nError,
  LOCALES,
  LOCALE_CODES,
  getLocaleMeta,
  isLocaleCode,
  isRtl,
  localeDirection,
  matchAcceptLanguage,
  parseLocale,
  parseLocaleOrDefault,
} from './locales.js';

describe('locale registry (D-13)', () => {
  it('is exactly the superset CLAUDE.md §4 mandates: en-IN plus eleven', () => {
    expect(LOCALE_CODES).toEqual(['en-IN', 'hi', 'ta', 'te', 'ml', 'kn', 'mr', 'bn', 'gu', 'or', 'pa', 'ar']);
    expect(LOCALE_CODES).toHaveLength(12);
    expect(DEFAULT_LOCALE).toBe('en-IN');
  });

  it('has metadata for every code and no orphan metadata', () => {
    expect(Object.keys(LOCALES).sort()).toEqual([...LOCALE_CODES].sort());
    for (const code of LOCALE_CODES) {
      expect(getLocaleMeta(code).code).toBe(code);
      expect(getLocaleMeta(code).nativeName.length).toBeGreaterThan(0);
    }
  });

  it('marks ar as the only RTL locale', () => {
    expect(isRtl('ar')).toBe(true);
    expect(localeDirection('ar')).toBe('rtl');
    const rtl = LOCALE_CODES.filter((code) => isRtl(code));
    expect(rtl).toEqual(['ar']);
    for (const code of LOCALE_CODES.filter((c) => c !== 'ar')) {
      expect(localeDirection(code)).toBe('ltr');
    }
  });

  it('uses Indian digit grouping for en-IN and every Indian language, Western for ar', () => {
    for (const code of LOCALE_CODES.filter((c) => c !== 'ar')) {
      expect(getLocaleMeta(code).numberGrouping).toBe('indian');
    }
    expect(getLocaleMeta('ar').numberGrouping).toBe('western');
  });

  it('pins Latin digits in every BCP-47 tag (a dose in Devanagari numerals is a safety hazard)', () => {
    for (const code of LOCALE_CODES) {
      expect(getLocaleMeta(code).bcp47).toContain('-u-nu-latn');
    }
  });

  it('boosts line-height for Indic and Arabic scripts and forbids uppercasing them (docs/06 §8)', () => {
    expect(getLocaleMeta('en-IN').lineHeightBoostPx).toBe(0);
    expect(getLocaleMeta('en-IN').uppercaseAllowed).toBe(true);
    for (const code of LOCALE_CODES.filter((c) => c !== 'en-IN')) {
      expect(getLocaleMeta(code).lineHeightBoostPx).toBe(2);
      expect(getLocaleMeta(code).uppercaseAllowed).toBe(false);
    }
  });

  it('uses one date/time convention across the superset (docs/06 §8)', () => {
    for (const code of LOCALE_CODES) {
      const meta = getLocaleMeta(code);
      expect(meta.dateFormat).toBe('dd-MM-yyyy');
      expect(meta.longDateFormat).toBe('dd-MMM-yyyy');
      expect(meta.timeFormat).toBe('HH:mm');
    }
  });
});

describe('parsing untrusted locale input', () => {
  it('accepts members of the superset', () => {
    expect(isLocaleCode('ta')).toBe(true);
    expect(parseLocale('ar')).toBe('ar');
  });

  it('rejects anything outside it, naming the superset', () => {
    expect(isLocaleCode('en-US')).toBe(false);
    expect(() => parseLocale('en-US')).toThrow(I18nError);
    expect(() => parseLocale('en-US')).toThrow(/D-13/);
    expect(() => parseLocale(undefined)).toThrow(I18nError);
  });

  it('degrades instead of throwing where a request must not fail', () => {
    expect(parseLocaleOrDefault('fr')).toBe('en-IN');
    expect(parseLocaleOrDefault('hi')).toBe('hi');
  });
});

describe('matchAcceptLanguage', () => {
  it('prefers an exact enabled tag, honouring q-weights', () => {
    expect(matchAcceptLanguage('ta;q=0.4,hi;q=0.9', ['en-IN', 'hi', 'ta'])).toBe('hi');
  });

  it('falls back to the primary subtag', () => {
    expect(matchAcceptLanguage('ta-IN,en;q=0.5', ['en-IN', 'ta'])).toBe('ta');
  });

  it('maps any English variant onto en-IN', () => {
    expect(matchAcceptLanguage('en-GB,en;q=0.9', ['en-IN', 'hi'])).toBe('en-IN');
  });

  it('never returns a locale the hospital has not enabled', () => {
    expect(matchAcceptLanguage('ar', ['en-IN', 'hi'])).toBe('en-IN');
  });

  it('falls back to en-IN for junk headers', () => {
    expect(matchAcceptLanguage('', ['en-IN', 'hi'])).toBe('en-IN');
    expect(matchAcceptLanguage('*;q=0', ['en-IN'])).toBe('en-IN');
  });
});
