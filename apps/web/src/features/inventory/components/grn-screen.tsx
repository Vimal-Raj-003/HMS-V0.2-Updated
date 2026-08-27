'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, Textarea, useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { createGrn, getGrn, listGrns, postGrn, qcGrn } from '../api/client';
import { inventoryKeys } from '../api/keys';
import type { DocumentView, GrnLineInput } from '../api/types';
import { useCursorList } from '../lib/cursor-list';
import { DocumentLinesTable, DocumentSummary } from './document-panel';
import { StorePicker } from './store-picker';
import { daysUntil, expiryBand, EXPIRY_BAND_LABEL, EXPIRY_BAND_TONE } from '@/features/pharmacy/lib/format';

/**
 * NC-005 — goods receipt, and the one moment batch and expiry are cheap to get
 * right.
 *
 * ── Why the batch and expiry fields are not optional-looking ────────────────
 *
 * They are captured at the door, from the strip in the box, by the person
 * holding it. Every later question — FEFO at the counter, the expiry board, a
 * recall trace, the write-off value — is answered from this one keystroke. A
 * batch number guessed a week later from a delivery challan is a batch number
 * that will not match the pack in a patient's hand.
 *
 * So the form marks a missing expiry on a batch-tracked item in red *before*
 * posting, shows the expiry band as it is typed (an expiry already in the past
 * is a rejection, not a receipt), and keeps the rejected quantity as its own
 * field with a coded reason — because "we received 90 of 100" and "we received
 * 100 and 10 were smashed" are different facts and only one of them is a short
 * supply.
 *
 * ── Posting is separate from receiving ──────────────────────────────────────
 *
 * `POST /grns/{id}/post` is what turns an accepted quantity into stock and
 * creates its batches, and it carries its own permission. Receiving at the gate
 * and putting into stock are different acts by different people, and the API
 * models them that way.
 */
interface GrnLineDraft {
  readonly itemId: string;
  readonly qtyEntered: string;
  readonly qtyRejectedEntered: string;
  readonly rejectReason: string;
  readonly batchNo: string;
  readonly expiryDate: string;
  readonly mrp: string;
  readonly unitCost: string;
  readonly gstRate: string;
}

const EMPTY_LINE: GrnLineDraft = {
  itemId: '',
  qtyEntered: '',
  qtyRejectedEntered: '',
  rejectReason: '',
  batchNo: '',
  expiryDate: '',
  mrp: '',
  unitCost: '',
  gstRate: '',
};

const REJECT_REASONS: readonly string[] = [
  'damaged',
  'short_supply',
  'near_expiry',
  'wrong_item',
  'quality_fail',
  'excess',
  'no_coa',
  'temperature_breach',
  'other',
];

export function GrnScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = inventoryKeys(hospitalId);
  const { publish } = useToast();

  const [storeId, setStoreId] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [poId, setPoId] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [remarks, setRemarks] = useState('');
  const [line, setLine] = useState<GrnLineDraft>(EMPTY_LINE);
  const [openId, setOpenId] = useState<string | null>(null);

  const canCreate = granted.has('inventory.grn.create');
  const canQc = granted.has('inventory.grn.qc');
  const canPost = granted.has('inventory.grn.post');
  const now = new Date();

  const grns = useCursorList<DocumentView>({
    queryKey: keys.grns(storeId, 'all', 'paged'),
    fetchPage: (cursor, signal) =>
      listGrns(
        { storeId: storeId === '' ? undefined : storeId, cursor },
        signal === undefined ? {} : { signal },
      ),
  });

  const opened = useQuery({
    queryKey: keys.grn(openId ?? 'none'),
    queryFn: ({ signal }) =>
      openId === null ? Promise.reject(new Error('no grn')) : getGrn(openId, { signal }),
    enabled: openId !== null,
  });

  const create = useMutation({
    mutationFn: () => {
      const grnLine: GrnLineInput = {
        itemId: line.itemId.trim(),
        qtyEntered: Number(line.qtyEntered),
        unitCost: Number(line.unitCost),
        ...(Number(line.qtyRejectedEntered) > 0
          ? { qtyRejectedEntered: Number(line.qtyRejectedEntered), rejectReason: line.rejectReason }
          : {}),
        ...(line.batchNo.trim() === '' ? {} : { batchNo: line.batchNo.trim() }),
        ...(line.expiryDate === '' ? {} : { expiryDate: line.expiryDate }),
        ...(line.mrp === '' ? {} : { mrp: Number(line.mrp) }),
        ...(line.gstRate === '' ? {} : { gstRate: Number(line.gstRate) }),
      };
      return createGrn({
        vendorId: vendorId.trim(),
        storeId,
        ...(poId.trim() === '' ? { withoutPo: true } : { poId: poId.trim() }),
        ...(invoiceNo.trim() === '' ? {} : { invoiceNo: invoiceNo.trim() }),
        ...(remarks.trim() === '' ? {} : { remarks: remarks.trim() }),
        lines: [grnLine],
      });
    },
    onSuccess: (created) => {
      setLine(EMPTY_LINE);
      grns.refetch();
      setOpenId(created.id);
      publish({
        title: `Receipt ${created.documentNo} recorded`,
        description:
          'Nothing is stock yet. Quality-check it, then post it — posting is what creates the batches.',
        severity: 'success',
      });
    },
  });

  const qc = useMutation({
    mutationFn: (input: {
      readonly id: string;
      readonly outcome: 'accepted' | 'partially_accepted' | 'rejected';
    }) => qcGrn(input.id, { outcome: input.outcome }),
    onSuccess: () => {
      void opened.refetch();
      grns.refetch();
    },
  });

  const post = useMutation({
    mutationFn: (id: string) => postGrn(id),
    onSuccess: () => {
      void opened.refetch();
      grns.refetch();
      publish({
        title: 'Posted into stock',
        description:
          'The accepted quantity is on the shelf and its batches exist. The ledger has the movement.',
        severity: 'success',
      });
    },
  });

  const document = opened.data ?? null;
  const expiryDays = daysUntil(line.expiryDate === '' ? null : line.expiryDate, now);
  const band = expiryBand(expiryDays);
  const expiryIsPast = expiryDays !== null && expiryDays < 0;
  const missingExpiry = line.batchNo.trim() !== '' && line.expiryDate === '';

  return (
    <section className="flex flex-col gap-4" data-testid="grn-screen">
      <PageHeader
        eyebrow="NC-005 · goods receipt"
        title="Goods receipt"
        description="Batch, expiry and MRP are captured at the door, from the strip in the box. Every later question — FEFO, the expiry board, a recall trace — is answered from this keystroke."
        actions={<StorePicker value={storeId} onChange={setStoreId} label="Receiving store" />}
      />

      {canCreate && storeId !== '' ? (
        <section
          className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
          data-testid="create-grn"
        >
          <h2 className="text-md font-medium text-fg-default">Record a receipt</h2>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="grn-vendor">Vendor id</Label>
              <Input
                id="grn-vendor"
                data-testid="grn-vendor"
                value={vendorId}
                onChange={(event) => {
                  setVendorId(event.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="grn-po">Purchase order id (blank = receipt without an order)</Label>
              <Input
                id="grn-po"
                data-testid="grn-po"
                value={poId}
                onChange={(event) => {
                  setPoId(event.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="grn-invoice">Vendor invoice number</Label>
              <Input
                id="grn-invoice"
                data-testid="grn-invoice"
                value={invoiceNo}
                onChange={(event) => {
                  setInvoiceNo(event.target.value);
                }}
              />
            </div>
          </div>

          <h3 className="font-display text-2xs uppercase tracking-[0.08em] text-fg-subtle">The line</h3>
          <div className="grid gap-3 md:grid-cols-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="grn-item">Item id</Label>
              <Input
                id="grn-item"
                data-testid="grn-item"
                value={line.itemId}
                onChange={(event) => {
                  setLine({ ...line, itemId: event.target.value });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="grn-qty">Quantity received</Label>
              <Input
                id="grn-qty"
                data-testid="grn-qty"
                inputMode="decimal"
                value={line.qtyEntered}
                onChange={(event) => {
                  setLine({ ...line, qtyEntered: event.target.value });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="grn-batch">Batch number</Label>
              <Input
                id="grn-batch"
                data-testid="grn-batch"
                value={line.batchNo}
                onChange={(event) => {
                  setLine({ ...line, batchNo: event.target.value });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="grn-expiry">Expiry date</Label>
              <Input
                id="grn-expiry"
                data-testid="grn-expiry"
                type="date"
                value={line.expiryDate}
                onChange={(event) => {
                  setLine({ ...line, expiryDate: event.target.value });
                }}
              />
              {line.expiryDate === '' ? null : (
                <span className={`text-2xs ${EXPIRY_BAND_TONE[band]}`} data-testid="grn-expiry-band">
                  {EXPIRY_BAND_LABEL[band]}
                </span>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="grn-cost">Unit cost</Label>
              <Input
                id="grn-cost"
                data-testid="grn-cost"
                inputMode="decimal"
                value={line.unitCost}
                onChange={(event) => {
                  setLine({ ...line, unitCost: event.target.value });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="grn-mrp">MRP</Label>
              <Input
                id="grn-mrp"
                data-testid="grn-mrp"
                inputMode="decimal"
                value={line.mrp}
                onChange={(event) => {
                  setLine({ ...line, mrp: event.target.value });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="grn-gst">GST %</Label>
              <Input
                id="grn-gst"
                data-testid="grn-gst"
                inputMode="decimal"
                value={line.gstRate}
                onChange={(event) => {
                  setLine({ ...line, gstRate: event.target.value });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="grn-rejected">Quantity rejected</Label>
              <Input
                id="grn-rejected"
                data-testid="grn-rejected"
                inputMode="decimal"
                value={line.qtyRejectedEntered}
                onChange={(event) => {
                  setLine({ ...line, qtyRejectedEntered: event.target.value });
                }}
              />
            </div>
            {Number(line.qtyRejectedEntered) > 0 ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor="grn-reject-reason">Why rejected?</Label>
                <select
                  id="grn-reject-reason"
                  data-testid="grn-reject-reason"
                  className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                  value={line.rejectReason}
                  onChange={(event) => {
                    setLine({ ...line, rejectReason: event.target.value });
                  }}
                >
                  <option value="">Choose a reason</option>
                  {REJECT_REASONS.map((reason) => (
                    <option key={reason} value={reason}>
                      {reason.replace(/_/gu, ' ')}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="grn-remarks">Remarks</Label>
            <Textarea
              id="grn-remarks"
              data-testid="grn-remarks"
              rows={1}
              value={remarks}
              onChange={(event) => {
                setRemarks(event.target.value);
              }}
            />
          </div>

          {missingExpiry ? (
            <p role="alert" className="text-sm text-danger-fg" data-testid="missing-expiry">
              This line has a batch number and no expiry date. Every later FEFO decision, expiry write-off and
              recall trace is answered from that date — read it off the strip now, not from a challan next
              week.
            </p>
          ) : null}
          {expiryIsPast ? (
            <p role="alert" className="text-sm text-danger-fg" data-testid="expired-on-arrival">
              This batch is already expired. It is a rejection, not a receipt — record the quantity as
              rejected with reason &ldquo;near expiry&rdquo; and raise a purchase return.
            </p>
          ) : null}

          <Button
            variant="primary"
            className="self-start"
            data-testid="confirm-create-grn"
            disabled={
              vendorId.trim() === '' ||
              line.itemId.trim() === '' ||
              Number(line.qtyEntered) <= 0 ||
              line.unitCost === '' ||
              (Number(line.qtyRejectedEntered) > 0 && line.rejectReason === '') ||
              create.isPending
            }
            onClick={() => {
              create.mutate();
            }}
          >
            {create.isPending ? 'Recording…' : 'Record the receipt'}
          </Button>
          {create.error === null ? null : <ProblemCard error={create.error} />}
        </section>
      ) : null}

      <AsyncPanel
        loading={grns.isPending}
        error={grns.error}
        isEmpty={grns.items.length === 0}
        skeletonLabel="Loading goods receipts"
        skeletonRows={6}
        onRetry={grns.refetch}
        empty={
          <EmptyState
            cause="Nothing has been received into this store."
            nextAction="A receipt is the first ledger entry most items ever get. Record one when a delivery arrives."
          />
        }
      >
        <ul className="flex flex-col gap-2" data-testid="grn-list">
          {grns.items.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                data-testid={`grn-${row.documentNo}`}
                aria-current={openId === row.id}
                onClick={() => {
                  setOpenId(row.id);
                }}
                className={`flex w-full flex-col gap-1 rounded-md border p-3 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                  openId === row.id ? 'border-focus bg-layer-3' : 'border-default bg-layer-2 hover:bg-layer-3'
                }`}
              >
                <DocumentSummary document={row} />
              </button>
            </li>
          ))}
        </ul>
        {grns.hasMore ? (
          <Button variant="secondary" size="sm" onClick={grns.loadMore} disabled={grns.isFetching}>
            {grns.isFetching ? 'Loading the next page…' : 'Load the next page'}
          </Button>
        ) : null}
      </AsyncPanel>

      {document === null ? (
        <EmptyState
          cause="No receipt opened."
          nextAction="Open one above to quality-check it, or to post it into stock."
        />
      ) : (
        <section
          className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
          data-testid="grn-detail"
        >
          <DocumentSummary document={document} />
          <DocumentLinesTable
            document={document}
            caption={`Lines on goods receipt ${document.documentNo}`}
            extras={[
              { header: 'Accepted', keys: ['qtyAcceptedBase', 'qty_accepted_base'], numeric: true },
              { header: 'Rejected', keys: ['qtyRejectedBase', 'qty_rejected_base'], numeric: true },
              { header: 'Reject reason', keys: ['rejectReason', 'reject_reason'] },
              { header: 'Unit cost', keys: ['unitCost', 'unit_cost'] },
            ]}
          />
          <div className="flex flex-wrap gap-2">
            {canQc ? (
              <>
                {(['accepted', 'partially_accepted', 'rejected'] as const).map((outcome) => (
                  <Button
                    key={outcome}
                    variant="secondary"
                    size="sm"
                    data-testid={`qc-${outcome}`}
                    disabled={qc.isPending}
                    onClick={() => {
                      qc.mutate({ id: document.id, outcome });
                    }}
                  >
                    QC: {outcome.replace(/_/gu, ' ')}
                  </Button>
                ))}
              </>
            ) : null}
            {canPost ? (
              <Button
                variant="primary"
                data-testid="post-grn"
                disabled={post.isPending}
                onClick={() => {
                  post.mutate(document.id);
                }}
              >
                {post.isPending ? 'Posting…' : 'Post into stock'}
              </Button>
            ) : (
              <p className="text-sm text-fg-muted">
                Posting a receipt into stock needs <span className="font-mono">inventory.grn.post</span> —
                receiving at the gate and putting into stock are different acts by different people.
              </p>
            )}
          </div>
          <Badge tone="neutral">
            {document.counterpartyId === null ? 'No vendor' : `Vendor ${document.counterpartyId.slice(-6)}`}
          </Badge>
          {qc.error === null ? null : <ProblemCard error={qc.error} />}
          {post.error === null ? null : <ProblemCard error={post.error} />}
        </section>
      )}
    </section>
  );
}
