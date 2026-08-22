import { Money, type CurrencyCode } from '@vims/contracts/primitives';
import type { Denomination, DenominationCounts } from '@vims/ui';
import { countedTotal, denominationKey } from '@vims/ui';
import { ApiProblem } from '@/lib/api';
import type { DenominationLineRequest, ShiftView } from '../api/types';

/**
 * The cash counter's arithmetic. **No floating point reaches any of it.**
 *
 * Every amount that arrives from the API is a decimal string
 * (`cash.schemas.ts`: "₹1,234.55 round-tripped through IEEE-754 can arrive as
 * 1234.5499999999999"), and every amount that leaves is one too. In between it
 * is a `Money` — a `bigint` count of minor units. There is no `Number()`, no
 * `parseFloat` and no `toFixed` on an amount in this file, which is the whole
 * point: a drawer reconciled in float is wrong in a way nobody notices until the
 * shift will not close, and then nobody can say why.
 */

const SUPPORTED_CURRENCIES: readonly string[] = ['INR', 'AED', 'QAR', 'USD', 'EUR', 'GBP', 'KES', 'SAR'];

/** Narrows the `char(3)` the API returns. An unknown code is a deployment error, not a UI fallback. */
export function asCurrency(value: string): CurrencyCode {
  const code = value.trim().toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(code)) {
    throw new Error(`Currency "${value}" is not configured for this deployment.`);
  }
  return code as CurrencyCode;
}

export function parseMoney(decimal: string, currency: CurrencyCode): Money {
  return Money.parse(decimal, currency);
}

/** One minor unit — the smallest step the cap can be approached by. */
export function minorUnit(currency: CurrencyCode): Money {
  return Money.fromMinor(1n, currency);
}

// ── §269ST ───────────────────────────────────────────────────────────────────

/**
 * Income-tax §269ST: no person may **receive** ₹2,00,000 **or more** in cash
 * from one person in one day. §271DA's penalty is equal to the whole sum
 * received, so the boundary rupee costs ₹2,00,000 — which is why the comparison
 * is `>=` and not `>`, on the server and here.
 *
 * The section is Indian income-tax law, so the cap applies to an INR drawer. A
 * Gulf or African deployment on the same code has no such rule, and asserting
 * one would refuse legitimate money.
 *
 * The API is the authority: it holds a per-payer, per-day running total under a
 * row lock, which is the only place the question can actually be answered. What
 * the client can do without it is catch the unambiguous case — a single tender
 * that is itself at or above the cap — before the patient has queued at a second
 * window for nothing.
 */
export const STATUTORY_CASH_CAP_MINOR = 20_000_000n;

export function statutoryCashCap(currency: CurrencyCode): Money | null {
  if (currency !== 'INR') return null;
  return Money.fromMinor(STATUTORY_CASH_CAP_MINOR, currency);
}

export type CashCapPrecheck =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'refused';
      readonly cap: Money;
      readonly attempted: Money;
      /** The largest cash tender that could still be legal in the best case. */
      readonly maximumCash: Money;
    };

/**
 * The client-side half of the cap check: a cash tender that is on its own at or
 * above the cap can never be accepted, whatever the payer's running total is.
 *
 * Anything below that is left to the server, because only the server knows what
 * the payer has already handed over today at the other three counters.
 */
export function precheckCashTender(cash: Money, currency: CurrencyCode): CashCapPrecheck {
  const cap = statutoryCashCap(currency);
  if (cap === null || !cash.greaterThanOrEqual(cap)) return { kind: 'ok' };
  return {
    kind: 'refused',
    cap,
    attempted: cash,
    maximumCash: cap.subtract(minorUnit(currency)),
  };
}

export interface CashCapRefusal {
  /** What the payer's day would have reached, per the server. */
  readonly wouldReach: Money;
  readonly cap: Money;
  /** What the payer has already paid in cash today, across every counter. */
  readonly alreadyToday: Money;
  /** The most cash that can still be taken from this payer today. Never negative. */
  readonly remainingHeadroom: Money;
  /** The attempted cash tender, echoed back so the message can name it. */
  readonly attempted: Money;
}

const CAP_DETAIL = /would reach\s+([0-9]+(?:\.[0-9]+)?),.*?limit of\s+([0-9]+(?:\.[0-9]+)?)/u;

/**
 * Reads the server's §269ST refusal into numbers the cashier can act on.
 *
 * The API returns the running total and the cap inside `detail`; there is no
 * structured field for either, and no endpoint that exposes a payer's daily
 * total. Parsing the sentence is therefore the only way to tell a cashier "you
 * can still take ₹40,000 in cash, the rest by card" instead of "refused".
 *
 * It is written to fail closed: anything unparseable returns `null` and the
 * caller falls back to the problem's own `detail` and `nextAction`, which are
 * always present and always correct. Nothing here is load-bearing for the
 * refusal itself — the server already refused.
 */
export function parseCashCapRefusal(
  error: unknown,
  attemptedCash: Money,
  currency: CurrencyCode,
): CashCapRefusal | null {
  if (!(error instanceof ApiProblem)) return null;
  if (!error.problem.type.endsWith('/statutory-limit')) return null;
  const detail = error.problem.detail;
  if (detail === undefined) return null;

  const match = CAP_DETAIL.exec(detail);
  const [, wouldReachText, capText] = match ?? [];
  if (wouldReachText === undefined || capText === undefined) return null;

  let wouldReach: Money;
  let cap: Money;
  try {
    wouldReach = Money.parse(wouldReachText, currency);
    cap = Money.parse(capText, currency);
  } catch {
    return null;
  }

  // The refused receipt is rolled back with its increment, so the payer's real
  // standing total is what the attempt would have reached minus the attempt.
  const alreadyToday = Money.max(wouldReach.subtract(attemptedCash), Money.zero(currency));
  const headroom = cap.subtract(alreadyToday).subtract(minorUnit(currency));

  return {
    wouldReach,
    cap,
    alreadyToday,
    remainingHeadroom: Money.max(headroom, Money.zero(currency)),
    attempted: attemptedCash,
  };
}

/** Any §269ST refusal, with or without numbers in it. */
export function isCashCapProblem(error: unknown): boolean {
  return error instanceof ApiProblem && error.problem.type.endsWith('/statutory-limit');
}

/** True for the §269ST refusal that has no numbers in it — an unidentified payer. */
export function isUnidentifiedPayerRefusal(error: unknown): boolean {
  return (
    error instanceof ApiProblem &&
    error.problem.type.endsWith('/statutory-limit') &&
    CAP_DETAIL.exec(error.problem.detail ?? '') === null
  );
}

// ── split tenders ────────────────────────────────────────────────────────────

export interface TenderLine {
  readonly id: string;
  readonly mode: string;
  readonly amount: Money | null;
  /** Cash only: what the patient handed over, so the change is computed and stored. */
  readonly tendered: Money | null;
  readonly reference: string;
  readonly pending: boolean;
}

export function tenderSum(lines: readonly TenderLine[], currency: CurrencyCode): Money {
  return Money.sum(
    lines.map((line) => line.amount ?? Money.zero(currency)),
    currency,
  );
}

export function cashPortion(lines: readonly TenderLine[], currency: CurrencyCode): Money {
  return Money.sum(
    lines.filter((line) => line.mode === 'cash').map((line) => line.amount ?? Money.zero(currency)),
    currency,
  );
}

export type SplitBalance =
  | { readonly kind: 'balanced' }
  | { readonly kind: 'short'; readonly by: Money }
  | { readonly kind: 'over'; readonly by: Money };

/**
 * NC-001 §3.3: "any combination; total must equal payable".
 *
 * Checked here as well as on the server, not instead of it — the server's check
 * is the one that protects the ledger, this one is what stops a cashier
 * discovering at submit time that they are ₹50 short with a patient waiting.
 */
export function splitBalance(
  total: Money | null,
  lines: readonly TenderLine[],
  currency: CurrencyCode,
): SplitBalance {
  const payable = total ?? Money.zero(currency);
  const sum = tenderSum(lines, currency);
  if (sum.equals(payable)) return { kind: 'balanced' };
  return sum.lessThan(payable)
    ? { kind: 'short', by: payable.subtract(sum) }
    : { kind: 'over', by: sum.subtract(payable) };
}

/** Change due on a cash line. `null` when nothing was tendered or it does not cover the line. */
export function changeDue(line: TenderLine): Money | null {
  if (line.mode !== 'cash' || line.amount === null || line.tendered === null) return null;
  if (line.tendered.lessThan(line.amount)) return null;
  return line.tendered.subtract(line.amount);
}

// ── denomination sheets ──────────────────────────────────────────────────────

/**
 * The sheet as NC-001 §6 takes it: face value and count per line, both exact.
 *
 * Zero-count rows are dropped — the API caps the array at 40 lines and a row of
 * zeroes carries no information — but the total is computed from the full sheet
 * by `countedTotal`, in `bigint`, so dropping them cannot change it.
 */
export function toDenominationLines(
  denominations: readonly Denomination[],
  counts: DenominationCounts,
  currency: CurrencyCode,
): readonly DenominationLineRequest[] {
  return denominations
    .map((denomination) => ({
      denomination: Money.fromMinor(denomination.minor, currency).toDecimalString(),
      count: counts[denominationKey(denomination)] ?? 0,
    }))
    .filter((line) => Number.isInteger(line.count) && line.count > 0);
}

export function sheetTotal(
  denominations: readonly Denomination[],
  counts: DenominationCounts,
  currency: CurrencyCode,
): Money {
  return countedTotal(denominations, counts, currency);
}

// ── what is stopping the close ───────────────────────────────────────────────

export type CloseBlocker =
  | { readonly kind: 'pending_confirmations'; readonly count: number }
  | { readonly kind: 'variance_approval'; readonly variance: Money; readonly reason: string | null }
  | { readonly kind: 'already_closed' }
  | { readonly kind: 'not_your_shift' };

/**
 * What the close-preview is telling the cashier.
 *
 * `GET /shifts/:id/close-preview` is literally `get(shiftId)` on the server, and
 * `viewOf` hard-codes `blockedBy: null` — only an actual close attempt ever
 * populates it. So the preview's blockers are derived here from the fields the
 * preview *does* return (`pendingConfirmations`, `status`, `variance`,
 * `varianceApprovedBy`), and the server's own `blockedBy` is honoured whenever
 * it is set. Without this the preview would say "nothing is blocking you" and
 * then the close would be refused, which is the worst of both.
 */
export function closeBlockers(shift: ShiftView, viewerUserId: string): readonly CloseBlocker[] {
  const currency = asCurrency(shift.currency);
  const blockers: CloseBlocker[] = [];

  if (shift.status === 'closed' || shift.status === 'force_closed') {
    return [{ kind: 'already_closed' }];
  }
  if (shift.cashierUserId !== viewerUserId) {
    blockers.push({ kind: 'not_your_shift' });
  }
  if (shift.pendingConfirmations > 0 || shift.blockedBy === 'pending_confirmations') {
    blockers.push({ kind: 'pending_confirmations', count: shift.pendingConfirmations });
  }

  const variance = shift.variance === null ? null : parseMoney(shift.variance, currency);
  const unapproved = variance !== null && !variance.isZero && shift.varianceApprovedBy === null;
  if (unapproved && (shift.status === 'closing' || shift.blockedBy === 'variance_approval')) {
    blockers.push({ kind: 'variance_approval', variance, reason: shift.varianceReason });
  }

  return blockers;
}

export const PAYMENT_MODE_LABELS: Readonly<Record<string, string>> = {
  cash: 'Cash',
  card: 'Card',
  upi: 'UPI',
  netbanking: 'Net banking',
  wallet: 'Wallet',
  cheque: 'Cheque',
  dd: 'Demand draft',
  gateway_link: 'Payment link',
  advance_adjust: 'Advance adjustment',
  patient_wallet: 'Patient wallet',
  credit: 'Credit',
  staff_credit: 'Staff credit',
  emi: 'EMI',
  forex: 'Foreign currency',
};

/** The tenders a counter can offer instead of cash when the cap bites. */
export const NON_CASH_ALTERNATIVES = ['card', 'upi', 'cheque', 'netbanking'] as const;
