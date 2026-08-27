'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  useToast,
} from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import {
  approvePurchaseIndent,
  approvePurchaseOrder,
  createPurchaseIndent,
  getComparative,
  getPurchaseOrder,
  listPurchaseIndents,
  listPurchaseOrders,
  listRfqs,
  sendPurchaseOrder,
} from '../api/client';
import { inventoryKeys } from '../api/keys';
import type { DocumentView } from '../api/types';
import { useCursorList } from '../lib/cursor-list';
import { DocumentLinesTable, DocumentSummary } from './document-panel';
import { StorePicker } from './store-picker';
import { formatMoney, formatQty, humanise } from '@/features/pharmacy/lib/format';

/**
 * NC-005 — purchase indent → RFQ → comparative → purchase order.
 *
 * ── The comparative compares landed cost, not headline price ────────────────
 *
 * `GET /rfqs/{id}/comparative` returns `landedUnitCostBase` — the price per
 * **base unit** after discount, tax and freight — precisely so that a quote in
 * boxes of 100 and a quote in strips of 10 can be put next to each other. The
 * screen leads with that column and shows the headline rate beside it, because
 * the headline rate is the number that wins arguments and loses money.
 *
 * L1 is marked but never pre-selected. The cheapest quote is not always the one
 * that gets chosen — a vendor's lead time, a drug licence about to expire, a
 * shelf-life requirement — and a screen that pre-ticked it would make every
 * other choice look like an exception that needs defending.
 *
 * ── Maker ≠ checker on the order ────────────────────────────────────────────
 *
 * `docs/04 §3` requires it and the service enforces it: the person who raised a
 * purchase order may not approve it. The button is shown and the refusal
 * arrives with its reason rather than the control being invisible.
 */
export function PurchaseScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = inventoryKeys(hospitalId);
  const { publish } = useToast();

  const [storeId, setStoreId] = useState('');
  const [openPoId, setOpenPoId] = useState<string | null>(null);
  const [rfqId, setRfqId] = useState<string | null>(null);
  const [itemId, setItemId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [urgency, setUrgency] = useState<'routine' | 'urgent' | 'emergency'>('routine');
  const [justification, setJustification] = useState('');

  const canIndent = granted.has('inventory.indent.create');
  const canApproveIndent = granted.has('inventory.indent.approve');
  const canApprovePo = granted.has('inventory.po.approve');
  const canSendPo = granted.has('inventory.po.send');
  const canCompare = granted.has('inventory.comparative.compare');
  const canSeeRfqs = granted.has('inventory.rfq.list');

  const indents = useCursorList<DocumentView>({
    queryKey: keys.purchaseIndents(storeId, 'all', 'paged'),
    fetchPage: (cursor, signal) =>
      listPurchaseIndents(
        { storeId: storeId === '' ? undefined : storeId, cursor },
        signal === undefined ? {} : { signal },
      ),
  });

  const rfqs = useCursorList<DocumentView>({
    queryKey: keys.rfqs('all', 'paged'),
    fetchPage: (cursor, signal) => listRfqs({ cursor }, signal === undefined ? {} : { signal }),
    enabled: canSeeRfqs,
  });

  const orders = useCursorList<DocumentView>({
    queryKey: keys.pos('all', 'all', 'paged'),
    fetchPage: (cursor, signal) => listPurchaseOrders({ cursor }, signal === undefined ? {} : { signal }),
  });

  const openedPo = useQuery({
    queryKey: keys.po(openPoId ?? 'none'),
    queryFn: ({ signal }) =>
      openPoId === null ? Promise.reject(new Error('no order')) : getPurchaseOrder(openPoId, { signal }),
    enabled: openPoId !== null,
  });

  const comparative = useQuery({
    queryKey: keys.comparative(rfqId ?? 'none'),
    queryFn: ({ signal }) =>
      rfqId === null ? Promise.reject(new Error('no rfq')) : getComparative(rfqId, { signal }),
    enabled: rfqId !== null && canCompare,
  });

  const raiseIndent = useMutation({
    mutationFn: () =>
      createPurchaseIndent({
        storeId,
        urgency,
        ...(justification.trim() === '' ? {} : { justification: justification.trim() }),
        lines: [{ itemId: itemId.trim(), qtyEntered: Number(quantity) }],
      }),
    onSuccess: (created) => {
      setItemId('');
      setQuantity('');
      indents.refetch();
      publish({ title: `Purchase indent ${created.documentNo} raised`, severity: 'success' });
    },
  });

  const approveIndent = useMutation({
    mutationFn: (document: DocumentView) =>
      approvePurchaseIndent(document.id, {
        lines: document.lines.map((line) => ({
          lineId: line.id,
          qtyApprovedEntered: Number(line.qtyEntered),
        })),
      }),
    onSuccess: () => {
      indents.refetch();
    },
  });

  const approvePo = useMutation({
    mutationFn: (id: string) => approvePurchaseOrder(id, undefined),
    onSuccess: () => {
      void openedPo.refetch();
      orders.refetch();
      publish({ title: 'Purchase order approved', severity: 'success' });
    },
  });

  const sendPo = useMutation({
    mutationFn: (id: string) => sendPurchaseOrder(id, 'email'),
    onSuccess: () => {
      void openedPo.refetch();
      orders.refetch();
    },
  });

  const order = openedPo.data ?? null;

  return (
    <section className="flex flex-col gap-4" data-testid="purchase-screen">
      <PageHeader
        eyebrow="NC-005 · purchase to pay"
        title="Purchase orders"
        description="Indent to approved order, through the comparative statement that compares landed cost per base unit rather than headline price."
        actions={<StorePicker value={storeId} onChange={setStoreId} label="Store" />}
      />

      <Tabs defaultValue="indents">
        <TabsList>
          <TabsTrigger value="indents">Indents</TabsTrigger>
          <TabsTrigger value="comparative">RFQ &amp; comparative</TabsTrigger>
          <TabsTrigger value="orders">Orders</TabsTrigger>
        </TabsList>

        <TabsContent value="indents">
          <div className="flex flex-col gap-4">
            {canIndent && storeId !== '' ? (
              <section
                className="flex flex-wrap items-end gap-3 rounded-lg border border-strong bg-layer-1 p-4"
                data-testid="raise-purchase-indent"
              >
                <div className="flex min-w-56 flex-col gap-1">
                  <Label htmlFor="pi-item">Item id</Label>
                  <Input
                    id="pi-item"
                    data-testid="pi-item"
                    value={itemId}
                    onChange={(event) => {
                      setItemId(event.target.value);
                    }}
                  />
                </div>
                <div className="flex w-28 flex-col gap-1">
                  <Label htmlFor="pi-qty">Quantity</Label>
                  <Input
                    id="pi-qty"
                    data-testid="pi-qty"
                    inputMode="decimal"
                    value={quantity}
                    onChange={(event) => {
                      setQuantity(event.target.value);
                    }}
                  />
                </div>
                <div className="flex min-w-40 flex-col gap-1">
                  <Label htmlFor="pi-urgency">Urgency</Label>
                  <select
                    id="pi-urgency"
                    data-testid="pi-urgency"
                    className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    value={urgency}
                    onChange={(event) => {
                      setUrgency(event.target.value as 'routine' | 'urgent' | 'emergency');
                    }}
                  >
                    <option value="routine">Routine</option>
                    <option value="urgent">Urgent</option>
                    <option value="emergency">Emergency</option>
                  </select>
                </div>
                <div className="flex min-w-64 flex-1 flex-col gap-1">
                  <Label htmlFor="pi-justification">Justification</Label>
                  <Textarea
                    id="pi-justification"
                    data-testid="pi-justification"
                    rows={1}
                    value={justification}
                    onChange={(event) => {
                      setJustification(event.target.value);
                    }}
                  />
                </div>
                <Button
                  variant="primary"
                  data-testid="confirm-raise-purchase-indent"
                  disabled={itemId.trim() === '' || Number(quantity) <= 0 || raiseIndent.isPending}
                  onClick={() => {
                    raiseIndent.mutate();
                  }}
                >
                  {raiseIndent.isPending ? 'Raising…' : 'Raise'}
                </Button>
                {raiseIndent.error === null ? null : <ProblemCard error={raiseIndent.error} />}
              </section>
            ) : null}

            <AsyncPanel
              loading={indents.isPending}
              error={indents.error}
              isEmpty={indents.items.length === 0}
              skeletonLabel="Loading purchase indents"
              skeletonRows={6}
              onRetry={indents.refetch}
              empty={
                <EmptyState
                  cause="No purchase indent is open."
                  nextAction="A store raises one when its reorder level is breached, or the nightly auto-reorder job raises it for them."
                />
              }
            >
              <ul className="flex flex-col gap-2" data-testid="purchase-indent-list">
                {indents.items.map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-default bg-layer-2 p-3"
                  >
                    <DocumentSummary document={row} />
                    {canApproveIndent && row.status === 'pending_approval' ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        data-testid={`approve-pi-${row.documentNo}`}
                        disabled={approveIndent.isPending}
                        onClick={() => {
                          approveIndent.mutate(row);
                        }}
                      >
                        Approve as asked
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {indents.hasMore ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={indents.loadMore}
                  disabled={indents.isFetching}
                >
                  {indents.isFetching ? 'Loading the next page…' : 'Load the next page'}
                </Button>
              ) : null}
            </AsyncPanel>
            {approveIndent.error === null ? null : <ProblemCard error={approveIndent.error} />}
          </div>
        </TabsContent>

        <TabsContent value="comparative">
          <div className="flex flex-col gap-4">
            {!canSeeRfqs ? (
              <p className="text-sm text-fg-muted">
                Seeing requests for quotation needs <span className="font-mono">inventory.rfq.list</span>.
              </p>
            ) : (
              <AsyncPanel
                loading={rfqs.isPending}
                error={rfqs.error}
                isEmpty={rfqs.items.length === 0}
                skeletonLabel="Loading requests for quotation"
                skeletonRows={5}
                onRetry={rfqs.refetch}
                empty={
                  <EmptyState
                    cause="No request for quotation has been raised."
                    nextAction="An RFQ is how several vendors are asked the same question at once, which is what makes a comparative statement meaningful."
                  />
                }
              >
                <ul className="flex flex-col gap-2" data-testid="rfq-list">
                  {rfqs.items.map((row) => (
                    <li key={row.id}>
                      <button
                        type="button"
                        data-testid={`rfq-${row.documentNo}`}
                        aria-current={rfqId === row.id}
                        onClick={() => {
                          setRfqId(row.id);
                        }}
                        className={`flex w-full flex-col gap-1 rounded-md border p-3 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                          rfqId === row.id
                            ? 'border-focus bg-layer-3'
                            : 'border-default bg-layer-2 hover:bg-layer-3'
                        }`}
                      >
                        <DocumentSummary document={row} />
                      </button>
                    </li>
                  ))}
                </ul>
                {rfqs.hasMore ? (
                  <Button variant="secondary" size="sm" onClick={rfqs.loadMore} disabled={rfqs.isFetching}>
                    {rfqs.isFetching ? 'Loading the next page…' : 'Load the next page'}
                  </Button>
                ) : null}
              </AsyncPanel>
            )}

            {rfqId === null ? (
              <EmptyState
                cause="No request for quotation opened."
                nextAction="Open one above to see its comparative statement — the quotes side by side at landed cost per base unit."
              />
            ) : !canCompare ? (
              <p className="text-sm text-fg-muted">
                Reading a comparative statement needs{' '}
                <span className="font-mono">inventory.comparative.compare</span>.
              </p>
            ) : (
              <AsyncPanel
                loading={comparative.isPending}
                error={comparative.error}
                isEmpty={(comparative.data?.lines ?? []).length === 0}
                skeletonLabel="Building the comparative statement"
                skeletonRows={5}
                onRetry={() => void comparative.refetch()}
                empty={
                  <EmptyState
                    cause="No vendor has quoted against this request yet."
                    nextAction="A comparative statement needs at least one quotation. Enter the quotes as they arrive."
                  />
                }
              >
                <div className="flex flex-col gap-4" data-testid="comparative">
                  {(comparative.data?.lines ?? []).map((line) => (
                    <section key={line.rfqLineId} className="rounded-lg border border-strong bg-layer-1 p-4">
                      <h3 className="text-md font-medium text-fg-default">
                        {line.itemName}
                        <span className="ms-2 font-mono text-2xs text-fg-subtle">
                          {line.itemCode} · {formatQty(line.qtyBase)} base units
                        </span>
                      </h3>
                      {line.quotes.length === 0 ? (
                        <EmptyState
                          cause="Nobody quoted for this line."
                          nextAction="It cannot be ordered from this request. Ask the vendors again, or split it out."
                        />
                      ) : (
                        <div className="mt-2 overflow-x-auto">
                          <table className="w-full text-sm">
                            <caption className="sr-only">Quotes for {line.itemName}</caption>
                            <thead>
                              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                                <th scope="col" className="px-3 py-2 text-start">
                                  Vendor
                                </th>
                                <th scope="col" className="px-3 py-2 text-start">
                                  Brand
                                </th>
                                <th scope="col" className="px-3 py-2 text-end">
                                  Landed cost / base unit
                                </th>
                                <th scope="col" className="px-3 py-2 text-end">
                                  Headline rate
                                </th>
                                <th scope="col" className="px-3 py-2 text-end">
                                  Discount
                                </th>
                                <th scope="col" className="px-3 py-2 text-end">
                                  GST
                                </th>
                                <th scope="col" className="px-3 py-2 text-end">
                                  Delivery
                                </th>
                                <th scope="col" className="px-3 py-2 text-start">
                                  Flags
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {line.quotes.map((quote) => (
                                <tr
                                  key={quote.quotationLineId}
                                  className="border-b border-default last:border-0"
                                >
                                  <td className="px-3 py-2">{quote.vendorName}</td>
                                  <td className="px-3 py-2">{quote.brand ?? '—'}</td>
                                  <td className="px-3 py-2 text-end font-mono font-medium">
                                    {formatMoney(quote.landedUnitCostBase)}
                                  </td>
                                  <td className="px-3 py-2 text-end font-mono text-fg-muted">
                                    {formatMoney(quote.unitPrice)}
                                  </td>
                                  <td className="px-3 py-2 text-end font-mono text-fg-muted">
                                    {quote.discountPct}%
                                  </td>
                                  <td className="px-3 py-2 text-end font-mono text-fg-muted">
                                    {quote.gstRate}%
                                  </td>
                                  <td className="px-3 py-2 text-end font-mono text-fg-muted">
                                    {quote.deliveryDays === null ? '—' : `${quote.deliveryDays} d`}
                                  </td>
                                  <td className="px-3 py-2">
                                    <span className="flex flex-wrap gap-1">
                                      {quote.isL1 ? <Badge tone="info">L1 — lowest landed cost</Badge> : null}
                                      {quote.selected ? <Badge tone="success">Selected</Badge> : null}
                                      {quote.techScore === null ? null : (
                                        <Badge tone="neutral">Technical {quote.techScore}</Badge>
                                      )}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </section>
                  ))}
                  <p className="text-2xs text-fg-muted">
                    L1 is marked, never pre-selected. The cheapest quote is not always the right one — lead
                    time, a drug licence about to expire and a shelf-life requirement all outrank price — and
                    a screen that pre-ticked it would make every other choice look like an exception.
                  </p>
                </div>
              </AsyncPanel>
            )}
          </div>
        </TabsContent>

        <TabsContent value="orders">
          <div className="flex flex-col gap-4">
            <AsyncPanel
              loading={orders.isPending}
              error={orders.error}
              isEmpty={orders.items.length === 0}
              skeletonLabel="Loading purchase orders"
              skeletonRows={6}
              onRetry={orders.refetch}
              empty={
                <EmptyState
                  cause="No purchase order has been raised."
                  nextAction="An order follows an approved indent and, where the value needs it, an approved comparative statement."
                />
              }
            >
              <ul className="flex flex-col gap-2" data-testid="po-list">
                {orders.items.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      data-testid={`po-${row.documentNo}`}
                      aria-current={openPoId === row.id}
                      onClick={() => {
                        setOpenPoId(row.id);
                      }}
                      className={`flex w-full flex-col gap-1 rounded-md border p-3 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                        openPoId === row.id
                          ? 'border-focus bg-layer-3'
                          : 'border-default bg-layer-2 hover:bg-layer-3'
                      }`}
                    >
                      <DocumentSummary document={row} />
                    </button>
                  </li>
                ))}
              </ul>
              {orders.hasMore ? (
                <Button variant="secondary" size="sm" onClick={orders.loadMore} disabled={orders.isFetching}>
                  {orders.isFetching ? 'Loading the next page…' : 'Load the next page'}
                </Button>
              ) : null}
            </AsyncPanel>

            {order === null ? (
              <EmptyState
                cause="No order opened."
                nextAction="Open one above to see its lines, approve it, or send it to the vendor."
              />
            ) : (
              <section
                className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
                data-testid="po-detail"
              >
                <DocumentSummary document={order} />
                <dl className="grid grid-cols-2 gap-2 text-2xs text-fg-muted sm:grid-cols-4">
                  {Object.entries(order.header).map(([key, value]) => (
                    <div key={key}>
                      <dt className="text-fg-subtle">{humanise(key)}</dt>
                      <dd className="font-mono">{value === null ? '—' : String(value)}</dd>
                    </div>
                  ))}
                </dl>
                <DocumentLinesTable
                  document={order}
                  caption={`Lines on purchase order ${order.documentNo}`}
                  extras={[
                    { header: 'Rate', keys: ['rate', 'unit_cost', 'unitCost'] },
                    { header: 'Received', keys: ['qty_received_base', 'qtyReceivedBase'], numeric: true },
                  ]}
                />
                <div className="flex flex-wrap gap-2">
                  {canApprovePo ? (
                    <Button
                      variant="primary"
                      data-testid="approve-po"
                      disabled={approvePo.isPending}
                      onClick={() => {
                        approvePo.mutate(order.id);
                      }}
                    >
                      {approvePo.isPending ? 'Approving…' : 'Approve'}
                    </Button>
                  ) : (
                    <p className="text-sm text-fg-muted">
                      Approving an order needs <span className="font-mono">inventory.po.approve</span>, and
                      never belongs to the person who raised it.
                    </p>
                  )}
                  {canSendPo ? (
                    <Button
                      variant="secondary"
                      data-testid="send-po"
                      disabled={sendPo.isPending}
                      onClick={() => {
                        sendPo.mutate(order.id);
                      }}
                    >
                      {sendPo.isPending ? 'Sending…' : 'Send to the vendor'}
                    </Button>
                  ) : null}
                </div>
                {approvePo.error === null ? null : <ProblemCard error={approvePo.error} />}
                {sendPo.error === null ? null : <ProblemCard error={sendPo.error} />}
              </section>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </section>
  );
}
