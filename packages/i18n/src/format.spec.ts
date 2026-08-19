import { describe, expect, it } from 'vitest';

import { I18nError, LOCALE_CODES } from './locales.js';
import {
  currencySymbol,
  formatAbbreviatedForDashboardOnly,
  formatCurrency,
  formatDate,
  formatDateLong,
  formatDateTime,
  formatNumber,
  formatTime,
  groupIndian,
  groupWestern,
  zonedParts,
} from './format.js';

describe('Indian lakh/crore grouping (docs/06 §8)', () => {
  it('groups the last three digits, then pairs', () => {
    expect(groupIndian('1')).toBe('1');
    expect(groupIndian('12')).toBe('12');
    expect(groupIndian('123')).toBe('123');
    expect(groupIndian('1234')).toBe('1,234');
    expect(groupIndian('12345')).toBe('12,345');
    expect(groupIndian('123456')).toBe('1,23,456');
    expect(groupIndian('1234567')).toBe('12,34,567');
    expect(groupIndian('12345678')).toBe('1,23,45,678');
    expect(groupIndian('123456789')).toBe('12,34,56,789');
    expect(groupIndian('1234567890')).toBe('1,23,45,67,890');
  });

  it('differs from Western grouping above one lakh', () => {
    expect(groupWestern('12345678')).toBe('12,345,678');
    expect(groupIndian('12345678')).toBe('1,23,45,678');
  });

  it('formats en-IN money with Indian grouping and exactly two decimals', () => {
    expect(formatCurrency(1234567.5, 'en-IN')).toBe('₹12,34,567.50');
    expect(formatCurrency('12345678.99', 'en-IN')).toBe('₹1,23,45,678.99');
    expect(formatCurrency(-4250, 'en-IN')).toBe('-₹4,250.00');
    expect(formatCurrency(4250, 'en-IN', { withSymbol: false })).toBe('4,250.00');
  });

  it('uses Indian grouping for every Indian language and Western for ar', () => {
    for (const code of LOCALE_CODES.filter((c) => c !== 'ar')) {
      expect(formatNumber(12345678, code), code).toBe('1,23,45,678');
    }
    expect(formatNumber(12345678, 'ar')).toBe('12,345,678');
    expect(formatCurrency(1234.5, 'ar')).toBe('د.إ1,234.50');
  });

  it('formats a Postgres numeric string without going through a float', () => {
    expect(formatNumber('99999999999.99', 'en-IN', { fractionDigits: 2 })).toBe('99,99,99,99,999.99');
    expect(formatNumber('0.005', 'en-IN', { fractionDigits: 2 })).toBe('0.00');
  });

  it('rejects values that are not numbers', () => {
    expect(() => formatNumber('twelve', 'en-IN')).toThrow(I18nError);
    expect(() => formatNumber(Number.NaN, 'en-IN')).toThrow(I18nError);
    expect(() => formatNumber(Number.POSITIVE_INFINITY, 'en-IN')).toThrow(I18nError);
  });

  it('falls back to the currency code for an unknown symbol', () => {
    expect(currencySymbol('INR')).toBe('₹');
    expect(currencySymbol('XYZ')).toBe('XYZ');
  });
});

describe('lakh/crore abbreviation (dashboards only)', () => {
  it('abbreviates at crore, lakh and thousand boundaries', () => {
    expect(formatAbbreviatedForDashboardOnly(12_400_000, 'en-IN')).toBe('₹1.24 Cr');
    expect(formatAbbreviatedForDashboardOnly(850_000, 'en-IN')).toBe('₹8.50 L');
    expect(formatAbbreviatedForDashboardOnly(4250, 'en-IN')).toBe('₹4.3 K');
    expect(formatAbbreviatedForDashboardOnly(-12_400_000, 'en-IN')).toBe('-₹1.24 Cr');
  });

  it('shows the exact value below a thousand, where an abbreviation would lose money', () => {
    expect(formatAbbreviatedForDashboardOnly(999, 'en-IN')).toBe('₹999.00');
  });

  it('does not abbreviate in Western-grouping locales', () => {
    expect(formatAbbreviatedForDashboardOnly(12_400_000, 'ar')).toBe('د.إ12,400,000.00');
  });
});

describe('dates and times in the hospital time zone', () => {
  // 2026-08-19T18:45:00Z is 2026-08-20 00:15 IST — deliberately across the date line.
  const instant = new Date('2026-08-19T18:45:00.000Z');

  it('renders dd-MM-yyyy on screen and dd-MMM-yyyy on documents', () => {
    expect(formatDate(instant, 'Asia/Kolkata')).toBe('20-08-2026');
    expect(formatDateLong(instant, 'Asia/Kolkata')).toBe('20-Aug-2026');
  });

  it('renders 24-hour times and respects the zone', () => {
    expect(formatTime(instant, 'Asia/Kolkata')).toBe('00:15');
    expect(formatTime(instant, 'UTC')).toBe('18:45');
    expect(formatDateTime(instant, 'UTC')).toBe('19-08-2026 18:45');
    expect(formatDate(instant, 'Asia/Dubai')).toBe('19-08-2026');
  });

  it('renders midnight as 00:00, never 24:00', () => {
    expect(formatTime(new Date('2026-01-01T00:00:00.000Z'), 'UTC')).toBe('00:00');
  });

  it('exposes the raw zoned parts', () => {
    expect(zonedParts(instant, 'Asia/Kolkata')).toEqual({
      year: '2026',
      month: '08',
      day: '20',
      hour: '00',
      minute: '15',
    });
  });

  it('refuses an invalid Date instead of printing "Invalid Date" on a bill', () => {
    expect(() => formatDate(new Date('not-a-date'), 'Asia/Kolkata')).toThrow(I18nError);
  });
});
