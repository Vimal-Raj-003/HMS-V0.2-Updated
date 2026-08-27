'use client';

import { useMutation } from '@tanstack/react-query';
import { Badge, Button, Checkbox, EmptyState, Label, Textarea, useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { OctagonAlert } from '@/lib/icons';
import { useSession } from '@/lib/session-context';
import { approveInvoice, disputeInvoice, listInvoices } from '../api/client';
import { inventoryKeys } from '../api/keys';
import type { InvoiceMatchView } from '../api/types';
import { useCursorList } from '../lib/cursor-list';
import { invoiceVerdict, matchExceptions } from '../lib/documents';
import { formatMoney, formatQty, humanise } from '@/features/pharmacy/lib/format';

/**
 * NC-005 — the three-way match exception queue, and `phase-04` exit gate 1's
 * final sentence: "a quantity mismatch is caught by the match and queued as an
 * exception".
 *
 * ── What this screen will not let anybody do ────────────────────────────────
 *
 * Pass an unmatched invoice for payment. There is no "approve anyway", no
 * override checkbox and no request shape for one — the two lawful paths are to
 * resolve the difference with the store (which changes the receipt, not the
 * match) or to dispute the invoice with the vendor, and both are offered.
 *
 * That is not a UI opinion: `inventory.invoice.approve` and
 * `inventory.invoice.match` are separate keys precisely so that the person who
 * reconciles a difference is not the person who releases the money.
 *
 * ── Why the exception is spelled out per line ───────────────────────────────
 *
 * "Match failed" is not actionable. "Invoiced 100 against a receipt of 90 — 10
 * more than arrived" tells accounts payable which of the three documents to go
 * and look at, and tells the vendor exactly what to credit.
 */
export function InvoicesScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = inventoryKeys(hospitalId);
  const { publish } = useToast();

  const [exceptionsOnly, setExceptionsOnly] = useState(true);
  const [disputing, setDisputing] = useState<InvoiceMatchView | null>(null);
  const [disputeReason, setDisputeReason] = useState('');

  const canApprove = granted.has('inventory.invoice.approve');
  const canDispute = granted.has('inventory.invoice.match');

  const invoices = useCursorList<InvoiceMatchView>({
    queryKey: keys.invoices('all', exceptionsOnly, 'paged'),
    fetchPage: (cursor, signal) =>
      listInvoices({ exceptionsOnly, cursor }, signal === undefined ? {} : { signal }),
  });

  const approve = useMutation({
    mutationFn: (id: string) => approveInvoice(id, {}),
    onSuccess: () => {
      invoices.refetch();
      publish({ title: 'Passed for payment', severity: 'success' });
    },
  });

  const dispute = useMutation({
    mutationFn: (input: { readonly id: string; readonly reason: string }) =>
      disputeInvoice(input.id, input.reason),
    onSuccess: () => {
      setDisputing(null);
      setDisputeReason('');
      invoices.refetch();
      publish({
        title: 'Disputed',
        description: 'The vendor is told what does not agree and with which document.',
        severity: 'warning',
      });
    },
  });

  return (
    <section className="flex flex-col gap-4" data-testid="invoices-screen">
      <PageHeader
        eyebrow="NC-005 · three-way match"
        title="Three-way match"
        description="Purchase order against goods receipt against vendor invoice. An invoice that does not agree with both cannot be passed for payment — it is resolved with the store, or disputed with the vendor."
        actions={
          <label className="flex items-center gap-2 text-sm text-fg-default">
            <Checkbox
              checked={exceptionsOnly}
              data-testid="exceptions-only"
              onCheckedChange={(value) => {
                setExceptionsOnly(value === true);
              }}
            />
            Exceptions only
          </label>
        }
      />

      <AsyncPanel
        loading={invoices.isPending}
        error={invoices.error}
        isEmpty={invoices.items.length === 0}
        skeletonLabel="Loading the match queue"
        skeletonRows={6}
        onRetry={invoices.refetch}
        empty={
          <EmptyState
            cause={
              exceptionsOnly
                ? 'No invoice is stuck in the match queue.'
                : 'No vendor invoice has been captured.'
            }
            nextAction={
              exceptionsOnly
                ? 'That is the answer you want — every captured invoice agrees with its order and its receipt. Untick "exceptions only" to see the matched ones.'
                : 'Capture an invoice against its goods receipt to start the match.'
            }
          />
        }
      >
        <ul className="flex flex-col gap-3" data-testid="invoice-list">
          {invoices.items.map((invoice) => {
            const verdict = invoiceVerdict(invoice);
            const exceptions = matchExceptions(invoice);
            return (
              <li
                key={invoice.invoiceId}
                className={`flex flex-col gap-3 rounded-lg border p-4 ${
                  verdict.kind === 'held'
                    ? 'border-danger-border bg-danger-surface'
                    : 'border-strong bg-layer-1'
                }`}
                data-testid={`invoice-${invoice.invoiceNo}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-md text-fg-default">{invoice.invoiceNo}</span>
                  <Badge tone={verdict.kind === 'held' ? 'danger' : 'success'}>
                    {humanise(invoice.matchStatus)}
                  </Badge>
                  <span className="font-mono text-2xs text-fg-subtle">
                    {formatMoney(invoice.total)} · {invoice.lines.length} line(s) · vendor{' '}
                    {invoice.vendorId.slice(-6)}
                  </span>
                </div>

                {verdict.kind === 'held' ? (
                  <div role="alert" className="flex flex-col gap-2">
                    <p className="flex items-start gap-2 text-sm font-medium text-danger-on-surface">
                      <OctagonAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      {verdict.message}
                    </p>
                    <ul className="flex flex-col gap-1">
                      {exceptions.map((exception) => (
                        <li
                          key={`${exception.lineId}-${exception.kind}`}
                          className="text-sm text-danger-on-surface"
                        >
                          <span className="font-mono text-2xs">{exception.itemCode}</span> —{' '}
                          {exception.detail}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <caption className="sr-only">Match detail for invoice {invoice.invoiceNo}</caption>
                    <thead>
                      <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                        <th scope="col" className="px-3 py-2 text-start">
                          Item
                        </th>
                        <th scope="col" className="px-3 py-2 text-end">
                          Ordered
                        </th>
                        <th scope="col" className="px-3 py-2 text-end">
                          Received
                        </th>
                        <th scope="col" className="px-3 py-2 text-end">
                          Invoiced
                        </th>
                        <th scope="col" className="px-3 py-2 text-end">
                          Difference
                        </th>
                        <th scope="col" className="px-3 py-2 text-start">
                          Verdict
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoice.lines.map((row) => (
                        <tr key={row.id} className="border-b border-default last:border-0">
                          <td className="px-3 py-2 font-mono text-xs">{row.itemCode}</td>
                          <td className="px-3 py-2 text-end font-mono">{formatQty(row.poQtyBase)}</td>
                          <td className="px-3 py-2 text-end font-mono">{formatQty(row.grnQtyBase)}</td>
                          <td className="px-3 py-2 text-end font-mono">{formatQty(row.invQtyBase)}</td>
                          <td
                            className={`px-3 py-2 text-end font-mono ${
                              Number(row.qtyDiffBase) === 0 ? 'text-fg-muted' : 'text-danger-fg'
                            }`}
                          >
                            {formatQty(row.qtyDiffBase)}
                          </td>
                          <td className="px-3 py-2">
                            <Badge tone={row.withinTolerance ? 'success' : 'danger'}>
                              {row.withinTolerance ? 'Within tolerance' : 'Exception'}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-wrap gap-2">
                  {verdict.kind === 'payable' && canApprove ? (
                    <Button
                      variant="primary"
                      size="sm"
                      data-testid={`approve-invoice-${invoice.invoiceNo}`}
                      disabled={approve.isPending}
                      onClick={() => {
                        approve.mutate(invoice.invoiceId);
                      }}
                    >
                      Pass for payment
                    </Button>
                  ) : null}
                  {verdict.kind === 'held' ? (
                    <>
                      <p className="w-full text-2xs text-danger-on-surface">
                        There is no &ldquo;approve anyway&rdquo;. Either the receipt is wrong and the store
                        corrects it, or the invoice is wrong and the vendor credits it.
                      </p>
                      {canDispute ? (
                        <Button
                          variant="danger"
                          size="sm"
                          data-testid={`dispute-invoice-${invoice.invoiceNo}`}
                          onClick={() => {
                            setDisputing(invoice);
                            setDisputeReason('');
                          }}
                        >
                          Dispute with the vendor
                        </Button>
                      ) : (
                        <p className="text-2xs text-fg-muted">
                          Disputing needs <span className="font-mono">inventory.invoice.match</span>.
                        </p>
                      )}
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {invoices.hasMore ? (
          <Button variant="secondary" size="sm" onClick={invoices.loadMore} disabled={invoices.isFetching}>
            {invoices.isFetching ? 'Loading the next page…' : 'Load the next page'}
          </Button>
        ) : null}
      </AsyncPanel>

      {approve.error === null ? null : <ProblemCard error={approve.error} />}

      {disputing === null ? null : (
        <section
          className="flex flex-col gap-2 rounded-lg border border-strong bg-layer-1 p-4"
          data-testid="dispute-panel"
        >
          <p className="text-md font-medium text-fg-default">Dispute {disputing.invoiceNo}</p>
          <Label htmlFor="dispute-reason">
            What does not agree, and with which document? (at least 8 characters — this reaches the vendor)
          </Label>
          <Textarea
            id="dispute-reason"
            data-testid="dispute-reason"
            rows={2}
            value={disputeReason}
            onChange={(event) => {
              setDisputeReason(event.target.value);
            }}
          />
          <div className="flex gap-2">
            <Button
              variant="danger"
              size="sm"
              data-testid="confirm-dispute"
              disabled={disputeReason.trim().length < 8 || dispute.isPending}
              onClick={() => {
                dispute.mutate({ id: disputing.invoiceId, reason: disputeReason.trim() });
              }}
            >
              {dispute.isPending ? 'Disputing…' : 'Dispute'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDisputing(null);
              }}
            >
              Cancel
            </Button>
          </div>
          {dispute.error === null ? null : <ProblemCard error={dispute.error} />}
        </section>
      )}
    </section>
  );
}
