import { Money } from '@vims/contracts/primitives';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MoneyInput, type MoneyInputLabels } from '../clinical/money-input.js';
import { findAccessibilityViolations } from './axe.js';

const labels: MoneyInputLabels = {
  invalid: 'Enter a valid amount',
  tooManyDecimals: 'Only two decimal places',
  negativeNotAllowed: 'Negative amounts need a credit note',
  announce: (formatted) => `Amount ${formatted}`,
};

function Harness({
  onChange,
  allowNegative = false,
}: {
  readonly onChange?: (value: Money | null) => void;
  readonly allowNegative?: boolean;
}): React.JSX.Element {
  const [value, setValue] = useState<Money | null>(null);
  return (
    <>
      <label htmlFor="amount">Amount</label>
      <MoneyInput
        id="amount"
        value={value}
        currency="INR"
        allowNegative={allowNegative}
        labels={labels}
        onValueChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
    </>
  );
}

describe('MoneyInput — docs/06 §5.2 #24', () => {
  it('emits bigint minor units, never a float', () => {
    const onChange = vi.fn<(value: Money | null) => void>();
    render(<Harness onChange={onChange} />);
    const field = screen.getByLabelText('Amount');
    fireEvent.change(field, { target: { value: '12345678.50' } });

    const last = onChange.mock.calls.at(-1)?.[0];
    expect(last).toBeInstanceOf(Money);
    expect(last?.minor).toBe(1_234_567_850n);
    expect(typeof last?.minor).toBe('bigint');
    // The whole point: there is no `number` representation of the amount anywhere.
    expect(last?.toDecimalString()).toBe('12345678.50');
  });

  it('formats with Indian lakh/crore grouping on blur', () => {
    render(<Harness />);
    const field = screen.getByLabelText('Amount');
    fireEvent.change(field, { target: { value: '12345678.5' } });
    fireEvent.blur(field);
    expect((field as HTMLInputElement).value).toBe('1,23,45,678.50');
    expect(screen.getByText('Amount ₹1,23,45,678.50')).toBeInTheDocument();
  });

  it('is paste-tolerant: grouping, spaces and the symbol survive a paste', () => {
    const onChange = vi.fn<(value: Money | null) => void>();
    render(<Harness onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '₹ 1,23,456.75' } });
    expect(onChange.mock.calls.at(-1)?.[0]?.minor).toBe(12_345_675n);
  });

  it('never rounds silently — a third decimal is an error, not a truncation', () => {
    const onChange = vi.fn<(value: Money | null) => void>();
    render(<Harness onChange={onChange} />);
    const field = screen.getByLabelText('Amount');
    fireEvent.change(field, { target: { value: '10.005' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Only two decimal places');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('blocks a negative unless the field is a credit note', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '-50' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Negative amounts need a credit note');
  });

  it('allows a negative on a credit note', () => {
    const onChange = vi.fn<(value: Money | null) => void>();
    render(<Harness onChange={onChange} allowNegative />);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '-50.25' } });
    expect(onChange.mock.calls.at(-1)?.[0]?.minor).toBe(-5025n);
  });

  it('clears to null on an empty field rather than to zero', () => {
    const onChange = vi.fn<(value: Money | null) => void>();
    render(<Harness onChange={onChange} />);
    const field = screen.getByLabelText('Amount');
    fireEvent.change(field, { target: { value: '10' } });
    fireEvent.change(field, { target: { value: '' } });
    expect(onChange.mock.calls.at(-1)?.[0]).toBeNull();
  });

  it('is reachable and editable by keyboard, and has no axe violations', async () => {
    const { container } = render(<Harness />);
    const field = screen.getByLabelText('Amount');
    field.focus();
    expect(document.activeElement).toBe(field);
    await expect(findAccessibilityViolations(container)).resolves.toEqual([]);
  });
});
