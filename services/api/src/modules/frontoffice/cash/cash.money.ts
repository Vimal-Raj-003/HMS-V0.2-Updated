import { Money, type CurrencyCode } from '@vims/contracts';
import { AppError } from '../../../core/problem/app-error.js';

/**
 * NC-001's arithmetic, in one place and never in floating point.
 *
 * `docs/03 §Table rules`: money is `numeric(14,2)`, never float. `Money` holds a
 * `bigint` count of minor units, so the drawer count below is exact by
 * construction. A denomination sheet added up in `number` would be wrong in the
 * seventh decimal place, the variance would be a few paise off, and the shift
 * would refuse to close for a reason nobody could explain — which is the failure
 * this file exists to make impossible rather than unlikely.
 */

const SUPPORTED: readonly string[] = ['INR', 'AED', 'QAR', 'USD', 'EUR', 'GBP', 'KES', 'SAR'];

/** Narrows a `char(3)` read out of the database to a currency the type knows. */
export function toCurrencyCode(value: string): CurrencyCode {
  const code = value.trim().toUpperCase();
  if (!SUPPORTED.includes(code)) {
    throw AppError.conflict(`Currency "${value}" is not configured for this deployment.`);
  }
  return code as CurrencyCode;
}

/** A `numeric(14,2)` column as `Money`. `pg` returns numerics as strings for exactly this reason. */
export function moneyFromDb(value: string | null, currency: CurrencyCode): Money {
  if (value === null) return Money.zero(currency);
  return Money.parse(value, currency);
}

export interface DenominationLine {
  readonly denomination: string;
  readonly count: number;
}

export interface CountedSheet {
  readonly total: Money;
  readonly lines: readonly {
    readonly denomination: string;
    readonly count: number;
    readonly amount: string;
  }[];
}

/**
 * Adds up a denomination sheet.
 *
 * Each line is `denomination x count` in minor units; the amount per line is
 * stored alongside the count so the sheet in the database reproduces the drawer
 * exactly as it was counted, rather than being re-derived later against a
 * denomination master that may have changed (the ₹2000 note is the live
 * example — it is legal tender being withdrawn, and old sheets must still add
 * up).
 */
export function countSheet(lines: readonly DenominationLine[], currency: CurrencyCode): CountedSheet {
  let total = Money.zero(currency);
  const rendered = lines.map((line) => {
    if (!Number.isInteger(line.count) || line.count < 0) {
      throw AppError.conflict(`Denomination ${line.denomination} has a count that is not a whole number.`);
    }
    const face = Money.parse(line.denomination, currency);
    if (!face.isPositive) {
      throw AppError.conflict(`Denomination ${line.denomination} must be a positive value.`);
    }
    const amount = face.timesQuantity(line.count);
    total = total.add(amount);
    return { denomination: face.toDecimalString(), count: line.count, amount: amount.toDecimalString() };
  });
  return { total, lines: rendered };
}

/**
 * The sum of the tender lines must equal the receipt total, exactly.
 *
 * NC-001 §3.3: "any combination; total must equal payable". Enforced at write
 * time rather than trusted from the client, because a split that does not add up
 * produces a receipt whose face value and whose drawer effect disagree — and the
 * difference only surfaces at the shift close, attributed to the wrong cashier.
 */
export function assertSplitBalances(total: Money, lines: readonly Money[]): void {
  const sum = Money.sum(lines, total.currency);
  if (!sum.equals(total)) {
    throw AppError.conflict(
      `The payment lines add up to ${sum.toDecimalString()}, but the receipt total is ${total.toDecimalString()}. ` +
        'A split payment must balance exactly.',
    );
  }
}
