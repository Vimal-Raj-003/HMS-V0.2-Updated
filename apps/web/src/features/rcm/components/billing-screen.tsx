'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { formatInstant, formatMoney, humanise } from '@/features/pharmacy/lib/format';
import { decideDiscount, finalizeBill, getBill, listBills, requestDiscount } from '../api/client';
import { rcmKeys } from '../api/keys';
import type { BillItemView, BillSummaryView } from '../api/types';

/**
 * OP-005 — the billing desk.
 *
 * ── The screen is built around what stops a bill, not around data entry ─────
 *
 * Charges arrive from the clinical modules; nobody types them here. What a
 * biller actually does is find the thing preventing collection — an unpriced
 * line, a discount awaiting somebody else, a bill nobody finalised — and clear
 * it. So the list leads with status and balance, and the detail leads with the
 * held lines rather than burying them at the bottom of a table of twenty.
 *
 * ── An unpriced line is shown as a blocker, in words ────────────────────────
 *
 * A line with `priceStatus: 'missing'` shows ₹0.00 in every naive rendering,
 * which is indistinguishable from a free service. It gets a warning chip and a
 * sentence instead, because that ₹0 is the difference between a service given
 * away and a service the tariff desk has not priced yet — and `finalize`
 * refuses while one is present, so the biller needs to know why.
 *
 * ── Request and approve are never both on screen ────────────────────────────
 *
 * They are two permissions with a `block` segregation rule, so almost nobody
 * holds both. Rendering both buttons would imply a single workflow one person
 * walks through, which is exactly what OP-005 §5's "requester ≠ approver"
 * forbids. The one you cannot press is absent, and a sentence says who holds it.
 */
export function BillingScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = rcmKeys(hospitalId);
  const { publish } = useToast();

  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [discountPct, setDiscountPct] = useState('');
  const [reasonCode, setReasonCode] = useState('FINANCIAL_HARDSHIP');

  const canFinalize = granted.has('bill.finalize');
  const canRequestDiscount = granted.has('bill.discount.request');
  const canApproveDiscount = granted.has('bill.discount.approve');

  const bills = useQuery({
    queryKey: keys.bills('all', status === '' ? 'all' : status),
    queryFn: ({ signal }) => listBills(status === '' ? {} : { status }, { signal }),
  });

  const detail = useQuery({
    queryKey: keys.bill(openId ?? 'none'),
    queryFn: ({ signal }) =>
      openId === null ? Promise.reject(new Error('no bill')) : getBill(openId, { signal }),
    enabled: openId !== null,
  });

  const finalize = useMutation({
    mutationFn: (id: string) => finalizeBill(id, { reason }),
    onSuccess: () => {
      void detail.refetch();
      void bills.refetch();
      setReason('');
      publish({
        title: 'Bill finalised',
        description: 'Its amounts are now fixed and a GST document has been issued.',
        severity: 'success',
      });
    },
  });

  const askDiscount = useMutation({
    mutationFn: (id: string) =>
      requestDiscount(id, {
        pct: Number(discountPct),
        reasonCode,
        reason,
      }),
    onSuccess: () => {
      void detail.refetch();
      setDiscountPct('');
      setReason('');
      publish({ title: 'Discount requested', severity: 'success' });
    },
  });

  const decide = useMutation({
    mutationFn: (input: { readonly id: string; readonly decision: 'approved' | 'rejected' }) =>
      decideDiscount(input.id, { decision: input.decision, reason }),
    onSuccess: () => {
      void detail.refetch();
      void bills.refetch();
      setReason('');
      publish({ title: 'Discount decided', severity: 'success' });
    },
  });

  const rows = bills.data?.items ?? [];
  const bill = detail.data ?? null;
  const heldLines = bill?.items.filter((i: BillItemView) => i.priceStatus === 'missing') ?? [];

  return (
    <section className="flex flex-col gap-4" data-testid="billing-screen">
      <PageHeader
        eyebrow="OP-005 · billing"
        title="Billing"
        description="Charges from every clinical module, priced by the tariff, taxed correctly and collectable once. A line with no rate holds the bill rather than billing at zero."
        actions={
          <div className="flex min-w-56 flex-col gap-1">
            <Label htmlFor="bill-status">Status</Label>
            <select
              id="bill-status"
              data-testid="bill-status"
              className="h-9 rounded-md border border-control bg-layer-1 px-2 text-sm"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
              }}
            >
              <option value="">Every status</option>
              <option value="draft">Draft</option>
              <option value="open">Open</option>
              <option value="finalized">Finalised</option>
              <option value="paid">Paid</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
        }
      />

      <AsyncPanel
        loading={bills.isPending}
        error={bills.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading bills"
        skeletonRows={8}
        onRetry={() => {
          void bills.refetch();
        }}
        empty={
          <EmptyState
            cause="No bills match this filter."
            nextAction="A bill is opened when a visit starts accruing charges. Widen the status filter."
          />
        }
      >
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm" data-testid="bill-list">
            <caption className="sr-only">Bills</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                <th scope="col" className="px-3 py-2 text-start">
                  Bill
                </th>
                <th scope="col" className="px-3 py-2 text-start">
                  Patient
                </th>
                <th scope="col" className="px-3 py-2 text-start">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 text-end">
                  Net
                </th>
                <th scope="col" className="px-3 py-2 text-end">
                  Balance
                </th>
                <th scope="col" className="px-3 py-2 text-start">
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row: BillSummaryView) => (
                <tr key={row.id} className="border-b border-default last:border-0">
                  <td className="px-3 py-2 font-mono text-2xs">{row.billNo}</td>
                  <td className="px-3 py-2">
                    {row.patientName === '' ? (
                      <span className="text-fg-muted">Registered at another branch</span>
                    ) : (
                      <>
                        {row.patientName}
                        <span className="ms-2 font-mono text-2xs text-fg-subtle">{row.uhid}</span>
                      </>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={row.status === 'finalized' || row.status === 'paid' ? 'success' : 'neutral'}>
                      {humanise(row.status)}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-end font-mono">{formatMoney(row.netAmount)}</td>
                  <td className="px-3 py-2 text-end font-mono">{formatMoney(row.balanceAmount)}</td>
                  <td className="px-3 py-2">
                    <Button
                      variant="ghost"
                      data-testid={`open-bill-${row.billNo}`}
                      onClick={() => {
                        setOpenId(row.id === openId ? null : row.id);
                        setReason('');
                      }}
                    >
                      {row.id === openId ? 'Close' : 'Open'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      {openId === null || bill === null ? null : (
        <div
          className="flex flex-col gap-4 rounded-lg border border-strong bg-layer-1 p-4"
          data-testid="bill-detail"
        >
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-md">{bill.billNo}</span>
            <Badge tone={bill.status === 'finalized' ? 'success' : 'neutral'}>{humanise(bill.status)}</Badge>
            <span className="text-2xs text-fg-subtle">opened {formatInstant(bill.createdAt)}</span>
          </div>

          {heldLines.length === 0 ? null : (
            <div
              className="rounded-md border border-warning-border bg-warning-surface p-3"
              data-testid="held-lines"
            >
              <p className="text-sm font-semibold text-warning-on-surface">
                {heldLines.length} line{heldLines.length === 1 ? '' : 's'} held: no tariff rate
              </p>
              <p className="text-sm text-warning-on-surface">
                These services were delivered and could not be priced. They show ₹0.00 because nothing was
                billed — not because they are free. The bill cannot be finalised until the tariff desk prices
                them or they are cancelled.
              </p>
            </div>
          )}

          <div className="overflow-x-auto rounded-lg border border-default">
            <table className="w-full text-sm" data-testid="bill-lines">
              <caption className="sr-only">Lines on this bill</caption>
              <thead>
                <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  <th scope="col" className="px-3 py-2 text-start">
                    Line
                  </th>
                  <th scope="col" className="px-3 py-2 text-end">
                    Gross
                  </th>
                  <th scope="col" className="px-3 py-2 text-end">
                    Discount
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    Tax
                  </th>
                  <th scope="col" className="px-3 py-2 text-end">
                    Net
                  </th>
                </tr>
              </thead>
              <tbody>
                {bill.items.map((i: BillItemView) => (
                  <tr key={i.id} className="border-b border-default last:border-0">
                    <td className="px-3 py-2">
                      {i.description}
                      {i.priceStatus === 'missing' ? (
                        <Badge tone="warning" className="ms-2">
                          no rate — held
                        </Badge>
                      ) : null}
                      {i.priceStatus === 'manual' ? (
                        <Badge tone="neutral" className="ms-2">
                          manual price
                        </Badge>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-end font-mono">{formatMoney(i.gross)}</td>
                    <td className="px-3 py-2 text-end font-mono">
                      {i.discountAmount === '0.00' ? '—' : formatMoney(i.discountAmount)}
                    </td>
                    <td className="px-3 py-2 text-2xs">
                      {i.isExempt ? (
                        <span className="text-fg-muted">exempt</span>
                      ) : (
                        <span>
                          GST {i.gstRate}% — CGST {formatMoney(i.cgst)} + SGST {formatMoney(i.sgst)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-end font-mono">{formatMoney(i.net)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-strong text-sm">
                  <td className="px-3 py-2 font-semibold">Total</td>
                  <td className="px-3 py-2 text-end font-mono">{formatMoney(bill.grossAmount)}</td>
                  <td className="px-3 py-2 text-end font-mono">{formatMoney(bill.discountAmount)}</td>
                  <td className="px-3 py-2 text-2xs text-fg-muted">round-off {formatMoney(bill.roundOff)}</td>
                  <td className="px-3 py-2 text-end font-mono font-semibold">
                    {formatMoney(bill.netAmount)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {bill.invoices.length === 0 ? null : (
            <div className="flex flex-wrap gap-2" data-testid="bill-invoices">
              {bill.invoices.map((inv) => (
                <Badge key={inv.id} tone={inv.docType === 'credit_note' ? 'warning' : 'success'}>
                  {humanise(inv.docType)} {inv.invoiceNo}
                </Badge>
              ))}
            </div>
          )}

          {bill.discountRequests.length === 0 ? null : (
            <div className="flex flex-col gap-2" data-testid="bill-discounts">
              <h3 className="text-sm font-semibold">Discounts</h3>
              {bill.discountRequests.map((d) => (
                <div key={d.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone={d.status === 'approved' ? 'success' : 'neutral'}>{humanise(d.status)}</Badge>
                  <span>
                    {d.pct === null ? formatMoney(d.amount ?? '0') : `${d.pct}%`} — {humanise(d.reasonCode)}
                  </span>
                  {d.status === 'pending' && canApproveDiscount ? (
                    <>
                      <Button
                        data-testid={`approve-discount-${d.id}`}
                        disabled={reason.trim() === '' || decide.isPending}
                        onClick={() => {
                          decide.mutate({ id: d.id, decision: 'approved' });
                        }}
                      >
                        Approve
                      </Button>
                      <Button
                        variant="danger"
                        data-testid={`reject-discount-${d.id}`}
                        disabled={reason.trim() === '' || decide.isPending}
                        onClick={() => {
                          decide.mutate({ id: d.id, decision: 'rejected' });
                        }}
                      >
                        Refuse
                      </Button>
                    </>
                  ) : null}
                  {d.status === 'pending' && !canApproveDiscount ? (
                    <span className="text-2xs text-fg-subtle">
                      waiting for somebody who holds <code>bill.discount.approve</code>
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          {finalize.error === null ? null : <ProblemCard error={finalize.error} />}
          {askDiscount.error === null ? null : <ProblemCard error={askDiscount.error} />}
          {decide.error === null ? null : <ProblemCard error={decide.error} />}

          {bill.status === 'draft' || bill.status === 'open' ? (
            <div className="flex flex-col gap-3 border-t border-default pt-3">
              <div className="flex min-w-72 flex-col gap-1">
                <Label htmlFor="bill-reason">Reason</Label>
                <Input
                  id="bill-reason"
                  data-testid="bill-reason"
                  value={reason}
                  autoComplete="off"
                  onChange={(event) => {
                    setReason(event.target.value);
                  }}
                />
              </div>
              <div className="flex flex-wrap items-end gap-3">
                {canRequestDiscount ? (
                  <>
                    <div className="flex w-28 flex-col gap-1">
                      <Label htmlFor="discount-pct">Discount %</Label>
                      <Input
                        id="discount-pct"
                        data-testid="discount-pct"
                        value={discountPct}
                        autoComplete="off"
                        onChange={(event) => {
                          setDiscountPct(event.target.value);
                        }}
                      />
                    </div>
                    <div className="flex min-w-56 flex-col gap-1">
                      <Label htmlFor="discount-reason-code">Reason code</Label>
                      <select
                        id="discount-reason-code"
                        data-testid="discount-reason-code"
                        className="h-9 rounded-md border border-control bg-layer-1 px-2 text-sm"
                        value={reasonCode}
                        onChange={(event) => {
                          setReasonCode(event.target.value);
                        }}
                      >
                        <option value="FINANCIAL_HARDSHIP">Financial hardship</option>
                        <option value="STAFF_CONCESSION">Staff concession</option>
                        <option value="CAMP">Camp / outreach</option>
                        <option value="GOODWILL">Goodwill</option>
                        <option value="SERVICE_RECOVERY">Service recovery</option>
                      </select>
                    </div>
                    <Button
                      variant="secondary"
                      data-testid="request-discount"
                      disabled={discountPct.trim() === '' || reason.trim() === '' || askDiscount.isPending}
                      onClick={() => {
                        askDiscount.mutate(bill.id);
                      }}
                    >
                      Ask for a discount
                    </Button>
                  </>
                ) : null}
                {canFinalize ? (
                  <Button
                    data-testid="finalize-bill"
                    disabled={reason.trim() === '' || finalize.isPending || heldLines.length > 0}
                    onClick={() => {
                      finalize.mutate(bill.id);
                    }}
                  >
                    Finalise and invoice
                  </Button>
                ) : null}
              </div>
              {heldLines.length > 0 && canFinalize ? (
                <p className="text-2xs text-fg-subtle">
                  Finalising is blocked while a line has no rate. That is deliberate: a bill finalised with an
                  unpriced line bills the patient nothing for a service the hospital delivered.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-fg-muted">
              This bill is {humanise(bill.status).toLowerCase()}. Its amounts are fixed — corrections are made
              by credit note, never by editing (OP-005 §5).
            </p>
          )}
        </div>
      )}
    </section>
  );
}
