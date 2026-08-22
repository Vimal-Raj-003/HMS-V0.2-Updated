'use client';

import { useMutation } from '@tanstack/react-query';
import { Money, type CurrencyCode } from '@vims/contracts/primitives';
import {
  Badge,
  Button,
  Input,
  Label,
  MoneyInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
  type MoneyInputLabels,
} from '@vims/ui';
import { useId, useMemo, useState } from 'react';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { collectPayment } from '../api/client';
import { newIdempotencyKey } from '../api/http';
import { PAYMENT_MODES, type PaymentLineRequest, type PaymentMode, type ShiftView } from '../api/types';

import {
  PAYMENT_MODE_LABELS,
  asCurrency,
  cashPortion,
  changeDue,
  isCashCapProblem,
  parseCashCapRefusal,
  precheckCashTender,
  splitBalance,
  type TenderLine,
} from '../lib/cash';
import { useShortcuts, type Shortcut } from '../lib/shortcuts';
import { CashCapNotice } from './cash-cap-notice';

/** The select hands back a `string`; a mode the API does not know must not reach it. */
function asPaymentMode(value: string): PaymentMode | null {
  return (PAYMENT_MODES as readonly string[]).includes(value) ? (value as PaymentMode) : null;
}

/**
 * Taking money — NC-001 §3.3, `docs/prompts/phase-01` §1.6.
 *
 * Everything here is exact. The amount, every tender line, the change due and
 * the running remainder are `Money` — a `bigint` count of minor units — and the
 * only strings that leave the panel are `toDecimalString()`, which is what the
 * API's `positiveMoneySchema` takes. There is no `Number()` on an amount
 * anywhere, because a split that is 1234.5499999999999 balances on the screen
 * and fails at the shift close, attributed to the wrong cashier.
 *
 * Two refusals are handled as refusals rather than as errors:
 *
 *  - **The split must balance** before the button enables. The server checks it
 *    too — that is the check that protects the ledger — but discovering at submit
 *    time that you are ₹50 short with a patient at the window is avoidable.
 *  - **§269ST** is rendered by `CashCapNotice`, never as a retryable problem.
 *
 * The `Idempotency-Key` is generated once per intent and **kept across retries**,
 * so a tablet that resubmits gets the same receipt back rather than charging the
 * patient twice (NC-001 §3.3.2).
 */

const MONEY_LABELS: MoneyInputLabels = {
  invalid: 'That is not an amount.',
  tooManyDecimals: 'Too many decimal places for this currency.',
  negativeNotAllowed: 'A collection cannot be negative. Use a refund instead.',
  announce: (formatted) => `Amount ${formatted}`,
};

let lineCounter = 0;
function newLine(mode: PaymentMode): TenderLine {
  lineCounter += 1;
  return {
    id: `line-${String(lineCounter)}`,
    mode,
    amount: null,
    tendered: null,
    reference: '',
    pending: false,
  };
}

export function CollectPaymentPanel({
  shift,
  onCollected,
}: {
  readonly shift: ShiftView;
  readonly onCollected: () => void;
}): React.JSX.Element {
  const fieldId = useId();
  const { publish } = useToast();
  const currency: CurrencyCode = asCurrency(shift.currency);

  const [amount, setAmount] = useState<Money | null>(null);
  const [purpose, setPurpose] = useState('consultation');
  const [payerName, setPayerName] = useState('');
  const [patientId, setPatientId] = useState('');
  const [lines, setLines] = useState<readonly TenderLine[]>(() => [newLine('cash')]);
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey());

  const balance = splitBalance(amount, lines, currency);
  const cash = cashPortion(lines, currency);
  const precheck = precheckCashTender(cash, currency);

  const collect = useMutation({
    mutationFn: (body: { readonly lines: readonly PaymentLineRequest[]; readonly total: Money }) =>
      collectPayment(
        {
          shiftId: shift.id,
          purpose: purpose.trim() === '' ? 'consultation' : purpose.trim(),
          amount: body.total.toDecimalString(),
          ...(patientId.trim() === '' ? {} : { patientId: patientId.trim() }),
          ...(payerName.trim() === '' ? {} : { payerName: payerName.trim() }),
          lines: body.lines,
        },
        idempotencyKey,
      ),
    onSuccess: (payment) => {
      publish({
        title: `Receipt ${payment.receiptNo}`,
        description: `${Money.parse(payment.amount, currency).format()} collected.`,
        severity: 'success',
      });
      setAmount(null);
      setLines([newLine('cash')]);
      setPatientId('');
      setPayerName('');
      // A fresh intent gets a fresh key; a retry of the *same* intent must not.
      setIdempotencyKey(newIdempotencyKey());
      onCollected();
    },
  });

  const capRefusal = parseCashCapRefusal(collect.error, cash, currency);
  const capRefused = isCashCapProblem(collect.error);

  const setLine = (id: string, patch: Partial<TenderLine>): void => {
    setLines((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  };

  const addLine = (mode: PaymentMode): void => {
    setLines((current) => [...current, newLine(mode)]);
  };

  const canSubmit =
    amount !== null &&
    amount.isPositive &&
    balance.kind === 'balanced' &&
    precheck.kind === 'ok' &&
    !collect.isPending;

  const shortcuts: readonly Shortcut[] = useMemo(
    () => [
      {
        key: 'F2',
        label: 'Add cash',
        keys: ['F2'],
        run: () => {
          addLine('cash');
        },
      },
      {
        key: 'F3',
        label: 'Add card',
        keys: ['F3'],
        run: () => {
          addLine('card');
        },
      },
      {
        key: 'F4',
        label: 'Add UPI',
        keys: ['F4'],
        run: () => {
          addLine('upi');
        },
      },
      {
        key: 'F5',
        label: 'Add cheque',
        keys: ['F5'],
        run: () => {
          addLine('cheque');
        },
      },
    ],
    [],
  );
  useShortcuts(shortcuts);

  const submit = (): void => {
    if (!canSubmit || amount === null) return;
    const payload: PaymentLineRequest[] = lines
      .filter((line) => line.amount !== null && line.amount.isPositive && asPaymentMode(line.mode) !== null)
      .map((line) => {
        const lineAmount = line.amount ?? Money.zero(currency);
        return {
          mode: asPaymentMode(line.mode) ?? 'cash',
          amount: lineAmount.toDecimalString(),
          ...(line.mode === 'cash' && line.tendered !== null
            ? { tendered: line.tendered.toDecimalString() }
            : {}),
          ...(line.reference.trim() === '' ? {} : { reference: line.reference.trim() }),
          pending: line.pending,
        };
      });
    collect.mutate({ lines: payload, total: amount });
  };

  return (
    <section
      data-testid="collect-panel"
      aria-labelledby={`${fieldId}-heading`}
      className="flex flex-col gap-4 rounded-lg border border-strong bg-layer-1 p-4"
    >
      <h2 id={`${fieldId}-heading`} className="text-lg font-semibold text-fg-default">
        Take a payment
      </h2>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${fieldId}-amount`} required>
            Amount payable
          </Label>
          <MoneyInput
            id={`${fieldId}-amount`}
            data-testid="collect-amount"
            value={amount}
            currency={currency}
            labels={MONEY_LABELS}
            onValueChange={setAmount}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${fieldId}-purpose`}>Purpose</Label>
          <Input
            id={`${fieldId}-purpose`}
            data-testid="collect-purpose"
            value={purpose}
            autoComplete="off"
            onChange={(event) => {
              setPurpose(event.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${fieldId}-payer`}>Paid by</Label>
          <Input
            id={`${fieldId}-payer`}
            data-testid="collect-payer"
            value={payerName}
            autoComplete="off"
            placeholder="Name on the receipt"
            onChange={(event) => {
              setPayerName(event.target.value);
            }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={`${fieldId}-patient`}>Patient</Label>
        <Input
          id={`${fieldId}-patient`}
          data-testid="collect-patient"
          value={patientId}
          spellCheck={false}
          autoComplete="off"
          className="font-mono text-xs"
          placeholder="Patient identifier — required for an advance, and for any cash tender"
          onChange={(event) => {
            setPatientId(event.target.value);
          }}
        />
        <p className="text-2xs text-fg-muted">
          Cash cannot be accepted without a named payer: §269ST is a per-payer daily limit, and an
          unattributed receipt would let the cap be evaded by splitting across patients.
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-md font-medium text-fg-default">Tenders</legend>
        {lines.map((line) => {
          const change = changeDue(line);
          return (
            <div
              key={line.id}
              data-testid={`tender-${line.mode}`}
              className="flex flex-wrap items-end gap-2 rounded-md border border-default p-2"
            >
              <div className="flex min-w-40 flex-col gap-1">
                <Label htmlFor={`${line.id}-mode`}>Mode</Label>
                <Select
                  value={line.mode}
                  onValueChange={(next) => {
                    setLine(line.id, { mode: next });
                  }}
                >
                  <SelectTrigger id={`${line.id}-mode`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAYMENT_MODES.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {PAYMENT_MODE_LABELS[mode] ?? mode}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex min-w-40 flex-col gap-1">
                <Label htmlFor={`${line.id}-amount`}>Amount</Label>
                <MoneyInput
                  id={`${line.id}-amount`}
                  data-testid={`tender-amount-${line.mode}`}
                  value={line.amount}
                  currency={currency}
                  labels={MONEY_LABELS}
                  onValueChange={(next) => {
                    setLine(line.id, { amount: next });
                  }}
                />
              </div>
              {line.mode === 'cash' ? (
                <div className="flex min-w-40 flex-col gap-1">
                  <Label htmlFor={`${line.id}-tendered`}>Handed over</Label>
                  <MoneyInput
                    id={`${line.id}-tendered`}
                    data-testid="tender-handed-over"
                    value={line.tendered}
                    currency={currency}
                    labels={MONEY_LABELS}
                    onValueChange={(next) => {
                      setLine(line.id, { tendered: next });
                    }}
                  />
                </div>
              ) : (
                <div className="flex min-w-40 flex-col gap-1">
                  <Label htmlFor={`${line.id}-reference`}>Reference</Label>
                  <Input
                    id={`${line.id}-reference`}
                    value={line.reference}
                    autoComplete="off"
                    onChange={(event) => {
                      setLine(line.id, { reference: event.target.value });
                    }}
                  />
                </div>
              )}
              {change === null ? null : (
                <Badge tone="info" data-testid="change-due">
                  Change {change.format()}
                </Badge>
              )}
              {lines.length > 1 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove the ${PAYMENT_MODE_LABELS[line.mode] ?? line.mode} tender`}
                  onClick={() => {
                    setLines((current) => current.filter((candidate) => candidate.id !== line.id));
                  }}
                >
                  Remove
                </Button>
              ) : null}
            </div>
          );
        })}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            data-testid="add-cash"
            onClick={() => {
              addLine('cash');
            }}
          >
            Add cash
          </Button>
          <Button
            variant="secondary"
            size="sm"
            data-testid="add-card"
            onClick={() => {
              addLine('card');
            }}
          >
            Add card
          </Button>
          <Button
            variant="secondary"
            size="sm"
            data-testid="add-upi"
            onClick={() => {
              addLine('upi');
            }}
          >
            Add UPI
          </Button>
        </div>
      </fieldset>

      <p role="status" data-testid="split-balance" className="text-md text-fg-default">
        {balance.kind === 'balanced' ? (
          <span className="text-success-fg">The tenders balance exactly.</span>
        ) : balance.kind === 'short' ? (
          <span className="text-warning-fg">
            Still to collect: <span className="font-mono">{balance.by.format()}</span>
          </span>
        ) : (
          <span className="text-danger-fg">
            The tenders exceed the amount by <span className="font-mono">{balance.by.format()}</span>. A split
            must balance exactly.
          </span>
        )}
      </p>

      {precheck.kind === 'refused' ? (
        <div role="alert" className="rounded-lg border-2 border-danger-border bg-danger-surface p-3">
          <p className="text-md font-semibold text-danger-on-surface">
            A cash tender of {precheck.attempted.format()} can never be accepted
          </p>
          <p className="mt-1 text-sm text-danger-on-surface">
            §269ST forbids receiving {precheck.cap.format()} or more in cash from one person in one day. The
            most that can be taken in cash is {precheck.maximumCash.format()}, and even that depends on what
            this payer has already given today.
          </p>
          <p className="mt-1 text-sm text-danger-on-surface">
            Take the balance by card, UPI, cheque or bank transfer.
          </p>
        </div>
      ) : null}

      {capRefused ? (
        <CashCapNotice refusal={capRefusal} error={collect.error} amountDue={amount} />
      ) : collect.error === null ? null : (
        <ProblemCard error={collect.error} />
      )}

      <div className="flex justify-end">
        <Button variant="primary" data-testid="collect-confirm" disabled={!canSubmit} onClick={submit}>
          {collect.isPending ? 'Collecting…' : 'Collect and print the receipt'}
        </Button>
      </div>
    </section>
  );
}
