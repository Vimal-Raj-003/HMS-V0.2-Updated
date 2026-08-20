'use client';

import { Money, currencyMeta, type CurrencyCode } from '@vims/contracts/primitives';
import { Banknote, CheckCircle2, Coins, TrendingDown, TrendingUp } from 'lucide-react';
import { useId, useState } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/button.js';
import { Textarea, inputClassName } from '../primitives/input.js';
import { Label } from '../primitives/label.js';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '../primitives/table.js';

/**
 * `DenominationSheet` — the cash-counting sheet for NC-001 shift close
 * (docs/prompts/phase-01 §1.6: "denomination sheet, shift close with variance").
 *
 * Every rupee here is a `bigint` count of minor units through `Money`
 * (`packages/contracts/src/primitives/money.ts`). There is no `Number()`, no
 * `parseFloat` and no `toFixed` on an amount anywhere in this file: a float in a cash
 * drawer is how a counter ends the day 3 paise short and nobody can say why.
 *
 * The variance is a discriminated union rather than a signed number, so a caller
 * cannot render "-₹500.00 over". `over` and `short` both carry a positive amount and
 * the direction is in the type.
 */

export interface Denomination {
  /** Face value in minor units — `200000n` is a ₹2,000 note. */
  readonly minor: bigint;
  /** Already-localised face-value label, e.g. `₹2,000`. */
  readonly label: string;
  readonly kind: 'note' | 'coin';
}

/**
 * Keyed by `denominationKey` (kind + face value) so the key survives a JSON round-trip
 * AND so the ₹20 note and the ₹20 coin — which have the same face value — stay two
 * separate rows on the sheet instead of silently sharing one count.
 */
export type DenominationCounts = Readonly<Record<string, number>>;

export type CashVariance =
  | { readonly kind: 'balanced'; readonly amount: Money }
  /** Counted more than the system expected. `amount` is always positive. */
  | { readonly kind: 'over'; readonly amount: Money }
  /** Counted less than the system expected. `amount` is always positive. */
  | { readonly kind: 'short'; readonly amount: Money };

export function denominationKey(denomination: Denomination): string {
  return `${denomination.kind}-${denomination.minor.toString()}`;
}

/** Exact bigint sum: `Σ faceValue × count`. Fractional counts are rejected, not floored. */
export function countedTotal(
  denominations: readonly Denomination[],
  counts: DenominationCounts,
  currency: CurrencyCode,
): Money {
  return denominations.reduce<Money>((total, denomination) => {
    const count = counts[denominationKey(denomination)] ?? 0;
    if (!Number.isInteger(count) || count < 0) return total;
    return total.add(Money.fromMinor(denomination.minor, currency).timesQuantity(count));
  }, Money.zero(currency));
}

export function varianceOf(counted: Money, expected: Money): CashVariance {
  const delta = counted.subtract(expected);
  if (delta.isZero) return { kind: 'balanced', amount: delta };
  return delta.isPositive ? { kind: 'over', amount: delta } : { kind: 'short', amount: delta.abs() };
}

export interface DenominationSheetResult {
  readonly counts: DenominationCounts;
  readonly counted: Money;
  readonly expected: Money;
  readonly variance: CashVariance;
  /** Mandatory whenever the variance is not `balanced` (docs/06 §6.9 level 4). */
  readonly varianceReason?: string;
}

export interface DenominationSheetLabels {
  readonly caption: string;
  readonly scrollRegion: string;
  readonly denomination: string;
  readonly count: string;
  readonly rowTotal: string;
  readonly countedTotal: string;
  readonly expectedTotal: string;
  readonly balanced: string;
  readonly over: (amount: string) => string;
  readonly short: (amount: string) => string;
  readonly varianceReasonLabel: string;
  readonly varianceReasonPlaceholder: string;
  readonly varianceReasonRequired: string;
  readonly submit: string;
  /** Accessible name for one denomination's count field, e.g. `(l) => \`Count of ${l}\``. */
  readonly countFieldLabel: (denominationLabel: string) => string;
  /** Announced whenever the counted total changes. */
  readonly announceTotal: (counted: string, variance: string) => string;
}

export interface DenominationSheetProps {
  readonly currency: CurrencyCode;
  readonly denominations: readonly Denomination[];
  readonly counts: DenominationCounts;
  readonly onCountsChange: (counts: DenominationCounts) => void;
  /** The system's figure for the drawer — opening float + collections − refunds. */
  readonly expected: Money;
  readonly labels: DenominationSheetLabels;
  readonly onSubmit?: (result: DenominationSheetResult) => void;
  readonly disabled?: boolean;
  readonly className?: string;
}

function VarianceChip({
  variance,
  labels,
}: {
  readonly variance: CashVariance;
  readonly labels: DenominationSheetLabels;
}): React.JSX.Element {
  const formatted = variance.amount.format();
  switch (variance.kind) {
    case 'balanced':
      return (
        <span
          data-variance="balanced"
          className="inline-flex items-center gap-1 rounded-full border border-success-border bg-success-surface px-2 py-0.5 text-2xs font-medium text-success-on-surface"
        >
          <CheckCircle2 aria-hidden="true" className="size-3" />
          {labels.balanced}
        </span>
      );
    case 'over':
      return (
        <span
          data-variance="over"
          className="inline-flex items-center gap-1 rounded-full border border-warning-border bg-warning-surface px-2 py-0.5 text-2xs font-medium text-warning-on-surface"
        >
          <TrendingUp aria-hidden="true" className="size-3" />
          {labels.over(formatted)}
        </span>
      );
    case 'short':
      return (
        <span
          data-variance="short"
          className="inline-flex items-center gap-1 rounded-full border border-danger-border bg-danger-surface px-2 py-0.5 text-2xs font-medium text-danger-on-surface"
        >
          <TrendingDown aria-hidden="true" className="size-3" />
          {labels.short(formatted)}
        </span>
      );
  }
}

export function DenominationSheet({
  currency,
  denominations,
  counts,
  onCountsChange,
  expected,
  labels,
  onSubmit,
  disabled = false,
  className,
}: DenominationSheetProps): React.JSX.Element {
  const fieldId = useId();
  const [varianceReason, setVarianceReason] = useState('');

  const counted = countedTotal(denominations, counts, currency);
  const variance = varianceOf(counted, expected);
  const varianceText =
    variance.kind === 'balanced'
      ? labels.balanced
      : variance.kind === 'over'
        ? labels.over(variance.amount.format())
        : labels.short(variance.amount.format());

  const reasonRequired = variance.kind !== 'balanced';
  const reasonGiven = varianceReason.trim().length > 0;
  const canSubmit = !disabled && (!reasonRequired || reasonGiven);

  const setCount = (denomination: Denomination, raw: string): void => {
    // Only digits reach the model. A blank field is zero, never NaN.
    if (raw !== '' && !/^\d+$/.test(raw)) return;
    const next: Record<string, number> = { ...counts };
    next[denominationKey(denomination)] = raw === '' ? 0 : Number.parseInt(raw, 10);
    onCountsChange(next);
  };

  const focusSibling = (index: number, direction: 1 | -1): void => {
    const target = document.getElementById(`${fieldId}-count-${String(index + direction)}`);
    if (target instanceof HTMLInputElement) target.focus();
  };

  return (
    <section
      data-slot="denomination-sheet"
      className={cn('flex flex-col gap-3', className)}
      aria-label={labels.caption}
    >
      <Table scrollRegionLabel={labels.scrollRegion}>
        <caption className="sr-only">{labels.caption}</caption>
        <TableHeader>
          <TableRow>
            <TableHead>{labels.denomination}</TableHead>
            <TableHead className="text-end">{labels.count}</TableHead>
            <TableHead className="text-end">{labels.rowTotal}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {denominations.map((denomination, index) => {
            const key = denominationKey(denomination);
            const count = counts[key] ?? 0;
            const rowTotal = Money.fromMinor(denomination.minor, currency).timesQuantity(
              Number.isInteger(count) && count > 0 ? count : 0,
            );
            const Icon = denomination.kind === 'note' ? Banknote : Coins;
            return (
              <TableRow key={key} data-denomination={key}>
                <TableCell>
                  <span className="inline-flex items-center gap-2">
                    <Icon aria-hidden="true" className="size-4 text-fg-muted" />
                    <span className="font-mono tabular-nums">{denomination.label}</span>
                  </span>
                </TableCell>
                <TableCell className="text-end">
                  <input
                    id={`${fieldId}-count-${String(index)}`}
                    data-count-for={key}
                    type="text"
                    inputMode="numeric"
                    dir="ltr"
                    autoComplete="off"
                    disabled={disabled}
                    aria-label={labels.countFieldLabel(denomination.label)}
                    value={count === 0 ? '' : String(count)}
                    onChange={(event) => {
                      setCount(denomination, event.target.value);
                    }}
                    onKeyDown={(event) => {
                      // Cash counting is a two-hand, eyes-down job: Enter and the arrow
                      // keys walk the column so the cashier never reaches for a mouse.
                      if (event.key === 'Enter' || event.key === 'ArrowDown') {
                        event.preventDefault();
                        focusSibling(index, 1);
                      } else if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        focusSibling(index, -1);
                      }
                    }}
                    className={cn(inputClassName, 'w-24 text-end font-mono tabular-nums')}
                  />
                </TableCell>
                <TableCell className="text-end font-mono tabular-nums" data-row-total={key}>
                  {rowTotal.format()}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={2}>{labels.countedTotal}</TableCell>
            <TableCell className="text-end font-mono tabular-nums" data-total="counted">
              {counted.format()}
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell colSpan={2}>{labels.expectedTotal}</TableCell>
            <TableCell className="text-end font-mono tabular-nums" data-total="expected">
              {expected.format()}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>

      <div className="flex flex-wrap items-center gap-2">
        <VarianceChip variance={variance} labels={labels} />
        <span data-total="variance" className="font-mono text-sm tabular-nums text-fg-muted">
          {variance.amount.format()}
        </span>
      </div>

      {/* docs/06 §1.1.1 — never a silent state change; the running total is announced. */}
      <span aria-live="polite" className="sr-only">
        {labels.announceTotal(counted.format(), varianceText)}
      </span>

      {reasonRequired ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${fieldId}-variance-reason`} required>
            {labels.varianceReasonLabel}
          </Label>
          <Textarea
            id={`${fieldId}-variance-reason`}
            value={varianceReason}
            disabled={disabled}
            aria-required="true"
            aria-invalid={!reasonGiven}
            aria-describedby={`${fieldId}-variance-hint`}
            placeholder={labels.varianceReasonPlaceholder}
            onChange={(event) => {
              setVarianceReason(event.target.value);
            }}
          />
          <p id={`${fieldId}-variance-hint`} className="text-xs text-fg-muted">
            {labels.varianceReasonRequired}
          </p>
        </div>
      ) : null}

      {onSubmit === undefined ? null : (
        <div className="flex justify-end">
          <Button
            variant="primary"
            disabled={!canSubmit}
            onClick={() => {
              if (!canSubmit) return;
              onSubmit({
                counts,
                counted,
                expected,
                variance,
                ...(reasonRequired ? { varianceReason: varianceReason.trim() } : {}),
              });
            }}
          >
            {labels.submit}
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * The Reserve Bank's current note and coin series, as the default sheet for an INR
 * counter. Exported so a tenant can override it (a branch that never sees ₹1 coins
 * should not count a row of zeroes) without every caller re-deriving the list.
 */
export function defaultInrDenominations(format: (minor: bigint) => string): Denomination[] {
  const notes: bigint[] = [200_000n, 50_000n, 20_000n, 10_000n, 5_000n, 2_000n, 1_000n];
  const coins: bigint[] = [2_000n, 1_000n, 500n, 200n, 100n];
  return [
    ...notes.map((minor): Denomination => ({ minor, label: format(minor), kind: 'note' })),
    ...coins.map((minor): Denomination => ({ minor, label: format(minor), kind: 'coin' })),
  ];
}

/** Convenience formatter for the labels above — `50000n` → `₹500.00`. */
export function formatFaceValue(minor: bigint, currency: CurrencyCode): string {
  return Money.fromMinor(minor, currency).format();
}

/** Re-exported so callers can build labels without importing contracts directly. */
export function currencySymbolFor(currency: CurrencyCode): string {
  return currencyMeta(currency).symbol;
}
