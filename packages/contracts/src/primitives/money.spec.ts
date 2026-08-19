import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money, MoneyError, currencyMeta } from './money.js';

/**
 * `docs/09 §2` puts money arithmetic on the **100 % coverage list** and makes
 * property-based tests mandatory for "rounding and tax splitting".
 *
 * Each test name states the rule, not the method (docs/09 §2).
 */

const anyMinor = fc.bigInt({ min: -99_999_999_999_999n, max: 99_999_999_999_999n });

describe('Money construction', () => {
  it('rejects a fractional minor-unit count, because half a paisa is not a thing', () => {
    expect(() => Money.fromMinor(10.5, 'INR')).toThrow(MoneyError);
  });

  it('rejects an unsafe integer rather than silently losing precision', () => {
    expect(() => Money.fromMinor(Number.MAX_SAFE_INTEGER + 2, 'INR')).toThrow(MoneyError);
  });

  it('refuses an amount beyond numeric(14,2), rather than letting Postgres truncate it at insert time', () => {
    expect(() => Money.fromMinor(100_000_000_000_000n, 'INR')).toThrow(/numeric\(14,2\)/);
  });

  it('accepts a plain safe integer and an integer string as minor units', () => {
    expect(Money.fromMinor(123_450, 'INR').toDecimalString()).toBe('1234.50');
    expect(Money.fromMinor('123450', 'INR').toDecimalString()).toBe('1234.50');
    expect(Money.fromMinor('-1', 'INR').minor).toBe(-1n);
  });

  it('refuses a decimal string in fromMinor, which is the classic rupee/paise mix-up', () => {
    // `fromMinor("1234.50")` means someone passed rupees where paise were expected;
    // accepting it would under-bill by a factor of 100.
    expect(() => Money.fromMinor('1234.50', 'INR')).toThrow(/integer string/);
    expect(() => Money.fromMinor('₹1234', 'INR')).toThrow(MoneyError);
  });

  it('carries its currency with it, so an amount can never be read as a bare number', () => {
    const m = Money.parse('10.00', 'AED');
    expect(m.currency).toBe('AED');
    expect(m.minor).toBe(1_000n);
  });

  it('parses a decimal string exactly as written', () => {
    expect(Money.parse('1234.50', 'INR').minor).toBe(123_450n);
    expect(Money.parse('0.01', 'INR').minor).toBe(1n);
    expect(Money.parse('-99.99', 'INR').minor).toBe(-9_999n);
  });

  it('tolerates Indian grouping and a currency symbol on paste', () => {
    expect(Money.parse('₹1,23,456.75', 'INR').minor).toBe(12_345_675n);
  });

  it('treats a missing fractional part as zero paise, not as an error', () => {
    expect(Money.parse('1234', 'INR').toDecimalString()).toBe('1234.00');
  });

  it('treats a missing integer part as zero rupees, in both signs', () => {
    // A cashier typing ".50" means fifty paise, not a parse failure.
    expect(Money.parse('.50', 'INR').minor).toBe(50n);
    expect(Money.parse('-.50', 'INR').minor).toBe(-50n);
  });

  it('refuses a third decimal place instead of rounding it away silently', () => {
    expect(() => Money.parse('10.005', 'INR')).toThrow(/Round explicitly/);
  });

  it('refuses input that contains no digits at all', () => {
    expect(() => Money.parse('₹', 'INR')).toThrow(MoneyError);
    expect(() => Money.parse('abc', 'INR')).toThrow(MoneyError);
  });

  it('rejects an unknown currency at the metadata boundary', () => {
    // Cast is the point of the test: data arriving from the database is not typed.
    expect(() => currencyMeta('XXX' as never)).toThrow(MoneyError);
  });
});

describe('Money arithmetic', () => {
  it('refuses to add two different currencies instead of guessing a rate', () => {
    const inr = Money.parse('100.00', 'INR');
    const aed = Money.parse('100.00', 'AED');
    expect(() => inr.add(aed)).toThrow(/Convert explicitly/);
    expect(() => inr.subtract(aed)).toThrow(MoneyError);
    expect(() => inr.compare(aed)).toThrow(MoneyError);
  });

  it('round-trips through a decimal string without loss, for every representable amount', () => {
    fc.assert(
      fc.property(anyMinor, (minor) => {
        const m = Money.fromMinor(minor, 'INR');
        expect(Money.parse(m.toDecimalString(), 'INR').minor).toBe(minor);
      }),
      { numRuns: 500 },
    );
  });

  it('round-trips through JSON without loss', () => {
    fc.assert(
      fc.property(anyMinor, (minor) => {
        const m = Money.fromMinor(minor, 'INR');
        expect(Money.fromJson(m.toJson()).equals(m)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('is associative and commutative under addition, so bill-line order cannot change a total', () => {
    fc.assert(
      fc.property(anyMinor, anyMinor, (a, b) => {
        // Halve the inputs so the sum cannot overflow the numeric(14,2) range.
        const x = Money.fromMinor(a / 2n, 'INR');
        const y = Money.fromMinor(b / 2n, 'INR');
        expect(x.add(y).equals(y.add(x))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('treats zero as the additive identity', () => {
    fc.assert(
      fc.property(anyMinor, (minor) => {
        const m = Money.fromMinor(minor, 'INR');
        expect(m.add(Money.zero('INR')).equals(m)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('multiplies by a whole quantity exactly', () => {
    expect(Money.parse('350.00', 'INR').timesQuantity(3).toDecimalString()).toBe('1050.00');
    expect(Money.parse('0.01', 'INR').timesQuantity(0).isZero).toBe(true);
  });

  it('accepts a bigint quantity, for counts that came out of the database as bigint', () => {
    expect(Money.parse('350.00', 'INR').timesQuantity(3n).toDecimalString()).toBe('1050.00');
    expect(Money.parse('350.00', 'INR').timesQuantity(-2n).toDecimalString()).toBe('-700.00');
  });

  it('refuses a fractional quantity, directing the caller to a rounding-mode-explicit API', () => {
    expect(() => Money.parse('100.00', 'INR').timesQuantity(1.5)).toThrow(/multiplyByRate/);
  });

  it('reports absolute value, negation and sign predicates', () => {
    const negative = Money.parse('-42.50', 'INR');
    expect(negative.isNegative).toBe(true);
    expect(negative.isPositive).toBe(false);
    expect(negative.abs().toDecimalString()).toBe('42.50');
    expect(negative.negate().toDecimalString()).toBe('42.50');
    expect(Money.zero('INR').isZero).toBe(true);

    const positive = Money.parse('42.50', 'INR');
    expect(positive.isPositive).toBe(true);
    expect(positive.isNegative).toBe(false);
    // abs() of a positive amount must be the identity, not a sign flip.
    expect(positive.abs().toDecimalString()).toBe('42.50');
    expect(positive.negate().toDecimalString()).toBe('-42.50');
  });
});

describe('Money rates, percentages and rounding', () => {
  it('computes 18 % GST on ₹1,000 as ₹180.00', () => {
    const { value } = Money.parse('1000.00', 'INR').percentage('18');
    expect(value.toDecimalString()).toBe('180.00');
  });

  it('parses a fractional rate exactly, without touching parseFloat', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; this is the reason the class exists.
    const { value } = Money.parse('0.30', 'INR').multiplyByRate('1', 'half-up');
    expect(value.toDecimalString()).toBe('0.30');
  });

  it('rounds half away from zero under half-up, in both directions', () => {
    // 5 paise at 50 % = 2.5 paise
    expect(Money.fromMinor(5n, 'INR').multiplyByRate('0.5', 'half-up').value.minor).toBe(3n);
    expect(Money.fromMinor(-5n, 'INR').multiplyByRate('0.5', 'half-up').value.minor).toBe(-3n);
  });

  it('leaves anything below half alone under half-up', () => {
    // 1 paisa at 40 % = 0.4 paise, which must not become a paisa.
    expect(Money.fromMinor(1n, 'INR').multiplyByRate('0.4', 'half-up').value.minor).toBe(0n);
  });

  it('rounds half to even under half-even, so repeated operations do not drift upward', () => {
    expect(Money.fromMinor(5n, 'INR').multiplyByRate('0.5', 'half-even').value.minor).toBe(2n);
    expect(Money.fromMinor(15n, 'INR').multiplyByRate('0.5', 'half-even').value.minor).toBe(8n);
  });

  it('still rounds normally under half-even when the remainder is not exactly half', () => {
    // Only the exact tie goes to even; everything else follows the nearer value.
    expect(Money.fromMinor(1n, 'INR').multiplyByRate('0.6', 'half-even').value.minor).toBe(1n);
    expect(Money.fromMinor(1n, 'INR').multiplyByRate('0.4', 'half-even').value.minor).toBe(0n);
  });

  it('does not invent a rounding adjustment when a negative amount divides exactly', () => {
    // A refund of ₹0.10 at 50 % is exactly −₹0.05 — the bill must show no rounding line.
    const { value, roundingAdjustment } = Money.fromMinor(-10n, 'INR').multiplyByRate('0.5', 'half-up');
    expect(value.minor).toBe(-5n);
    expect(roundingAdjustment.isZero).toBe(true);
  });

  it('accepts a negative rate, because a discount is a negative-rate line', () => {
    const { value } = Money.parse('100.00', 'INR').multiplyByRate('-0.18', 'half-up');
    expect(value.toDecimalString()).toBe('-18.00');
  });

  it('accepts a rate written without its leading zero', () => {
    // Tariff masters imported from spreadsheets routinely carry ".5" rather than "0.5".
    expect(Money.parse('100.00', 'INR').multiplyByRate('.5', 'half-up').value.toDecimalString()).toBe('50.00');
    expect(Money.parse('100.00', 'INR').percentage('.5').value.toDecimalString()).toBe('0.50');
  });

  it('truncates toward zero under "down" and away under "up"', () => {
    expect(Money.fromMinor(7n, 'INR').multiplyByRate('0.5', 'down').value.minor).toBe(3n);
    expect(Money.fromMinor(7n, 'INR').multiplyByRate('0.5', 'up').value.minor).toBe(4n);
    expect(Money.fromMinor(-7n, 'INR').multiplyByRate('0.5', 'down').value.minor).toBe(-3n);
    expect(Money.fromMinor(-7n, 'INR').multiplyByRate('0.5', 'up').value.minor).toBe(-4n);
  });

  it('reports the rounding adjustment separately, so a bill can show it as an explicit line', () => {
    // docs/06 §5.2 #24: "Never rounds silently — rounding shows as an explicit line."
    const { value, roundingAdjustment } = Money.fromMinor(5n, 'INR').multiplyByRate('0.5', 'half-up');
    expect(value.minor).toBe(3n);
    expect(roundingAdjustment.minor).toBe(1n);
  });

  it('rounds to whole rupees on request and reports the adjustment', () => {
    const { value, roundingAdjustment } = Money.parse('1234.56', 'INR').roundTo(100n, 'half-up');
    expect(value.toDecimalString()).toBe('1235.00');
    expect(roundingAdjustment.toDecimalString()).toBe('0.44');
  });

  it('refuses a non-positive rounding multiple', () => {
    expect(() => Money.parse('10.00', 'INR').roundTo(0n)).toThrow(MoneyError);
  });

  it('refuses an unparseable rate or percentage', () => {
    expect(() => Money.parse('10.00', 'INR').multiplyByRate('abc', 'half-up')).toThrow(MoneyError);
    expect(() => Money.parse('10.00', 'INR').percentage('')).toThrow(MoneyError);
  });
});

describe('Money splitting and allocation', () => {
  it('splits evenly with the remainder handed out, so parts always sum to the whole', () => {
    const parts = Money.parse('100.00', 'INR').splitEvenly(3);
    expect(parts.map((p) => p.toDecimalString())).toEqual(['33.34', '33.33', '33.33']);
    expect(Money.sum(parts, 'INR').toDecimalString()).toBe('100.00');
  });

  it('splits a negative amount without losing a paisa either', () => {
    const parts = Money.parse('-100.00', 'INR').splitEvenly(3);
    expect(Money.sum(parts, 'INR').toDecimalString()).toBe('-100.00');
  });

  it('never creates or destroys money when splitting, for any amount and any part count', () => {
    fc.assert(
      fc.property(anyMinor, fc.integer({ min: 1, max: 60 }), (minor, parts) => {
        const total = Money.fromMinor(minor, 'INR');
        const shares = total.splitEvenly(parts);
        expect(shares).toHaveLength(parts);
        expect(Money.sum(shares, 'INR').minor).toBe(minor);
      }),
      { numRuns: 500 },
    );
  });

  it('refuses a non-positive or fractional part count', () => {
    expect(() => Money.parse('10.00', 'INR').splitEvenly(0)).toThrow(MoneyError);
    expect(() => Money.parse('10.00', 'INR').splitEvenly(2.5)).toThrow(MoneyError);
  });

  it('allocates proportionally to weights and still sums exactly', () => {
    // A ₹100 package split across services weighted 1 : 2 : 3.
    const shares = Money.parse('100.00', 'INR').allocate([1, 2, 3]);
    expect(Money.sum(shares, 'INR').toDecimalString()).toBe('100.00');
    expect(shares[0]!.lessThan(shares[2]!)).toBe(true);
  });

  it('accepts bigint weights, which is what a SUM() out of Postgres returns', () => {
    const shares = Money.parse('100.00', 'INR').allocate([1n, 2n, 3n]);
    expect(shares.map((s) => s.toDecimalString())).toEqual(['16.67', '33.33', '50.00']);
    expect(Money.sum(shares, 'INR').toDecimalString()).toBe('100.00');
  });

  it('never creates or destroys money when allocating, for any weight vector', () => {
    fc.assert(
      fc.property(
        anyMinor,
        fc.array(fc.integer({ min: 0, max: 1_000 }), { minLength: 1, maxLength: 12 }).filter((w) =>
          w.some((x) => x > 0),
        ),
        (minor, weights) => {
          const total = Money.fromMinor(minor, 'INR');
          const shares = total.allocate(weights);
          expect(shares).toHaveLength(weights.length);
          expect(Money.sum(shares, 'INR').minor).toBe(minor);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('refuses an empty, all-zero or negative weight vector', () => {
    expect(() => Money.parse('10.00', 'INR').allocate([])).toThrow(MoneyError);
    expect(() => Money.parse('10.00', 'INR').allocate([0, 0])).toThrow(/non-zero/);
    expect(() => Money.parse('10.00', 'INR').allocate([-1, 2])).toThrow(/negative/);
  });
});

describe('Money comparison', () => {
  it('orders amounts consistently and exposes min/max', () => {
    const a = Money.parse('10.00', 'INR');
    const b = Money.parse('20.00', 'INR');
    expect(a.compare(b)).toBe(-1);
    expect(b.compare(a)).toBe(1);
    expect(a.compare(a)).toBe(0);
    expect(a.lessThan(b)).toBe(true);
    expect(a.lessThanOrEqual(a)).toBe(true);
    expect(b.greaterThan(a)).toBe(true);
    expect(b.greaterThanOrEqual(b)).toBe(true);
    expect(Money.max(a, b).equals(b)).toBe(true);
    expect(Money.min(a, b).equals(a)).toBe(true);
    // Argument order must not change the answer — an "up to ₹X or Y %, whichever
    // is lower" ceiling (docs/05 §Model) is evaluated with either argument first.
    expect(Money.max(b, a).equals(b)).toBe(true);
    expect(Money.min(b, a).equals(a)).toBe(true);
  });

  it('treats amounts in different currencies as unequal rather than throwing on equals', () => {
    expect(Money.parse('10.00', 'INR').equals(Money.parse('10.00', 'AED'))).toBe(false);
  });
});

describe('Money formatting', () => {
  it('groups Indian amounts in the lakh/crore convention', () => {
    // docs/06 §8: Indian grouping `##,##,###.##`.
    expect(Money.parse('12345678.00', 'INR').format()).toBe('₹1,23,45,678.00');
    expect(Money.parse('1234.50', 'INR').format()).toBe('₹1,234.50');
    expect(Money.parse('999.00', 'INR').format()).toBe('₹999.00');
  });

  it('groups non-Indian currencies in thousands', () => {
    expect(Money.parse('12345678.00', 'USD').format()).toBe('$12,345,678.00');
  });

  it('keeps the minus sign outside the currency symbol', () => {
    expect(Money.parse('-1234.50', 'INR').format()).toBe('-₹1,234.50');
  });

  it('can omit the symbol for table cells that carry it in the header', () => {
    expect(Money.parse('1234.50', 'INR').format({ withSymbol: false })).toBe('1,234.50');
  });

  it('abbreviates only through the dashboard-only method, never the default formatter', () => {
    // docs/06 §8 permits lakh/crore abbreviation on dashboards ONLY, and requires
    // the exact value everywhere else — hence the deliberately awkward name.
    const crore = Money.parse('12400000.00', 'INR');
    expect(crore.formatAbbreviatedForDashboardOnly()).toBe('₹1.24 Cr');
    expect(crore.format()).toBe('₹1,24,00,000.00');

    expect(Money.parse('850000.00', 'INR').formatAbbreviatedForDashboardOnly()).toBe('₹8.50 L');
    expect(Money.parse('5500.00', 'INR').formatAbbreviatedForDashboardOnly()).toBe('₹5.5 K');
    expect(Money.parse('999.00', 'INR').formatAbbreviatedForDashboardOnly()).toBe('₹999.00');
    expect(Money.parse('-12400000.00', 'INR').formatAbbreviatedForDashboardOnly()).toBe('-₹1.24 Cr');
    // Non-Indian currencies fall back to exact formatting.
    expect(Money.parse('12400000.00', 'USD').formatAbbreviatedForDashboardOnly()).toBe('$12,400,000.00');
  });

  it('renders a debuggable string with the currency code', () => {
    expect(Money.parse('1234.50', 'INR').toString()).toBe('INR 1234.50');
  });
});
