import { Money } from '@vims/contracts/primitives';
import { defaultInrDenominations, formatFaceValue } from '@vims/ui';
import { describe, expect, it } from 'vitest';
import { ApiProblem } from '@/lib/api';
import type { ShiftView } from '../api/types';
import {
  STATUTORY_CASH_CAP_MINOR,
  cashPortion,
  changeDue,
  closeBlockers,
  isCashCapProblem,
  isUnidentifiedPayerRefusal,
  parseCashCapRefusal,
  precheckCashTender,
  sheetTotal,
  splitBalance,
  toDenominationLines,
  type TenderLine,
} from './cash';

const INR = 'INR' as const;
const denominations = defaultInrDenominations((minor) => formatFaceValue(minor, INR));

function line(mode: string, amount: string | null, tendered?: string): TenderLine {
  return {
    id: `${mode}-${amount ?? 'null'}`,
    mode,
    amount: amount === null ? null : Money.parse(amount, INR),
    tendered: tendered === undefined ? null : Money.parse(tendered, INR),
    reference: '',
    pending: false,
  };
}

function problem(detail: string): ApiProblem {
  return new ApiProblem(
    {
      type: 'https://errors.vimshms.com/statutory-limit',
      title: 'A statutory limit prevents this',
      status: 422,
      detail,
      reference: 'trace-1',
    },
    422,
  );
}

describe('split tenders', () => {
  it('balances exactly, in minor units', () => {
    const lines = [line('cash', '1000.50'), line('upi', '499.50')];
    expect(splitBalance(Money.parse('1500.00', INR), lines, INR)).toEqual({ kind: 'balanced' });
  });

  /**
   * The number that catches a float implementation: 0.1 + 0.2 is not 0.3 in
   * IEEE-754, and a drawer built on it is out by a paisa a hundred times a day.
   */
  it('adds tenths exactly', () => {
    const lines = [line('cash', '0.10'), line('cash', '0.20')];
    expect(splitBalance(Money.parse('0.30', INR), lines, INR)).toEqual({ kind: 'balanced' });
  });

  it('names what is still owed and what is over', () => {
    const short = splitBalance(Money.parse('1000.00', INR), [line('cash', '950.00')], INR);
    expect(short.kind).toBe('short');
    expect(short.kind === 'short' ? short.by.toDecimalString() : '').toBe('50.00');

    const over = splitBalance(Money.parse('1000.00', INR), [line('cash', '1050.00')], INR);
    expect(over.kind).toBe('over');
    expect(over.kind === 'over' ? over.by.toDecimalString() : '').toBe('50.00');
  });

  it('computes the change on a cash tender, and nothing when it does not cover the line', () => {
    expect(changeDue(line('cash', '470.00', '500.00'))?.toDecimalString()).toBe('30.00');
    expect(changeDue(line('cash', '470.00', '400.00'))).toBeNull();
    expect(changeDue(line('card', '470.00', '500.00'))).toBeNull();
  });

  it('counts only the cash portion of a split for the statutory check', () => {
    const lines = [line('cash', '100000.00'), line('card', '150000.00')];
    expect(cashPortion(lines, INR).toDecimalString()).toBe('100000.00');
  });
});

describe('§269ST', () => {
  it('refuses at the cap, not above it — the boundary rupee is already an offence', () => {
    const cap = Money.fromMinor(STATUTORY_CASH_CAP_MINOR, INR);
    expect(precheckCashTender(cap.subtract(Money.fromMinor(1n, INR)), INR).kind).toBe('ok');
    expect(precheckCashTender(cap, INR).kind).toBe('refused');
  });

  it('does not apply an Indian income-tax rule to a Gulf drawer', () => {
    expect(precheckCashTender(Money.parse('500000.00', 'AED'), 'AED').kind).toBe('ok');
  });

  it('reports the largest cash tender that could ever be legal', () => {
    const result = precheckCashTender(Money.parse('250000.00', INR), INR);
    expect(result.kind === 'refused' ? result.maximumCash.toDecimalString() : '').toBe('199999.99');
  });

  /**
   * The API returns the payer's running total and the cap inside `detail` and
   * nowhere else, so this is what turns "refused" into "you can still take
   * ₹40,000 in cash, the rest by card".
   */
  it('reads the headroom out of the refusal', () => {
    const refusal = parseCashCapRefusal(
      problem(
        'Cash from this payer today would reach 220000.00, which meets or exceeds the §269ST limit of 200000.00.',
      ),
      Money.parse('60000.00', INR),
      INR,
    );
    expect(refusal).not.toBeNull();
    expect(refusal?.alreadyToday.toDecimalString()).toBe('160000.00');
    expect(refusal?.remainingHeadroom.toDecimalString()).toBe('39999.99');
    expect(refusal?.cap.toDecimalString()).toBe('200000.00');
  });

  it('reports zero headroom rather than a negative one when the payer is already past the cap', () => {
    const refusal = parseCashCapRefusal(
      problem(
        'Cash from this payer today would reach 300000.00, which meets or exceeds the §269ST limit of 200000.00.',
      ),
      Money.parse('10000.00', INR),
      INR,
    );
    expect(refusal?.remainingHeadroom.toDecimalString()).toBe('0.00');
  });

  it('fails closed on a sentence it cannot read, so the screen falls back to the API’s own words', () => {
    expect(parseCashCapRefusal(problem('Some other refusal entirely.'), Money.zero(INR), INR)).toBeNull();
    expect(parseCashCapRefusal(new Error('network'), Money.zero(INR), INR)).toBeNull();
  });

  it('recognises the unidentified-payer refusal, which carries no numbers', () => {
    const unidentified = problem(
      'Cash cannot be accepted without identifying the payer: §269ST is a per-payer daily limit.',
    );
    expect(isCashCapProblem(unidentified)).toBe(true);
    expect(isUnidentifiedPayerRefusal(unidentified)).toBe(true);
  });
});

describe('the denomination sheet', () => {
  it('totals in bigint and drops empty rows without changing the total', () => {
    const counts = { 'note-200000': 3, 'note-50000': 1, 'coin-100': 0 };
    expect(sheetTotal(denominations, counts, INR).toDecimalString()).toBe('6500.00');

    const lines = toDenominationLines(denominations, counts, INR);
    expect(lines).toHaveLength(2);
    expect(lines.map((entry) => entry.denomination)).toEqual(['2000.00', '500.00']);
  });

  it('ignores a count that is not a whole number of notes', () => {
    expect(sheetTotal(denominations, { 'note-200000': 1.5 }, INR).toDecimalString()).toBe('0.00');
    expect(toDenominationLines(denominations, { 'note-200000': 1.5 }, INR)).toHaveLength(0);
  });
});

describe('what is blocking the close', () => {
  const shift = (overrides: Partial<ShiftView> = {}): ShiftView => ({
    id: 'shift-1',
    counterId: 'counter-1',
    branchId: 'branch-1',
    cashierUserId: 'me',
    businessDate: '2026-08-24',
    status: 'open',
    currency: 'INR',
    openingFloat: '2000.00',
    expectedCash: '12000.00',
    countedCash: null,
    variance: null,
    varianceReason: null,
    varianceApprovedBy: null,
    receiptsCount: 4,
    voidsCount: 0,
    refundsCount: 0,
    openedAt: '2026-08-24T03:00:00.000Z',
    closedAt: null,
    totals: [],
    pendingConfirmations: 0,
    blockedBy: null,
    ...overrides,
  });

  it('says nothing is blocking a clean shift', () => {
    expect(closeBlockers(shift(), 'me')).toEqual([]);
  });

  /**
   * The preview endpoint is `get()` on the server and hard-codes `blockedBy: null`,
   * so without this derivation the screen would promise a clean close and then be
   * refused — the worst of both.
   */
  it('derives the variance block the preview does not report', () => {
    const blockers = closeBlockers(
      shift({ status: 'closing', variance: '-500.00', varianceReason: 'Short', blockedBy: null }),
      'me',
    );
    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.kind).toBe('variance_approval');
  });

  it('clears once somebody else has approved it', () => {
    const blockers = closeBlockers(
      shift({ status: 'closing', variance: '-500.00', varianceApprovedBy: 'head-cashier' }),
      'me',
    );
    expect(blockers).toEqual([]);
  });

  it('reports an unconfirmed digital tender — money the hospital does not have yet', () => {
    const blockers = closeBlockers(shift({ pendingConfirmations: 2 }), 'me');
    expect(blockers[0]).toEqual({ kind: 'pending_confirmations', count: 2 });
  });

  it('refuses somebody else’s drawer', () => {
    expect(closeBlockers(shift(), 'somebody-else')[0]?.kind).toBe('not_your_shift');
  });

  it('stops at "already closed" rather than listing further work', () => {
    expect(closeBlockers(shift({ status: 'closed', pendingConfirmations: 3 }), 'me')).toEqual([
      { kind: 'already_closed' },
    ]);
  });
});
