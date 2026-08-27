'use client';

import { useMutation } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, Textarea, useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { StorePicker } from '@/features/inventory/components/store-picker';
import { useCursorList } from '@/features/inventory/lib/cursor-list';
import { useSession } from '@/lib/session-context';
import { completeDayClose, listDayCloses } from '../api/client';
import { pharmacyKeys } from '../api/keys';
import type { DayCloseView } from '../api/types';
import { formatDate, formatInstant, formatMoney, humanise } from '../lib/format';

/**
 * OP-003 §3.7 — the pharmacy day close.
 *
 * ── The refusal this screen exists to render ────────────────────────────────
 *
 * `pharmacy.enforce_day_close_preconditions` refuses a close while a
 * controlled-drug variance on that business date is unresolved — `phase-04` exit
 * gate 4's "a deliberate mismatch raises an alert and cannot be silently
 * adjusted". This screen does **not** try to predict that refusal: the database
 * is the thing that knows, and a client that guessed would eventually block a
 * close that was fine or, far worse, offer one that was not. It sends the close
 * and renders the `ProblemDetails` unchanged, which carries the reason and the
 * next action.
 *
 * ── Why the counted cash is entered before the variance is shown ────────────
 *
 * Because a cashier who can see the expected figure counts to it. The system
 * total is on the screen *after* the close is filed, in the row's variance
 * column, and not before.
 */
export function DayCloseScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = pharmacyKeys(hospitalId);
  const { publish } = useToast();

  const [storeId, setStoreId] = useState('');
  const [businessDate, setBusinessDate] = useState(new Date().toISOString().slice(0, 10));
  const [shiftLabel, setShiftLabel] = useState('');
  const [cashCounted, setCashCounted] = useState('');
  const [notes, setNotes] = useState('');

  const canClose = granted.has('pharmacy.day_close.complete');

  const closes = useCursorList<DayCloseView>({
    queryKey: keys.dayCloses(storeId, 'paged'),
    fetchPage: (cursor, signal) =>
      listDayCloses({ pharmacyStoreId: storeId, cursor }, signal === undefined ? {} : { signal }),
    enabled: storeId !== '',
  });

  const close = useMutation({
    mutationFn: () =>
      completeDayClose({
        pharmacyStoreId: storeId,
        businessDate,
        ...(shiftLabel.trim() === '' ? {} : { shiftLabel: shiftLabel.trim() }),
        cashCounted: Number(cashCounted === '' ? '0' : cashCounted),
        ...(notes.trim() === '' ? {} : { notes: notes.trim() }),
      }),
    onSuccess: (result) => {
      setCashCounted('');
      setNotes('');
      closes.refetch();
      publish({
        title: `${formatDate(result.businessDate)} closed`,
        description:
          Number(result.cashVariance) === 0
            ? 'Cash counted matches the till. Stock exceptions, if any, are listed on the row.'
            : `Cash variance of ${result.cashVariance}. It is recorded on the close, not written off.`,
        severity: Number(result.cashVariance) === 0 ? 'success' : 'warning',
      });
    },
  });

  return (
    <section className="flex flex-col gap-4" data-testid="day-close-screen">
      <PageHeader
        eyebrow="OP-003 · end of day"
        title="Day close"
        description="Cash, credit and stock reconciled for one business date at one counter. A date with an unresolved controlled-drug variance cannot be closed — the database refuses it, and the reason comes back with the refusal."
        actions={<StorePicker storeType="pharmacy" value={storeId} onChange={setStoreId} label="Counter" />}
      />

      {storeId === '' ? (
        <EmptyState
          cause="No counter chosen yet."
          nextAction="A day close belongs to one counter and one business date. Choose the counter you are closing."
        />
      ) : (
        <>
          {canClose ? (
            <section
              className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
              data-testid="day-close-form"
            >
              <h2 className="text-md font-medium text-fg-default">Close a business date</h2>
              <p className="text-sm text-fg-muted">
                Count the till and enter what is actually there. The expected figure is deliberately not on
                this form — a cashier who can see it counts to it.
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="close-date">Business date</Label>
                  <Input
                    id="close-date"
                    data-testid="close-date"
                    type="date"
                    value={businessDate}
                    onChange={(event) => {
                      setBusinessDate(event.target.value);
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="close-shift">Shift (optional)</Label>
                  <Input
                    id="close-shift"
                    data-testid="close-shift"
                    value={shiftLabel}
                    placeholder="e.g. 14:00–22:00"
                    onChange={(event) => {
                      setShiftLabel(event.target.value);
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="close-cash">Cash counted</Label>
                  <Input
                    id="close-cash"
                    data-testid="close-cash"
                    inputMode="decimal"
                    value={cashCounted}
                    onChange={(event) => {
                      setCashCounted(event.target.value);
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1 sm:col-span-3">
                  <Label htmlFor="close-notes">Notes</Label>
                  <Textarea
                    id="close-notes"
                    data-testid="close-notes"
                    rows={2}
                    value={notes}
                    onChange={(event) => {
                      setNotes(event.target.value);
                    }}
                  />
                </div>
              </div>
              <Button
                variant="primary"
                className="self-start"
                data-testid="confirm-day-close"
                disabled={close.isPending || businessDate === ''}
                onClick={() => {
                  close.mutate();
                }}
              >
                {close.isPending ? 'Closing…' : 'Close this date'}
              </Button>
              {close.error === null ? null : <ProblemCard error={close.error} />}
            </section>
          ) : (
            <p className="text-sm text-fg-muted">
              Closing a date needs <span className="font-mono">pharmacy.day_close.complete</span>. You can
              read the closes that have been filed.
            </p>
          )}

          <AsyncPanel
            loading={closes.isPending}
            error={closes.error}
            isEmpty={closes.items.length === 0}
            skeletonLabel="Loading the day closes"
            skeletonRows={5}
            onRetry={closes.refetch}
            empty={
              <EmptyState
                cause="This counter has never been closed."
                nextAction="Close today's date once the till has been counted. Until a date is closed, its cash and stock are unreconciled."
              />
            }
          >
            <ul className="flex flex-col gap-3" data-testid="day-close-list">
              {closes.items.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-col gap-2 rounded-lg border border-strong bg-layer-1 p-4"
                  data-testid={`day-close-${row.businessDate}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-md text-fg-default">{formatDate(row.businessDate)}</span>
                    {row.shiftLabel === null ? null : <Badge tone="neutral">{row.shiftLabel}</Badge>}
                    <Badge tone={row.status === 'closed' ? 'success' : 'warning'}>
                      {humanise(row.status)}
                    </Badge>
                    <Badge tone={row.narcoticChecksDone ? 'success' : 'danger'}>
                      {row.narcoticChecksDone
                        ? 'Controlled-drug checks done'
                        : 'Controlled-drug checks outstanding'}
                    </Badge>
                    {Number(row.cashVariance) === 0 ? (
                      <Badge tone="success">Cash balances</Badge>
                    ) : (
                      <Badge tone="danger">Cash variance {formatMoney(row.cashVariance)}</Badge>
                    )}
                  </div>
                  <dl className="grid grid-cols-2 gap-2 text-2xs text-fg-muted sm:grid-cols-4">
                    <div>
                      <dt className="text-fg-subtle">Dispenses</dt>
                      <dd className="font-mono">{row.dispenseCount}</dd>
                    </div>
                    <div>
                      <dt className="text-fg-subtle">Gross sales</dt>
                      <dd className="font-mono">{formatMoney(row.grossSales)}</dd>
                    </div>
                    <div>
                      <dt className="text-fg-subtle">Returns</dt>
                      <dd className="font-mono">{formatMoney(row.returnsValue)}</dd>
                    </div>
                    <div>
                      <dt className="text-fg-subtle">Cash / card / UPI / credit</dt>
                      <dd className="font-mono">
                        {formatMoney(row.cashCollected)} · {formatMoney(row.cardCollected)} ·{' '}
                        {formatMoney(row.upiCollected)} · {formatMoney(row.creditValue)}
                      </dd>
                    </div>
                  </dl>
                  {row.stockExceptions.length === 0 ? (
                    <p className="text-2xs text-success-fg">No stock exceptions on this date.</p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {row.stockExceptions.map((exception) => (
                        <li key={`${exception.kind}-${exception.detail}`} className="text-sm text-warning-fg">
                          {humanise(exception.kind)} — {exception.detail} ({exception.count})
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-2xs text-fg-subtle">
                    Closed {formatInstant(row.closedAt)} · counted {formatMoney(row.cashCounted)}
                  </p>
                </li>
              ))}
            </ul>
            {closes.hasMore ? (
              <Button variant="secondary" size="sm" onClick={closes.loadMore} disabled={closes.isFetching}>
                {closes.isFetching ? 'Loading the next page…' : 'Load the next page'}
              </Button>
            ) : null}
          </AsyncPanel>
        </>
      )}
    </section>
  );
}
