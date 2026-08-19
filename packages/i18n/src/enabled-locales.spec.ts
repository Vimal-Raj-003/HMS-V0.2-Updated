import { describe, expect, it } from 'vitest';

import {
  assertLocaleRemovable,
  enabledLocalesSchema,
  isLocaleEnabled,
  localeCodeSchema,
  pickLocale,
  resolveHospitalLocales,
} from './enabled-locales.js';
import { I18nError } from './locales.js';
import { buildRequestConfig, htmlAttributes } from './next-intl.js';

describe('per-hospital enabled locales', () => {
  it('keeps registry order and de-duplicates', () => {
    const config = resolveHospitalLocales({ enabledLocales: ['ta', 'hi', 'ta', 'en-IN'] });
    expect(config.enabledLocales).toEqual(['en-IN', 'hi', 'ta']);
  });

  it('re-adds en-IN when a hospital tries to disable it', () => {
    const config = resolveHospitalLocales({ enabledLocales: ['hi', 'mr'] });
    expect(config.enabledLocales[0]).toBe('en-IN');
    expect(isLocaleEnabled(config, 'en-IN')).toBe(true);
  });

  it('defaults to en-IN only when nothing is configured', () => {
    expect(resolveHospitalLocales().enabledLocales).toEqual(['en-IN']);
    expect(resolveHospitalLocales({}).defaultLocale).toBe('en-IN');
  });

  it('honours a default locale that the hospital actually enables', () => {
    const config = resolveHospitalLocales({ defaultLocale: 'hi', enabledLocales: ['hi', 'en-IN'] });
    expect(config.defaultLocale).toBe('hi');
  });

  it('ignores a default locale the hospital has not enabled', () => {
    const config = resolveHospitalLocales({ defaultLocale: 'ml', enabledLocales: ['hi'] });
    expect(config.defaultLocale).toBe('en-IN');
  });

  it('rejects codes outside the D-13 superset', () => {
    expect(() => resolveHospitalLocales({ enabledLocales: ['hi', 'fr'] })).toThrow(I18nError);
    expect(() => resolveHospitalLocales({ defaultLocale: 'en-US' })).toThrow(I18nError);
  });

  it('refuses to let the admin console remove en-IN, with a reason', () => {
    expect(() => assertLocaleRemovable('en-IN')).toThrow(/cannot be disabled/);
    expect(() => assertLocaleRemovable('hi')).not.toThrow();
  });

  it('validates settings payloads with the same superset', () => {
    expect(localeCodeSchema.safeParse('or').success).toBe(true);
    expect(localeCodeSchema.safeParse('en-US').success).toBe(false);
    expect(enabledLocalesSchema.safeParse(['en-IN', 'hi']).success).toBe(true);
    expect(enabledLocalesSchema.safeParse([]).success).toBe(false);
  });
});

describe('pickLocale', () => {
  const config = resolveHospitalLocales({ defaultLocale: 'hi', enabledLocales: ['hi', 'ta'] });

  it('uses the user preference when enabled', () => {
    expect(pickLocale(config, 'ta')).toBe('ta');
  });

  it('falls back to the hospital default for a disabled or unknown preference', () => {
    expect(pickLocale(config, 'ar')).toBe('hi');
    expect(pickLocale(config, 'klingon')).toBe('hi');
    expect(pickLocale(config, undefined)).toBe('hi');
  });
});

describe('next-intl request config', () => {
  const config = resolveHospitalLocales({ defaultLocale: 'en-IN', enabledLocales: ['en-IN', 'ar'] });

  it('carries direction, tag and typography rules with the messages', () => {
    const request = buildRequestConfig('ar', config, 'Asia/Dubai');
    expect(request.locale).toBe('ar');
    expect(request.direction).toBe('rtl');
    expect(request.timeZone).toBe('Asia/Dubai');
    expect(request.bcp47).toBe('ar-AE-u-nu-latn');
    expect(request.lineHeightBoostPx).toBe(2);
    expect(request.uppercaseAllowed).toBe(false);
    expect(request.messages['errors']).toBeDefined();
  });

  it('degrades an unknown request locale to the hospital default', () => {
    expect(buildRequestConfig('de', config, 'Asia/Kolkata').locale).toBe('en-IN');
    expect(buildRequestConfig(undefined, config, 'Asia/Kolkata').direction).toBe('ltr');
  });

  it('produces html lang/dir attributes from the registry', () => {
    expect(htmlAttributes('ar')).toEqual({ lang: 'ar', dir: 'rtl' });
    expect(htmlAttributes('ta')).toEqual({ lang: 'ta', dir: 'ltr' });
  });
});
