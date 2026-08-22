'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CurrencyCode } from '@vims/contracts/primitives';
import {
  Badge,
  Button,
  DenominationSheet,
  EmptyState,
  SkeletonList,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  defaultInrDenominations,
  formatFaceValue,
  useToast,
  type Denomination,
  type DenominationCounts,
  type DenominationSheetLabels,
} from '@vims/ui';
import { useMemo, useState } from 'react';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { listShifts, openShift, readShift } from '../api/client';
import { frontOfficeKeys } from '../api/keys';
import type { ShiftView } from '../api/types';
import { PAYMENT_MODE_LABELS, asCurrency, parseMoney, sheetTotal, toDenominationLines } from '../lib/cash';
import { useRemembered } from '../lib/remembered';
import { useShortcuts, type Shortcut } from '../lib/shortcuts';
import { formatStamp } from '../lib/time';
import { CloseShiftPanel } from './close-shift-panel';
import { CollectPaymentPanel } from './collect-payment-panel';
import { ContextField, isIdentifier } from './context-field';
import { ShortcutBar } from './keyboard-sheet';
import { MoneyOutPanel } from './money-out-panel';

/**
 * The cash counter — NC-001 §8 "Cashier home / Open shift", "Shift dashboard",
 * "Shift close wizard", "Refund payout"; `docs/prompts/phase-01` §1.6.
 *
 * **Finding your own shift is harder than it should be**, and the workaround is
 * worth knowing about. `GET /cash/shifts` is gated on `receipt.shift.list`, which
 * the `cashier` role template does **not** hold — a cashier holds
 * `receipt.shift.open`, `.read` and `.close` but not `.list`. So the screen tries
 * the list when the session can use it (a head cashier or finance), and otherwise
 * falls back to the shift id this device remembers from the last open, read back
 * through `GET /cash/shifts/:id`, which a cashier *can* call. Granting
 * `receipt.shift.list` to the cashier template, or returning the caller's open
 * shift from `/me`, would remove the need for this entirely.
 *
 * Every amount on this screen is `Money` — `bigint` minor units — from the moment
 * it is parsed out of the API's decimal string to the moment it is rendered.
 */

const FLOAT_SHEET_LABELS: DenominationSheetLabels = {
  caption: 'Opening float',
  scrollRegion: 'Opening float sheet',
  denomination: 'Denomination',
  count: 'Count',
  rowTotal: 'Line total',
  countedTotal: 'Counted',
  expectedTotal: 'Float being declared',
  balanced: 'The float matches the count',
  over: (amount) => `Over by ${amount}`,
  short: (amount) => `Short by ${amount}`,
  varianceReasonLabel: 'Explain the difference',
  varianceReasonPlaceholder: 'What happened',
  varianceReasonRequired: 'A difference needs a reason.',
  submit: 'Open the shift with this float',
  countFieldLabel: (label) => `Count of ${label}`,
  announceTotal: (counted) => `Float ${counted}.`,
};

export function CashCounterScreen(): React.JSX.Element {
  const { hospitalId, granted, userId } = useSession();
  const keys = frontOfficeKeys(hospitalId);
  const queryClient = useQueryClient();
  const { publish } = useToast();

  const [counterId, setCounterId] = useRemembered(hospitalId, 'cash-counter');
  const [shiftId, setShiftId] = useRemembered(hospitalId, 'cash-shift');
  const [floatCounts, setFloatCounts] = useState<DenominationCounts>({});
  const [closing, setClosing] = useState(false);

  const canList = granted.has('receipt.shift.list');
  const canOpen = granted.has('receipt.shift.open');
  const canCollect = granted.has('receipt.collect');
  const canClose = granted.has('receipt.shift.close');

  const listQuery = useQuery({
    queryKey: keys.shifts('open'),
    queryFn: ({ signal }) => listShifts({ status: 'open' }, { signal }),
    enabled: canList,
    staleTime: 15_000,
  });

  const rememberedId = listQuery.data?.items.find((row) => row.cashier_user_id === userId)?.id ?? shiftId;

  const shiftQuery = useQuery({
    queryKey: keys.shift(rememberedId),
    queryFn: ({ signal }) => readShift(rememberedId, { signal }),
    enabled: isIdentifier(rememberedId),
    staleTime: 5_000,
  });

  const shift: ShiftView | null =
    shiftQuery.data !== undefined && shiftQuery.data.status !== 'closed' ? shiftQuery.data : null;

  const currency: CurrencyCode = asCurrency(shift?.currency ?? 'INR');
  const denominations: readonly Denomination[] = useMemo(
    () => defaultInrDenominations((minor) => formatFaceValue(minor, currency)),
    [currency],
  );

  const declaredFloat = sheetTotal(denominations, floatCounts, currency);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: keys.cash() });
  };

  const open = useMutation({
    mutationFn: () =>
      openShift({
        counterId: counterId.trim(),
        denominations: toDenominationLines(denominations, floatCounts, currency),
        floatSource: 'main_cash',
      }),
    onSuccess: (opened) => {
      setShiftId(opened.id);
      setFloatCounts({});
      invalidate();
      publish({
        title: 'Shift open',
        description: `Float ${parseMoney(opened.openingFloat, asCurrency(opened.currency)).format()} declared.`,
        severity: 'success',
      });
    },
  });

  const shortcuts: readonly Shortcut[] = useMemo(
    () => [
      {
        key: 'c',
        ctrl: true,
        shift: true,
        label: 'Start the close',
        keys: ['Ctrl', 'Shift', 'C'],
        enabled: canClose,
        run: () => {
          setClosing(true);
        },
      },
      { key: 'r', label: 'Refresh', keys: ['R'], run: invalidate },
    ],
    [canClose],
  );
  useShortcuts(shortcuts);

  const loading = (canList && listQuery.isPending) || (isIdentifier(rememberedId) && shiftQuery.isPending);
  const error = listQuery.error ?? null;

  return (
    <section className="flex flex-col gap-4" data-testid="cash-counter">
      <PageHeader
        eyebrow="Front office"
        title="Cash counter"
        description="One drawer, one cashier, one shift. Every figure here is counted in whole paise; nothing is rounded and nothing is a floating-point number."
        primaryAction={
          shift !== null && canClose ? (
            <Button
              variant="primary"
              data-testid="start-close"
              onClick={() => {
                setClosing(true);
              }}
            >
              Close the shift
            </Button>
          ) : undefined
        }
        meta={
          shift === null ? null : (
            <>
              <Badge tone="success">Shift open</Badge>
              <Badge tone="neutral">{shift.businessDate}</Badge>
              <Badge tone="info">
                Expected {parseMoney(shift.expectedCash, asCurrency(shift.currency)).format()}
              </Badge>
            </>
          )
        }
      />

      {error !== null ? <ProblemCard error={error} onRetry={invalidate} /> : null}

      {loading ? (
        <SkeletonList label="Finding your shift" rows={4} />
      ) : shift === null ? (
        <section
          data-testid="open-shift-panel"
          aria-label="Open a shift"
          className="flex flex-col gap-4 rounded-lg border border-strong bg-layer-1 p-4"
        >
          <h2 className="text-lg font-semibold text-fg-default">Open a shift</h2>
          {canOpen ? (
            <>
              <ContextField
                label="Counter"
                testId="cash-counter-id"
                hint="The drawer you are sitting at. You must be assigned to it — a supervisor can open somebody else's, with a reason."
                value={counterId}
                onChange={setCounterId}
              />
              <p className="text-sm text-fg-muted">
                Count the opening float into the sheet below. It is the figure every later variance is
                measured against, so it is counted rather than typed as a total.
              </p>
              <DenominationSheet
                currency={currency}
                denominations={denominations}
                counts={floatCounts}
                onCountsChange={setFloatCounts}
                // The float has no independent "expected" figure — it *is* the
                // count. Passing the running total keeps the sheet's variance
                // machinery quiet instead of reporting the whole float as a surplus.
                expected={declaredFloat}
                labels={FLOAT_SHEET_LABELS}
                disabled={open.isPending || !isIdentifier(counterId)}
                onSubmit={() => {
                  open.mutate();
                }}
              />
              {open.error === null ? null : <ProblemCard error={open.error} />}
            </>
          ) : (
            <EmptyState
              cause="You are not able to open a cash drawer."
              nextAction="Opening a shift belongs to cashiers and billing staff. If you are covering a counter today, ask the branch administrator to assign you to it."
            />
          )}
        </section>
      ) : (
        <>
          <ShiftSummary shift={shift} />

          {canCollect ? (
            <CollectPaymentPanel shift={shift} onCollected={invalidate} />
          ) : (
            <EmptyState
              cause="This drawer is open but you cannot take money on it."
              nextAction="Collecting a payment needs receipt.collect, which is held by cashiers and billing staff."
            />
          )}

          <MoneyOutPanel shift={shift} onChanged={invalidate} />

          {closing && canClose ? <CloseShiftPanel shift={shift} onChanged={invalidate} /> : null}
        </>
      )}

      <ShortcutBar shortcuts={shortcuts} label="Cash counter shortcuts" />
    </section>
  );
}

/** The running drawer, by tender mode — NC-001 §8 "Shift dashboard (my shift)". */
function ShiftSummary({ shift }: { readonly shift: ShiftView }): React.JSX.Element {
  const currency = asCurrency(shift.currency);
  return (
    <section
      data-testid="shift-summary"
      aria-label="This shift"
      className="rounded-lg border border-strong bg-layer-1 p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold text-fg-default">This shift</h2>
        <p className="text-sm text-fg-muted">
          Opened {formatStamp(shift.openedAt)} · {shift.receiptsCount} receipts · {shift.refundsCount} refunds
          · {shift.voidsCount} voids
        </p>
      </div>

      {shift.pendingConfirmations > 0 ? (
        <p
          role="status"
          className="mt-2 rounded-md border border-warning-border bg-warning-surface p-2 text-sm text-warning-on-surface"
        >
          {shift.pendingConfirmations} digital tender(s) are still waiting on the gateway. The shift cannot
          close until every one of them is resolved.
        </p>
      ) : null}

      {shift.totals.length === 0 ? (
        <p className="mt-2 text-sm text-fg-muted">
          Nothing has been collected on this shift yet. The opening float is{' '}
          {parseMoney(shift.openingFloat, currency).format()}.
        </p>
      ) : (
        <Table scrollRegionLabel="Collections by mode" className="mt-3">
          <TableHeader>
            <TableRow>
              <TableHead>Mode</TableHead>
              <TableHead className="text-end">Collected</TableHead>
              <TableHead className="text-end">Refunded</TableHead>
              <TableHead className="text-end">Voided</TableHead>
              <TableHead className="text-end">Receipts</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shift.totals.map((total) => (
              <TableRow key={total.mode} data-testid={`total-${total.mode}`}>
                <TableCell>{PAYMENT_MODE_LABELS[total.mode] ?? total.mode}</TableCell>
                <TableCell className="text-end font-mono tabular-nums">
                  {parseMoney(total.collections, currency).format()}
                </TableCell>
                <TableCell className="text-end font-mono tabular-nums">
                  {parseMoney(total.refunds, currency).format()}
                </TableCell>
                <TableCell className="text-end font-mono tabular-nums">
                  {parseMoney(total.voids, currency).format()}
                </TableCell>
                <TableCell className="text-end tabular-nums">{total.count}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
