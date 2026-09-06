'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { formatInstant, formatMoney, humanise } from '@/features/pharmacy/lib/format';
import { listPayments, listReconExceptions, resolveReconException } from '../api/client';
import { rcmKeys } from '../api/keys';
import type { PayPaymentView, PayReconExceptionView } from '../api/types';

/**
 * EN-010 — payments and reconciliation.
 *
 * ── The screen leads with disagreement, not with success ────────────────────
 *
 * A list of successful payments is a report nobody reads. What finance needs
 * every morning is the set of cases where the gateway, the receipt book and the
 * settlement file do not agree — money captured with no receipt, a receipt with
 * no payment, an amount that differs by a rupee, a settlement that never came.
 * Each of those has a different owner and a different fix, which is why the
 * exception type is an enum and not free text.
 *
 * ── "Unapplied" is money the hospital is holding ────────────────────────────
 *
 * It is the most important row on this screen and the easiest to mistake for an
 * error. A payment that matched no intent still happened — the patient paid.
 * Until somebody attaches it to a bill the hospital is holding money it cannot
 * account for, so it gets a sentence rather than a status chip.
 *
 * ── Nothing here confirms a payment ─────────────────────────────────────────
 *
 * There is deliberately no "mark as paid" control. OP-005 §5: confirmation
 * comes from the provider's webhook, never from a person or a browser. A button
 * that credited a payment on somebody's say-so would be the one hole in the
 * whole path.
 */
export function PaymentsScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = rcmKeys(hospitalId);
  const { publish } = useToast();

  const [tab, setTab] = useState<'exceptions' | 'payments'>('exceptions');
  const [openId, setOpenId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const canResolve = granted.has('pay.recon.resolve');
  const canSeePayments = granted.has('pay.payment.list');

  const exceptions = useQuery({
    queryKey: keys.reconExceptions('open'),
    queryFn: ({ signal }) => listReconExceptions({ status: 'open' }, { signal }),
    enabled: tab === 'exceptions',
  });

  const payments = useQuery({
    queryKey: keys.payments(),
    queryFn: ({ signal }) => listPayments({ signal }),
    enabled: tab === 'payments' && canSeePayments,
  });

  const resolve = useMutation({
    mutationFn: (id: string) => resolveReconException(id, { reason }),
    onSuccess: () => {
      void exceptions.refetch();
      setOpenId(null);
      setReason('');
      publish({ title: 'Exception closed', severity: 'success' });
    },
  });

  const exRows = exceptions.data?.items ?? [];
  const payRows = payments.data?.items ?? [];

  return (
    <section className="flex flex-col gap-4" data-testid="payments-screen">
      <PageHeader
        eyebrow="EN-010 · payments"
        title="Payments & reconciliation"
        description="What the gateway says, what the receipt book says, and what the settlement file says — and every case where those three disagree."
      />

      <nav aria-label="Payment views" className="flex flex-wrap gap-1 border-b border-default">
        {(
          [
            { key: 'exceptions', label: 'Needs attention' },
            { key: 'payments', label: 'Captured payments' },
          ] as const
        ).map((entry) => (
          <button
            key={entry.key}
            type="button"
            data-testid={`payments-tab-${entry.key}`}
            aria-current={tab === entry.key ? 'page' : undefined}
            onClick={() => {
              setTab(entry.key);
            }}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === entry.key
                ? 'border-accent-border text-fg-default'
                : 'border-transparent text-fg-muted hover:text-fg-default'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {tab === 'exceptions' ? (
        <AsyncPanel
          loading={exceptions.isPending}
          error={exceptions.error}
          isEmpty={exRows.length === 0}
          skeletonLabel="Loading reconciliation exceptions"
          skeletonRows={6}
          onRetry={() => {
            void exceptions.refetch();
          }}
          empty={
            <EmptyState
              cause="The gateway, the receipts and the settlements all agree."
              nextAction="Nothing needs a decision. This is the answer you want here."
            />
          }
        >
          <div className="flex flex-col gap-3">
            <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
              <table className="w-full text-sm" data-testid="recon-list">
                <caption className="sr-only">Reconciliation exceptions awaiting a decision</caption>
                <thead>
                  <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                    <th scope="col" className="px-3 py-2 text-start">
                      What disagrees
                    </th>
                    <th scope="col" className="px-3 py-2 text-end">
                      Amount
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Seen
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {exRows.map((row: PayReconExceptionView) => (
                    <tr key={row.id} className="border-b border-default last:border-0">
                      <td className="px-3 py-2">
                        <Badge tone={row.exceptionType === 'unapplied' ? 'warning' : 'neutral'}>
                          {humanise(row.exceptionType)}
                        </Badge>
                        {row.notes === null ? null : (
                          <p className="mt-1 text-2xs text-fg-muted">{row.notes}</p>
                        )}
                      </td>
                      <td className="px-3 py-2 text-end font-mono">
                        {row.amount === null ? '—' : formatMoney(row.amount)}
                      </td>
                      <td className="px-3 py-2 text-2xs">{formatInstant(row.createdAt)}</td>
                      <td className="px-3 py-2">
                        {canResolve ? (
                          <Button
                            variant="ghost"
                            data-testid={`open-exception-${row.id}`}
                            onClick={() => {
                              setOpenId(row.id === openId ? null : row.id);
                              setReason('');
                            }}
                          >
                            {row.id === openId ? 'Close' : 'Resolve'}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-2xs text-fg-subtle">
              An <strong>unapplied</strong> row is money the hospital is holding that no bill claims. The
              patient paid; the reference did not survive. Until it is attached to a bill it is a liability,
              not revenue.
            </p>

            {resolve.error === null ? null : <ProblemCard error={resolve.error} />}

            {openId === null ? null : (
              <div className="flex flex-wrap items-end gap-3 rounded-lg border border-strong bg-layer-1 p-4">
                <div className="flex min-w-72 flex-1 flex-col gap-1">
                  <Label htmlFor="recon-reason">What was decided, and why?</Label>
                  <Input
                    id="recon-reason"
                    data-testid="recon-reason"
                    value={reason}
                    autoComplete="off"
                    onChange={(event) => {
                      setReason(event.target.value);
                    }}
                  />
                </div>
                <Button
                  data-testid="resolve-exception"
                  disabled={reason.trim() === '' || resolve.isPending}
                  onClick={() => {
                    resolve.mutate(openId);
                  }}
                >
                  Close this exception
                </Button>
              </div>
            )}
          </div>
        </AsyncPanel>
      ) : null}

      {tab === 'payments' && !canSeePayments ? (
        <EmptyState
          cause="You cannot read captured payments."
          nextAction="pay.payment.list is held by the billing desk and finance."
        />
      ) : null}

      {tab === 'payments' && canSeePayments ? (
        <AsyncPanel
          loading={payments.isPending}
          error={payments.error}
          isEmpty={payRows.length === 0}
          skeletonLabel="Loading captured payments"
          skeletonRows={8}
          onRetry={() => {
            void payments.refetch();
          }}
          empty={
            <EmptyState
              cause="No payments have been captured."
              nextAction="A payment appears here only when the provider's webhook confirms it — never when a browser claims it did."
            />
          }
        >
          <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
            <table className="w-full text-sm" data-testid="payment-list">
              <caption className="sr-only">Captured payments</caption>
              <thead>
                <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  <th scope="col" className="px-3 py-2 text-start">
                    Provider reference
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    Method
                  </th>
                  <th scope="col" className="px-3 py-2 text-end">
                    Amount
                  </th>
                  <th scope="col" className="px-3 py-2 text-end">
                    Fee
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    Captured
                  </th>
                </tr>
              </thead>
              <tbody>
                {payRows.map((row: PayPaymentView) => (
                  <tr key={row.id} className="border-b border-default last:border-0">
                    <td className="px-3 py-2 font-mono text-2xs">{row.providerPaymentId}</td>
                    <td className="px-3 py-2">{humanise(row.method)}</td>
                    <td className="px-3 py-2 text-end font-mono">{formatMoney(row.amount)}</td>
                    <td className="px-3 py-2 text-end font-mono text-fg-muted">{formatMoney(row.fee)}</td>
                    <td className="px-3 py-2">
                      <Badge tone={row.status === 'captured' ? 'success' : 'neutral'}>
                        {humanise(row.status)}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-2xs">
                      {row.capturedAt === null ? '—' : formatInstant(row.capturedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AsyncPanel>
      ) : null}
    </section>
  );
}
