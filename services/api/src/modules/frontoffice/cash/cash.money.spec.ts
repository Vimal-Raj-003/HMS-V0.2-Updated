import { Money } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../core/problem/app-error.js';
import { assertSplitBalances, countSheet, moneyFromDb, toCurrencyCode } from './cash.money.js';

describe('denomination sheet', () => {
  it('adds up a real drawer exactly', () => {
    const sheet = countSheet(
      [
        { denomination: '500', count: 84 },
        { denomination: '200', count: 13 },
        { denomination: '100', count: 27 },
        { denomination: '20', count: 9 },
        { denomination: '10', count: 14 },
        { denomination: '1', count: 6 },
      ],
      'INR',
    );
    expect(sheet.total.toDecimalString()).toBe('47626.00');
  });

  it('is exact where floating point is not', () => {
    // 0.1 + 0.2 in IEEE-754 is 0.30000000000000004; three ten-paise coins are
    // thirty paise, and a drawer that disagrees will not close.
    const sheet = countSheet(
      [
        { denomination: '0.10', count: 1 },
        { denomination: '0.20', count: 1 },
      ],
      'INR',
    );
    expect(sheet.total.toDecimalString()).toBe('0.30');
  });

  it('stores the per-line amount alongside the count', () => {
    const sheet = countSheet([{ denomination: '2000', count: 3 }], 'INR');
    expect(sheet.lines).toEqual([{ denomination: '2000.00', count: 3, amount: '6000.00' }]);
  });

  it('counts an empty drawer as zero rather than as unknown', () => {
    expect(countSheet([], 'INR').total.toDecimalString()).toBe('0.00');
  });

  it('refuses half a note', () => {
    expect(() => countSheet([{ denomination: '500', count: 1.5 }], 'INR')).toThrow(AppError);
  });

  it('refuses a zero-value denomination', () => {
    expect(() => countSheet([{ denomination: '0', count: 10 }], 'INR')).toThrow(AppError);
  });
});

describe('split tenders', () => {
  it('accepts a split that balances to the paisa', () => {
    expect(() =>
      assertSplitBalances(Money.parse('1500.00', 'INR'), [
        Money.parse('500.00', 'INR'),
        Money.parse('1000.00', 'INR'),
      ]),
    ).not.toThrow();
  });

  it('refuses a split that is one paisa short', () => {
    expect(() =>
      assertSplitBalances(Money.parse('1500.00', 'INR'), [
        Money.parse('500.00', 'INR'),
        Money.parse('999.99', 'INR'),
      ]),
    ).toThrow(/must balance exactly/);
  });

  it('refuses a split that overshoots', () => {
    expect(() => assertSplitBalances(Money.parse('1500.00', 'INR'), [Money.parse('1500.01', 'INR')])).toThrow(
      AppError,
    );
  });
});

describe('currency and numeric columns', () => {
  it('reads a numeric(14,2) column without going through a float', () => {
    expect(moneyFromDb('1234.55', 'INR').minor).toBe(123455n);
    expect(moneyFromDb(null, 'INR').toDecimalString()).toBe('0.00');
  });

  it('accepts the configured currencies and refuses anything else', () => {
    expect(toCurrencyCode('inr')).toBe('INR');
    expect(() => toCurrencyCode('XYZ')).toThrow(AppError);
  });
});
