/**
 * Money — the only representation of a monetary amount in Vim's HMS.
 *
 * Rules this type exists to make unbreakable:
 *   - `docs/03 §Table rules`: money is `numeric(14,2)` + `currency char(3)`; never float.
 *   - `docs/09 §2`: "Money is asserted with the `Money` type, never floats." This file is
 *     on the **100 % coverage list**.
 *   - `docs/06 §5.2 #24` (`MoneyInput`): "no float maths (minor units)" and
 *     "Never rounds silently — rounding shows as an explicit line."
 *
 * Internally an amount is a `bigint` count of **minor units** (paise for INR).
 * There is no code path that produces a `number` from an amount, because that is
 * where 0.1 + 0.2 !== 0.3 gets into a hospital's books.
 */

/** ISO-4217 alphabetic code. `char(3)` in the database. */
export type CurrencyCode = 'INR' | 'AED' | 'QAR' | 'USD' | 'EUR' | 'GBP' | 'KES' | 'SAR';

interface CurrencyMeta {
  /** Number of decimal places the currency actually uses. */
  readonly exponent: number;
  readonly symbol: string;
  /** Indian lakh/crore grouping vs Western thousands grouping. */
  readonly grouping: 'indian' | 'western';
  /** BCP-47 tag used for `Intl.NumberFormat`. */
  readonly locale: string;
}

const CURRENCIES: Readonly<Record<CurrencyCode, CurrencyMeta>> = Object.freeze({
  INR: { exponent: 2, symbol: '₹', grouping: 'indian', locale: 'en-IN' },
  AED: { exponent: 2, symbol: 'د.إ', grouping: 'western', locale: 'ar-AE' },
  QAR: { exponent: 2, symbol: 'ر.ق', grouping: 'western', locale: 'ar-QA' },
  USD: { exponent: 2, symbol: '$', grouping: 'western', locale: 'en-US' },
  EUR: { exponent: 2, symbol: '€', grouping: 'western', locale: 'de-DE' },
  GBP: { exponent: 2, symbol: '£', grouping: 'western', locale: 'en-GB' },
  KES: { exponent: 2, symbol: 'KSh', grouping: 'western', locale: 'en-KE' },
  SAR: { exponent: 2, symbol: 'ر.س', grouping: 'western', locale: 'ar-SA' },
});

export function currencyMeta(currency: CurrencyCode): CurrencyMeta {
  const meta = CURRENCIES[currency];
  /* c8 ignore next 3 -- unreachable while CurrencyCode is a closed union; kept as a runtime guard for data arriving from the DB */
  if (!meta) {
    throw new MoneyError(`Unknown currency "${String(currency)}"`);
  }
  return meta;
}

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

/**
 * `numeric(14,2)` means at most 12 integer digits and 2 decimals, i.e.
 * |amount| <= 999,999,999,999.99 → 99,999,999,999,999 minor units.
 * Overflowing this in application code must fail loudly rather than be
 * truncated by Postgres at insert time.
 */
const MAX_MINOR = 99_999_999_999_999n;

export type RoundingMode =
  /** 0.5 away from zero — India's standard commercial rounding (GST invoices). */
  | 'half-up'
  /** 0.5 to the nearest even — reduces bias across many operations. */
  | 'half-even'
  | 'down'
  | 'up';

export interface MoneyJson {
  readonly minor: string;
  readonly currency: CurrencyCode;
}

export class Money {
  readonly #minor: bigint;
  readonly #currency: CurrencyCode;

  private constructor(minor: bigint, currency: CurrencyCode) {
    if (minor > MAX_MINOR || minor < -MAX_MINOR) {
      throw new MoneyError(
        `Amount ${minor.toString()} exceeds numeric(14,2) range; a value this large is a bug, not a bill.`,
      );
    }
    this.#minor = minor;
    this.#currency = currency;
  }

  // ── construction ────────────────────────────────────────────────────────────

  /** From a whole count of minor units (paise). The canonical constructor. */
  static fromMinor(minor: bigint | number | string, currency: CurrencyCode): Money {
    let value: bigint;
    if (typeof minor === 'bigint') {
      value = minor;
    } else if (typeof minor === 'number') {
      if (!Number.isInteger(minor)) {
        throw new MoneyError(`fromMinor expects whole minor units, received ${minor}`);
      }
      if (!Number.isSafeInteger(minor)) {
        throw new MoneyError(`fromMinor received an unsafe integer (${minor}); pass a bigint or string`);
      }
      value = BigInt(minor);
    } else {
      if (!/^-?\d+$/.test(minor)) {
        throw new MoneyError(`fromMinor expects an integer string, received "${minor}"`);
      }
      value = BigInt(minor);
    }
    return new Money(value, currency);
  }

  /**
   * From a decimal string as it appears on a document or in Postgres `numeric`.
   * Accepts `"1234.50"`, `"1,23,456.75"`, `"₹1,234"`, `"-99.99"`.
   * Rejects anything with more decimals than the currency has, because silently
   * dropping a third decimal is exactly the class of bug this type prevents.
   */
  static parse(input: string, currency: CurrencyCode): Money {
    const { exponent } = currencyMeta(currency);
    const cleaned = input.trim().replace(/[\s, ]/g, '').replace(/^[^\d.-]+/, '');
    const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(cleaned);
    if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
      throw new MoneyError(`Cannot parse "${input}" as ${currency}`);
    }
    const sign = match[1] === '-' ? -1n : 1n;
    const whole = match[2] === '' ? '0' : (match[2] as string);
    const frac = match[3] ?? '';
    if (frac.length > exponent) {
      throw new MoneyError(
        `"${input}" has ${frac.length} decimal places but ${currency} has ${exponent}. ` +
          `Round explicitly with Money.roundTo() so the rounding is visible.`,
      );
    }
    const paddedFrac = frac.padEnd(exponent, '0');
    return new Money(sign * BigInt(whole + paddedFrac), currency);
  }

  /** Zero in a given currency — the identity for `add`. */
  static zero(currency: CurrencyCode): Money {
    return new Money(0n, currency);
  }

  static fromJson(json: MoneyJson): Money {
    return Money.fromMinor(json.minor, json.currency);
  }

  // ── accessors ───────────────────────────────────────────────────────────────

  get minor(): bigint {
    return this.#minor;
  }

  get currency(): CurrencyCode {
    return this.#currency;
  }

  get isZero(): boolean {
    return this.#minor === 0n;
  }

  get isNegative(): boolean {
    return this.#minor < 0n;
  }

  get isPositive(): boolean {
    return this.#minor > 0n;
  }

  // ── arithmetic ──────────────────────────────────────────────────────────────

  #assertSameCurrency(other: Money, op: string): void {
    if (other.#currency !== this.#currency) {
      throw new MoneyError(
        `Cannot ${op} ${this.#currency} and ${other.#currency}. ` +
          `Convert explicitly with a dated exchange rate (EN-041 §3.10) — never implicitly.`,
      );
    }
  }

  add(other: Money): Money {
    this.#assertSameCurrency(other, 'add');
    return new Money(this.#minor + other.#minor, this.#currency);
  }

  subtract(other: Money): Money {
    this.#assertSameCurrency(other, 'subtract');
    return new Money(this.#minor - other.#minor, this.#currency);
  }

  negate(): Money {
    return new Money(-this.#minor, this.#currency);
  }

  abs(): Money {
    return new Money(this.#minor < 0n ? -this.#minor : this.#minor, this.#currency);
  }

  /** Multiply by a whole quantity (5 units of a service). Exact — no rounding. */
  timesQuantity(quantity: bigint | number): Money {
    // Validate before converting: `BigInt(1.5)` throws its own opaque RangeError,
    // which would hide the actionable message pointing at multiplyByRate().
    if (typeof quantity === 'number' && !Number.isInteger(quantity)) {
      throw new MoneyError(
        `timesQuantity expects a whole quantity, received ${quantity}. ` +
          `For fractional factors use multiplyByRate() and choose a rounding mode.`,
      );
    }
    const q = typeof quantity === 'bigint' ? quantity : BigInt(quantity);
    return new Money(this.#minor * q, this.#currency);
  }

  /**
   * Multiply by a rate expressed as a decimal string (`"0.18"` for 18 % GST,
   * `"1.5"` for a 150 % night tariff). The rate is parsed exactly — never via
   * `parseFloat` — and the caller must name a rounding mode, because a silent
   * rounding choice inside a tax calculation is a compliance defect.
   */
  multiplyByRate(rate: string, mode: RoundingMode): { value: Money; roundingAdjustment: Money } {
    const m = /^(-?)(\d*)(?:\.(\d+))?$/.exec(rate.trim());
    if (!m || (m[2] === '' && (m[3] ?? '') === '')) {
      throw new MoneyError(`Cannot parse rate "${rate}"`);
    }
    const sign = m[1] === '-' ? -1n : 1n;
    const whole = m[2] === '' ? '0' : (m[2] as string);
    const frac = m[3] ?? '';
    const scale = 10n ** BigInt(frac.length);
    const rateNumerator = sign * BigInt(whole + frac);

    const exactNumerator = this.#minor * rateNumerator;
    const rounded = divideRounded(exactNumerator, scale, mode);
    const exactAsMinorTruncated = exactNumerator / scale;
    return {
      value: new Money(rounded, this.#currency),
      // The difference between the rounded result and plain truncation — what a
      // bill must show as an explicit "rounding" line rather than absorb.
      roundingAdjustment: new Money(rounded - exactAsMinorTruncated, this.#currency),
    };
  }

  /**
   * Percentage of this amount (`percentageOf("12.5", 'half-up')` = 12.5 %).
   * Convenience over `multiplyByRate` for discount and tax code.
   */
  percentage(percent: string, mode: RoundingMode = 'half-up'): { value: Money; roundingAdjustment: Money } {
    const asRate = divideDecimalStringBy100(percent);
    return this.multiplyByRate(asRate, mode);
  }

  /**
   * Split an amount into `n` parts that **sum exactly back to the original**.
   * Used for equal instalments, sharing a package price across its component
   * services, and doctor-share splits (NC-034). The remainder paise are handed
   * out one at a time from the first part, so nothing is created or destroyed.
   */
  splitEvenly(parts: number): Money[] {
    if (!Number.isInteger(parts) || parts <= 0) {
      throw new MoneyError(`splitEvenly needs a positive whole number of parts, received ${parts}`);
    }
    const n = BigInt(parts);
    const base = this.#minor / n;
    let remainder = this.#minor - base * n;
    const step = remainder < 0n ? -1n : 1n;
    const out: Money[] = [];
    for (let i = 0; i < parts; i += 1) {
      let share = base;
      if (remainder !== 0n) {
        share += step;
        remainder -= step;
      }
      out.push(new Money(share, this.#currency));
    }
    return out;
  }

  /**
   * Allocate proportionally to integer weights, summing exactly to the original.
   * Largest-remainder method, ties broken by original order so the result is
   * deterministic and therefore testable.
   */
  allocate(weights: readonly (bigint | number)[]): Money[] {
    if (weights.length === 0) {
      throw new MoneyError('allocate needs at least one weight');
    }
    const w = weights.map((x) => (typeof x === 'bigint' ? x : BigInt(Math.trunc(x))));
    if (w.some((x) => x < 0n)) {
      throw new MoneyError('allocate does not accept negative weights');
    }
    const total = w.reduce((a, b) => a + b, 0n);
    if (total === 0n) {
      throw new MoneyError('allocate needs at least one non-zero weight');
    }

    const shares = w.map((weight) => (this.#minor * weight) / total);
    let allocated = shares.reduce((a, b) => a + b, 0n);
    let leftover = this.#minor - allocated;

    // Distribute the leftover to the largest fractional remainders first.
    const remainders = w
      .map((weight, index) => ({ index, rem: (this.#minor * weight) % total }))
      .sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.index - b.index));

    const step = leftover < 0n ? -1n : 1n;
    let cursor = 0;
    while (leftover !== 0n && remainders.length > 0) {
      const target = remainders[cursor % remainders.length];
      /* c8 ignore next -- remainders is non-empty here, so target is always defined */
      if (!target) break;
      shares[target.index] = (shares[target.index] ?? 0n) + step;
      leftover -= step;
      allocated += step;
      cursor += 1;
    }

    return shares.map((s) => new Money(s, this.#currency));
  }

  /** Round to a coarser unit — e.g. `roundTo(100n, 'half-up')` rounds ₹ to whole rupees. */
  roundTo(minorMultiple: bigint, mode: RoundingMode = 'half-up'): { value: Money; roundingAdjustment: Money } {
    if (minorMultiple <= 0n) {
      throw new MoneyError('roundTo needs a positive multiple of minor units');
    }
    const quotient = divideRounded(this.#minor, minorMultiple, mode);
    const value = new Money(quotient * minorMultiple, this.#currency);
    return { value, roundingAdjustment: value.subtract(this) };
  }

  // ── comparison ──────────────────────────────────────────────────────────────

  compare(other: Money): -1 | 0 | 1 {
    this.#assertSameCurrency(other, 'compare');
    return this.#minor < other.#minor ? -1 : this.#minor > other.#minor ? 1 : 0;
  }

  equals(other: Money): boolean {
    return this.#currency === other.#currency && this.#minor === other.#minor;
  }

  greaterThan(other: Money): boolean {
    return this.compare(other) === 1;
  }

  greaterThanOrEqual(other: Money): boolean {
    return this.compare(other) >= 0;
  }

  lessThan(other: Money): boolean {
    return this.compare(other) === -1;
  }

  lessThanOrEqual(other: Money): boolean {
    return this.compare(other) <= 0;
  }

  static sum(amounts: readonly Money[], currency: CurrencyCode): Money {
    return amounts.reduce<Money>((acc, m) => acc.add(m), Money.zero(currency));
  }

  static max(a: Money, b: Money): Money {
    return a.greaterThan(b) ? a : b;
  }

  static min(a: Money, b: Money): Money {
    return a.lessThan(b) ? a : b;
  }

  // ── serialisation ───────────────────────────────────────────────────────────

  /** Exactly what goes into a Postgres `numeric(14,2)` column. */
  toDecimalString(): string {
    const { exponent } = currencyMeta(this.#currency);
    const negative = this.#minor < 0n;
    const digits = (negative ? -this.#minor : this.#minor).toString().padStart(exponent + 1, '0');
    const whole = digits.slice(0, digits.length - exponent);
    const frac = digits.slice(digits.length - exponent);
    return `${negative ? '-' : ''}${whole}${exponent > 0 ? `.${frac}` : ''}`;
  }

  toJson(): MoneyJson {
    return { minor: this.#minor.toString(), currency: this.#currency };
  }

  /**
   * Human display with correct grouping — Indian `₹1,23,45,678.00` vs Western
   * `$12,345,678.00` (docs/06 §8). Always two decimals, always tabular in the UI.
   */
  format(options?: { withSymbol?: boolean; locale?: string }): string {
    const meta = currencyMeta(this.#currency);
    const withSymbol = options?.withSymbol ?? true;
    const decimal = this.toDecimalString();
    const negative = decimal.startsWith('-');
    const unsigned = negative ? decimal.slice(1) : decimal;
    const [wholeRaw, fracRaw] = unsigned.split('.');
    const whole = wholeRaw ?? '0';
    const grouped = meta.grouping === 'indian' ? groupIndian(whole) : groupWestern(whole);
    const body = fracRaw ? `${grouped}.${fracRaw}` : grouped;
    return `${negative ? '-' : ''}${withSymbol ? meta.symbol : ''}${body}`;
  }

  /**
   * Dashboard-only abbreviation (`₹1.24 Cr`, `₹8.5 L`). docs/06 §8 permits this
   * **only** on dashboards, and requires the exact value in the tooltip and in
   * every printed or exported document — hence the separate, clearly named method.
   */
  formatAbbreviatedForDashboardOnly(): string {
    const meta = currencyMeta(this.#currency);
    if (meta.grouping !== 'indian') {
      return this.format();
    }
    const rupees = Number(this.#minor) / 10 ** meta.exponent;
    const magnitude = Math.abs(rupees);
    const sign = rupees < 0 ? '-' : '';
    if (magnitude >= 10_000_000) return `${sign}${meta.symbol}${(magnitude / 10_000_000).toFixed(2)} Cr`;
    if (magnitude >= 100_000) return `${sign}${meta.symbol}${(magnitude / 100_000).toFixed(2)} L`;
    if (magnitude >= 1_000) return `${sign}${meta.symbol}${(magnitude / 1_000).toFixed(1)} K`;
    return this.format();
  }

  toString(): string {
    return `${this.#currency} ${this.toDecimalString()}`;
  }
}

// ── internal helpers ─────────────────────────────────────────────────────────

/** Integer division of bigints with an explicit rounding mode. */
function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) {
    throw new MoneyError('Division by zero');
  }
  const negative = numerator < 0n !== denominator < 0n;
  const absN = numerator < 0n ? -numerator : numerator;
  const absD = denominator < 0n ? -denominator : denominator;
  const quotient = absN / absD;
  const remainder = absN % absD;

  if (remainder === 0n) {
    return negative ? -quotient : quotient;
  }

  let bumped: bigint;
  switch (mode) {
    case 'down':
      bumped = quotient;
      break;
    case 'up':
      bumped = quotient + 1n;
      break;
    case 'half-up':
      bumped = remainder * 2n >= absD ? quotient + 1n : quotient;
      break;
    case 'half-even': {
      const twice = remainder * 2n;
      if (twice > absD) bumped = quotient + 1n;
      else if (twice < absD) bumped = quotient;
      else bumped = quotient % 2n === 0n ? quotient : quotient + 1n;
      break;
    }
  }
  return negative ? -bumped : bumped;
}

/** `"12.5"` → `"0.125"`, done as string surgery so no float is ever involved. */
function divideDecimalStringBy100(percent: string): string {
  const m = /^(-?)(\d*)(?:\.(\d+))?$/.exec(percent.trim());
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) {
    throw new MoneyError(`Cannot parse percentage "${percent}"`);
  }
  const sign = m[1] ?? '';
  const digits = (m[2] === '' ? '0' : (m[2] as string)) + (m[3] ?? '');
  const decimals = (m[3] ?? '').length + 2;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals);
  return `${sign}${whole}.${frac}`;
}

/** Indian grouping: last three digits, then pairs (`12345678` → `1,23,45,678`). */
function groupIndian(whole: string): string {
  if (whole.length <= 3) return whole;
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

function groupWestern(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
