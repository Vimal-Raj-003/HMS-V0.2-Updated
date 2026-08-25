import { describe, expect, it } from 'vitest';
import { parseGs1 } from './items.service.js';
import { convertToBase } from './uom.service.js';

/**
 * `phase-04 §Constraints`: "Every quantity has a UoM. Any arithmetic mixing UoMs
 * without conversion is a bug — write property-based tests."
 *
 * These are the two pure functions on that path. Both are tested against
 * *properties* rather than a handful of remembered examples, because the failure
 * mode is not "this one number is wrong" — it is "the fourth decimal place
 * disagrees with what Postgres computed", which shows up as a refused insert on
 * a dispense that is otherwise correct, at a counter, with a patient waiting.
 *
 * The oracle is deliberately not `entered * factor` in floating point: that is
 * the thing under test. It is exact integer arithmetic on the same scaled
 * operands the database uses.
 */

/** The oracle: `round(entered × factor, 4)`, half away from zero, in bigint. */
function exact(entered: string, factor: string): string {
  const scale = (value: string, places: number): bigint => {
    const [whole = '0', fraction = ''] = value.split('.');
    return BigInt(whole + fraction.padEnd(places, '0').slice(0, places));
  };
  const product = scale(entered, 4) * scale(factor, 8);
  const divisor = 10n ** 8n;
  const quotient = product / divisor;
  const remainder = product % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  const digits = rounded.toString().padStart(5, '0');
  return `${digits.slice(0, digits.length - 4)}.${digits.slice(digits.length - 4)}`;
}

/**
 * A deterministic generator. `docs/09 §2` bans `Math.random()` — a suite that
 * uses it fails irreproducibly in CI and the seed is what makes a counterexample
 * worth reporting.
 */
function* seeded(count: number, seed = 987_654_321): Generator<number> {
  let state = seed;
  for (let i = 0; i < count; i += 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    yield state;
  }
}

/**
 * A generated `(entered, factor)` pair, at the magnitudes the columns actually
 * allow: `numeric(18,4)` against `numeric(20,8)`.
 *
 * Deliberately not restricted to counter-sized numbers. A strip of ten tablets
 * times a factor of ten is comfortably inside a double's 15–16 significant
 * digits, so a float implementation would pass a suite built only from those —
 * and then be wrong on a consignment receipt or a month-end valuation, which is
 * exactly where nobody is watching.
 */
function pair(value: number): { entered: string; factor: string } {
  return {
    entered: `${value % 100_000_000}.${String(value % 10_000).padStart(4, '0')}`,
    factor: `${(value % 1_000_000) + 1}.${String(value % 100_000_000).padStart(8, '0')}`,
  };
}

describe('convertToBase', () => {
  it('agrees with exact integer arithmetic across a generated range', () => {
    const mismatches: string[] = [];
    for (const value of seeded(2_000)) {
      const { entered, factor } = pair(value);
      const got = convertToBase(entered, factor);
      const want = exact(entered, factor);
      if (got !== want) mismatches.push(`${entered} × ${factor} → ${got}, expected ${want}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('would fail if the implementation used floating point — the test has teeth', () => {
    // The obvious implementation, and the reason it is not the one shipped.
    const naive = (entered: string, factor: string): string => (Number(entered) * Number(factor)).toFixed(4);

    const disagreements = [...seeded(2_000)]
      .map((value) => {
        const { entered, factor } = pair(value);
        return { entered, factor, naive: naive(entered, factor), exact: exact(entered, factor) };
      })
      .filter((row) => row.naive !== row.exact);

    // Each of these is a `qty_base` the trigger would recompute differently, and
    // therefore a refused insert on an otherwise correct movement.
    expect(disagreements.length).toBeGreaterThan(0);
    // And the shipped implementation agrees with none of the wrong answers.
    for (const row of disagreements) {
      expect(convertToBase(row.entered, row.factor)).toBe(row.exact);
    }
  });

  it('is exact where IEEE-754 is not', () => {
    // At counter magnitudes a double and exact arithmetic agree — `0.1 × 3` and
    // `1.005 × 100` both round back to the right answer through `toFixed`. The
    // divergence starts where the product needs more than about sixteen
    // significant digits, which `numeric(18,4) × numeric(20,8)` reaches easily:
    // a bulk consignment receipt, a repack factor, a month-end valuation.
    expect(convertToBase('0.1000', '3.00000000')).toBe('0.3000');
    expect(convertToBase('0.0001', '1.00000000')).toBe('0.0001');

    // 48490368.0368 × 490369.48490368. A double answers ...6995.4844.
    expect(convertToBase('48490368.0368', '490369.48490368')).toBe('23778196796995.4848');
    expect((48_490_368.0368 * 490_369.48490368).toFixed(4)).toBe('23778196796995.4844');
  });

  it('rounds half away from zero, as numeric does', () => {
    // 1.00005 × 1 = 1.00005 → 1.0001 at four places, not 1.0000.
    expect(convertToBase('1.0000', '1.00005000')).toBe('1.0001');
    expect(convertToBase('3.0000', '0.33335000')).toBe('1.0001');
  });

  it('keeps a pack ladder consistent: a box is its strips is its tablets', () => {
    // 1 box = 20 strips = 200 tablets. Every route to the base unit agrees.
    const viaBox = convertToBase('1.0000', '200.00000000');
    const viaStrips = convertToBase('20.0000', '10.00000000');
    expect(viaBox).toBe(viaStrips);
    expect(viaBox).toBe('200.0000');
  });

  it('refuses a quantity finer than the column can hold rather than truncating it', () => {
    // Silently dropping the fifth decimal place would make `qty_base` disagree
    // with what the trigger recomputes, and the insert would be refused with a
    // message about the trigger rather than about the input.
    expect(() => convertToBase('1.00001', '1.00000000')).toThrow(/decimal places/i);
  });
});

describe('parseGs1', () => {
  const GS = String.fromCharCode(29);

  it('reads GTIN, expiry and batch from a medicine pack', () => {
    expect(parseGs1(`010890123456789317280630102026A${GS}`)).toEqual({
      gtin: '08901234567893',
      expiryDate: '2028-06-30',
      batchNo: '2026A',
    });
  });

  it('resolves a day of 00 to the last day of that month', () => {
    // A foil that prints "06/28" means end of June, not the zeroth of June.
    // Treating it as day zero would expire the pack a month early and quietly
    // lose the stock.
    expect(parseGs1('0108901234567893172806001012345')?.expiryDate).toBe('2028-06-30');
    expect(parseGs1('0108901234567893172902001012345')?.expiryDate).toBe('2029-02-28');
    expect(parseGs1('0108901234567893173202001012345')?.expiryDate).toBe('2032-02-29');
  });

  it('reads a serial for an implant', () => {
    const parsed = parseGs1(`0108901234567893211122334455${GS}10LOT9`);
    expect(parsed?.serialNo).toBe('1122334455');
    expect(parsed?.batchNo).toBe('LOT9');
  });

  it('strips the symbology identifier a scanner prepends', () => {
    expect(parseGs1(']d201089012345678931728063010ABC')?.gtin).toBe('08901234567893');
  });

  it('returns null for anything that is not a GS1 payload, so a plain code still scans', () => {
    expect(parseGs1('PARA500')).toBeNull();
    expect(parseGs1('')).toBeNull();
    expect(parseGs1('17280630')).toBeNull();
  });

  it('stops at an identifier it does not know rather than guessing a length', () => {
    // Everything read so far is still returned: a partial scan that names the
    // item is more useful than none, and inventing a field length is how a lot
    // number becomes a serial number.
    const parsed = parseGs1('01089012345678931728063099SOMETHING');
    expect(parsed?.gtin).toBe('08901234567893');
    expect(parsed?.expiryDate).toBe('2028-06-30');
    expect(parsed?.batchNo).toBeUndefined();
  });
});
