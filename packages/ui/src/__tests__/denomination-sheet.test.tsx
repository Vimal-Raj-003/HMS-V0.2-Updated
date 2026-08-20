import { Money } from '@vims/contracts/primitives';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  DenominationSheet,
  countedTotal,
  defaultInrDenominations,
  denominationKey,
  formatFaceValue,
  varianceOf,
  type Denomination,
  type DenominationCounts,
  type DenominationSheetLabels,
  type DenominationSheetResult,
} from '../clinical/denomination-sheet.js';
import { findAccessibilityViolations } from './axe.js';

const labels: DenominationSheetLabels = {
  caption: 'Denomination sheet — counter 2, shift 14:00–22:00',
  scrollRegion: 'Denomination rows',
  denomination: 'Denomination',
  count: 'Count',
  rowTotal: 'Value',
  countedTotal: 'Counted',
  expectedTotal: 'Expected',
  balanced: 'Balanced',
  over: (amount) => `Over by ${amount}`,
  short: (amount) => `Short by ${amount}`,
  varianceReasonLabel: 'Reason for the variance',
  varianceReasonPlaceholder: 'e.g. change given from personal cash',
  varianceReasonRequired: 'A variance must be explained before the shift can close.',
  submit: 'Close shift',
  countFieldLabel: (denominationLabel) => `Count of ${denominationLabel}`,
  announceTotal: (counted, variance) => `Counted ${counted}. ${variance}`,
};

const note500: Denomination = { minor: 50_000n, label: '₹500.00', kind: 'note' };
const note100: Denomination = { minor: 10_000n, label: '₹100.00', kind: 'note' };
const coin1: Denomination = { minor: 100n, label: '₹1.00', kind: 'coin' };
const DENOMS: readonly Denomination[] = [note500, note100, coin1];

function Harness({
  expected,
  initial = {},
  onSubmit,
}: {
  readonly expected: Money;
  readonly initial?: DenominationCounts;
  readonly onSubmit?: (result: DenominationSheetResult) => void;
}): React.JSX.Element {
  const [counts, setCounts] = useState<DenominationCounts>(initial);
  return (
    <DenominationSheet
      currency="INR"
      denominations={DENOMS}
      counts={counts}
      onCountsChange={setCounts}
      expected={expected}
      labels={labels}
      {...(onSubmit === undefined ? {} : { onSubmit })}
    />
  );
}

describe('DenominationSheet — NC-001 shift close', () => {
  it('totals in bigint minor units, never in floating point', () => {
    const counts: DenominationCounts = {
      [denominationKey(note500)]: 3,
      [denominationKey(note100)]: 7,
      [denominationKey(coin1)]: 0,
    };
    const total = countedTotal(DENOMS, counts, 'INR');
    expect(total.minor).toBe(220_000n);
    expect(typeof total.minor).toBe('bigint');
    expect(total.toDecimalString()).toBe('2200.00');
    expect(total.format()).toBe('₹2,200.00');
  });

  it('is exact where float arithmetic is not (3 × ₹0.10)', () => {
    const tenPaise: Denomination = { minor: 10n, label: '₹0.10', kind: 'coin' };
    const total = countedTotal([tenPaise], { [denominationKey(tenPaise)]: 3 }, 'INR');
    expect(total.toDecimalString()).toBe('0.30');
    // The trap this type exists to avoid.
    expect(0.1 * 3).not.toBe(0.3);
  });

  it('reports a deliberate over-variance with a positive amount and a direction', () => {
    const counted = Money.fromMinor(220_000n, 'INR');
    const expected = Money.fromMinor(215_000n, 'INR');
    const variance = varianceOf(counted, expected);
    expect(variance.kind).toBe('over');
    expect(variance.amount.minor).toBe(5_000n);
    expect(variance.amount.isNegative).toBe(false);
  });

  it('reports a short drawer as `short`, also with a positive amount', () => {
    const variance = varianceOf(Money.fromMinor(210_000n, 'INR'), Money.fromMinor(215_000n, 'INR'));
    expect(variance.kind).toBe('short');
    expect(variance.amount.minor).toBe(5_000n);
  });

  it('renders the counted total, the variance chip and the row values', () => {
    const { container } = render(
      <Harness
        expected={Money.fromMinor(215_000n, 'INR')}
        initial={{ [denominationKey(note500)]: 3, [denominationKey(note100)]: 7 }}
      />,
    );
    expect(container.querySelector('[data-total="counted"]')?.textContent).toBe('₹2,200.00');
    expect(container.querySelector('[data-total="expected"]')?.textContent).toBe('₹2,150.00');
    expect(container.querySelector('[data-variance="over"]')?.textContent).toContain('Over by ₹50.00');
    expect(container.querySelector(`[data-row-total="${denominationKey(note500)}"]`)?.textContent).toBe(
      '₹1,500.00',
    );
  });

  it('recomputes exactly as notes are counted in', () => {
    const { container } = render(<Harness expected={Money.fromMinor(50_000n, 'INR')} />);
    fireEvent.change(screen.getByLabelText('Count of ₹500.00'), { target: { value: '1' } });
    expect(container.querySelector('[data-total="counted"]')?.textContent).toBe('₹500.00');
    expect(container.querySelector('[data-variance="balanced"]')).not.toBeNull();
  });

  it('refuses non-numeric input rather than producing NaN', () => {
    const { container } = render(<Harness expected={Money.zero('INR')} />);
    fireEvent.change(screen.getByLabelText('Count of ₹100.00'), { target: { value: '2.5' } });
    expect(container.querySelector('[data-total="counted"]')?.textContent).toBe('₹0.00');
  });

  it('will not close a shift with a variance until the variance is explained', () => {
    const onSubmit = vi.fn<(result: DenominationSheetResult) => void>();
    render(
      <Harness
        expected={Money.fromMinor(215_000n, 'INR')}
        initial={{ [denominationKey(note500)]: 3, [denominationKey(note100)]: 7 }}
        onSubmit={onSubmit}
      />,
    );
    const submit = screen.getByRole('button', { name: 'Close shift' });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Reason for the variance/), {
      target: { value: 'Change given from personal cash, reimbursed' },
    });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    const result = onSubmit.mock.calls[0]?.[0];
    expect(result?.counted.minor).toBe(220_000n);
    expect(result?.variance.kind).toBe('over');
    expect(result?.varianceReason).toBe('Change given from personal cash, reimbursed');
  });

  it('closes without a reason when the drawer balances', () => {
    const onSubmit = vi.fn<(result: DenominationSheetResult) => void>();
    render(
      <Harness
        expected={Money.fromMinor(150_000n, 'INR')}
        initial={{ [denominationKey(note500)]: 3 }}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.queryByLabelText(/Reason for the variance/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close shift' }));
    expect(onSubmit.mock.calls[0]?.[0].variance.kind).toBe('balanced');
    expect(onSubmit.mock.calls[0]?.[0].varianceReason).toBeUndefined();
  });

  it('walks the count column with Enter and the arrow keys', () => {
    render(<Harness expected={Money.zero('INR')} />);
    const first = screen.getByLabelText('Count of ₹500.00');
    const second = screen.getByLabelText('Count of ₹100.00');
    first.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
  });

  it('keeps the ₹20 note and the ₹20 coin as separate rows', () => {
    const denominations = defaultInrDenominations((minor) => formatFaceValue(minor, 'INR'));
    const keys = denominations.map(denominationKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('note-2000');
    expect(keys).toContain('coin-2000');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <Harness
        expected={Money.fromMinor(215_000n, 'INR')}
        initial={{ [denominationKey(note500)]: 3 }}
        onSubmit={() => undefined}
      />,
    );
    await expect(findAccessibilityViolations(container)).resolves.toEqual([]);
  });
});
