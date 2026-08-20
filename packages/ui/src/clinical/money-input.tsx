'use client';

import { Money, MoneyError, currencyMeta, type CurrencyCode } from '@vims/contracts/primitives';
import { useId, useState, type ChangeEvent, type ComponentProps, type FocusEvent } from 'react';
import { cn } from '../lib/cn.js';
import { inputClassName } from '../primitives/input.js';

/**
 * `MoneyInput` — docs/06 §5.2 #24.
 *
 * "`numeric(14,2)`, currency prefix from tenant, Indian grouping (`₹1,23,45,678.00`),
 *  no float maths (minor units), paste-tolerant, `-` blocked unless credit note,
 *  on blur formats and announces the value. Never rounds silently."
 *
 * Every number that leaves this component is a `Money` from `@vims/contracts` — a
 * `bigint` count of minor units. There is no code path here that calls `Number()`,
 * `parseFloat` or `toFixed` on an amount, which is the whole point of the type
 * (`packages/contracts/src/primitives/money.ts`).
 */
export interface MoneyInputLabels {
  /** Shown when the text is not a valid amount. */
  readonly invalid: string;
  /** Shown when the user typed more decimals than the currency has. */
  readonly tooManyDecimals: string;
  /** Shown when a `-` is typed on a field that is not a credit note. */
  readonly negativeNotAllowed: string;
  /** Announced politely on blur, e.g. `(v) => \`Amount ${v}\``. */
  readonly announce: (formatted: string) => string;
}

export interface MoneyInputProps extends Omit<
  ComponentProps<'input'>,
  'value' | 'onChange' | 'type' | 'defaultValue'
> {
  readonly value: Money | null;
  readonly currency: CurrencyCode;
  readonly onValueChange: (value: Money | null) => void;
  /** §5.2 #24 — a leading `-` is only legal on a credit note. */
  readonly allowNegative?: boolean;
  readonly labels: MoneyInputLabels;
  /** Rendered before the field; defaults to the currency's symbol. */
  readonly symbol?: string;
}

function toEditableText(value: Money | null): string {
  return value === null ? '' : value.toDecimalString();
}

export function MoneyInput({
  value,
  currency,
  onValueChange,
  allowNegative = false,
  labels,
  symbol,
  className,
  onBlur,
  onFocus,
  id,
  ...props
}: MoneyInputProps): React.JSX.Element {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  const liveId = `${inputId}-live`;

  const [text, setText] = useState<string>(() => (value === null ? '' : value.format({ withSymbol: false })));
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string>('');

  const meta = currencyMeta(currency);

  const parse = (raw: string): { money: Money | null; error: string | null } => {
    const trimmed = raw.trim();
    if (trimmed === '') return { money: null, error: null };
    if (trimmed.startsWith('-') && !allowNegative) {
      return { money: null, error: labels.negativeNotAllowed };
    }
    try {
      return { money: Money.parse(trimmed, currency), error: null };
    } catch (caught) {
      if (caught instanceof MoneyError && caught.message.includes('decimal places')) {
        return { money: null, error: labels.tooManyDecimals };
      }
      return { money: null, error: labels.invalid };
    }
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    // Paste-tolerant: grouping separators, spaces and the currency symbol are stripped
    // by `Money.parse`, so the raw text is kept as typed until blur.
    const raw = event.target.value;
    setText(raw);
    const result = parse(raw);
    setError(result.error);
    if (result.error === null) {
      onValueChange(result.money);
    }
  };

  const handleBlur = (event: FocusEvent<HTMLInputElement>): void => {
    const result = parse(text);
    if (result.error === null) {
      const formatted = result.money === null ? '' : result.money.format();
      setText(result.money === null ? '' : result.money.format({ withSymbol: false }));
      setAnnouncement(formatted === '' ? '' : labels.announce(formatted));
      onValueChange(result.money);
    }
    onBlur?.(event);
  };

  const handleFocus = (event: FocusEvent<HTMLInputElement>): void => {
    // Editing happens on the plain decimal form so grouping never fights the caret.
    setText(toEditableText(value));
    setAnnouncement('');
    onFocus?.(event);
  };

  return (
    <div data-slot="money-input" className="flex flex-col gap-1">
      <div className="relative flex items-center">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-inline-start-3 text-md text-fg-muted"
        >
          {symbol ?? meta.symbol}
        </span>
        <input
          id={inputId}
          // `inputMode` gives tablets a numeric pad; `type=text` keeps grouping and
          // the minus sign under our control instead of the browser's.
          type="text"
          inputMode="decimal"
          autoComplete="off"
          dir="ltr"
          value={text}
          onChange={handleChange}
          onBlur={handleBlur}
          onFocus={handleFocus}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : errorId}
          className={cn(inputClassName, 'ps-8 text-end font-mono tabular-nums', className)}
          {...props}
        />
      </div>
      {error === null ? null : (
        <p id={errorId} role="alert" className="text-xs text-danger-fg">
          {error}
        </p>
      )}
      <span id={liveId} aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}
