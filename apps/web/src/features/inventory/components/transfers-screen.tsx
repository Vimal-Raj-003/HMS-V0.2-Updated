'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import {
  approveTransfer,
  createTransfer,
  dispatchTransfer,
  getTransfer,
  listTransfers,
  receiveTransfer,
} from '../api/client';
import { inventoryKeys } from '../api/keys';
import type { DocumentView } from '../api/types';
import { useCursorList } from '../lib/cursor-list';
import { TRANSFER_STAGES, isInTransit, transferStage } from '../lib/documents';
import { DocumentLinesTable, DocumentSummary } from './document-panel';
import { StorePicker } from './store-picker';
import { formatQty, humanise } from '@/features/pharmacy/lib/format';

/**
 * NC-006 §3.6 — inter-store transfers, and the state most inventory systems get
 * wrong.
 *
 * ── In transit belongs to nobody ────────────────────────────────────────────
 *
 * Between dispatch and receipt the stock is on neither shelf. A screen that
 * showed it as still in the sending store would let somebody pick it twice; one
 * that showed it as already received would let the receiving store issue what it
 * has not got. So the stage rail is four states and `in_transit` is drawn as its
 * own place rather than as "nearly received", and the receiving form asks what
 * *arrived* rather than confirming what was sent — a short delivery is recorded
 * as a short delivery, with its reason, not silently rounded up.
 */
export function TransfersScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = inventoryKeys(hospitalId);
  const { publish } = useToast();

  const [openId, setOpenId] = useState<string | null>(null);
  const [raising, setRaising] = useState(false);
  const [fromStoreId, setFromStoreId] = useState('');
  const [toStoreId, setToStoreId] = useState('');
  const [itemId, setItemId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [gatePassNo, setGatePassNo] = useState('');
  const [received, setReceived] = useState<Record<string, string>>({});
  const [discrepancy, setDiscrepancy] = useState<Record<string, string>>({});

  const canCreate = granted.has('inventory.transfer.create');
  const canApprove = granted.has('inventory.transfer.approve');
  const canDispatch = granted.has('inventory.transfer.dispatch');
  const canReceive = granted.has('inventory.transfer.receive');

  const transfers = useCursorList<DocumentView>({
    queryKey: keys.transfers('all', 'paged'),
    fetchPage: (cursor, signal) => listTransfers({ cursor }, signal === undefined ? {} : { signal }),
  });

  const opened = useQuery({
    queryKey: keys.transfer(openId ?? 'none'),
    queryFn: ({ signal }) =>
      openId === null ? Promise.reject(new Error('no transfer')) : getTransfer(openId, { signal }),
    enabled: openId !== null,
  });

  const create = useMutation({
    mutationFn: () =>
      createTransfer({
        fromStoreId,
        toStoreId,
        lines: [{ itemId: itemId.trim(), qtyEntered: Number(quantity) }],
      }),
    onSuccess: (created) => {
      setRaising(false);
      setItemId('');
      setQuantity('');
      transfers.refetch();
      setOpenId(created.id);
    },
  });

  const approve = useMutation({
    mutationFn: (id: string) => approveTransfer(id),
    onSuccess: () => {
      void opened.refetch();
      transfers.refetch();
    },
  });

  const dispatch = useMutation({
    mutationFn: (id: string) =>
      dispatchTransfer(id, gatePassNo.trim() === '' ? {} : { gatePassNo: gatePassNo.trim() }),
    onSuccess: () => {
      setGatePassNo('');
      void opened.refetch();
      transfers.refetch();
      publish({
        title: 'Dispatched',
        description:
          'The stock has left the sending store and belongs to neither shelf until it is received.',
        severity: 'warning',
      });
    },
  });

  const receive = useMutation({
    mutationFn: (document: DocumentView) =>
      receiveTransfer(document.id, {
        lines: document.lines.map((line) => {
          const reason = (discrepancy[line.id] ?? '').trim();
          return {
            lineId: line.id,
            qtyReceivedEntered: Number(received[line.id] ?? line.qtyEntered),
            ...(reason === '' ? {} : { discrepancyReason: reason }),
          };
        }),
      }),
    onSuccess: () => {
      setReceived({});
      setDiscrepancy({});
      void opened.refetch();
      transfers.refetch();
      publish({
        title: 'Received',
        description: 'The stock is now on the receiving shelf.',
        severity: 'success',
      });
    },
  });

  const document = opened.data ?? null;
  const stage = document === null ? 0 : transferStage(document.status);

  return (
    <section className="flex flex-col gap-4" data-testid="transfers-screen">
      <PageHeader
        eyebrow="NC-006 · movements"
        title="Transfers"
        description="Stock moving between stores. Between dispatch and receipt it is on neither shelf — which is the state that stops it being picked twice."
        primaryAction={
          canCreate ? (
            <Button
              variant="primary"
              data-testid="open-raise-transfer"
              onClick={() => {
                setRaising(true);
              }}
            >
              Raise a transfer
            </Button>
          ) : undefined
        }
      />

      {raising ? (
        <section
          className="flex flex-wrap items-end gap-3 rounded-lg border border-strong bg-layer-1 p-4"
          data-testid="raise-transfer"
        >
          <StorePicker value={fromStoreId} onChange={setFromStoreId} label="From" />
          <StorePicker value={toStoreId} onChange={setToStoreId} label="To" />
          <div className="flex min-w-56 flex-col gap-1">
            <Label htmlFor="transfer-item">Item id</Label>
            <Input
              id="transfer-item"
              data-testid="transfer-item"
              value={itemId}
              onChange={(event) => {
                setItemId(event.target.value);
              }}
            />
          </div>
          <div className="flex w-28 flex-col gap-1">
            <Label htmlFor="transfer-qty">Quantity</Label>
            <Input
              id="transfer-qty"
              data-testid="transfer-qty"
              inputMode="decimal"
              value={quantity}
              onChange={(event) => {
                setQuantity(event.target.value);
              }}
            />
          </div>
          <Button
            variant="primary"
            data-testid="confirm-raise-transfer"
            disabled={
              fromStoreId === '' ||
              toStoreId === '' ||
              fromStoreId === toStoreId ||
              itemId.trim() === '' ||
              Number(quantity) <= 0 ||
              create.isPending
            }
            onClick={() => {
              create.mutate();
            }}
          >
            {create.isPending ? 'Raising…' : 'Raise'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setRaising(false);
            }}
          >
            Cancel
          </Button>
          {create.error === null ? null : <ProblemCard error={create.error} />}
        </section>
      ) : null}

      <AsyncPanel
        loading={transfers.isPending}
        error={transfers.error}
        isEmpty={transfers.items.length === 0}
        skeletonLabel="Loading transfers"
        skeletonRows={6}
        onRetry={transfers.refetch}
        empty={
          <EmptyState
            cause="No stock has been transferred between stores."
            nextAction="Raise one when a store is holding something another needs — it is the alternative to a purchase."
          />
        }
      >
        <ul className="flex flex-col gap-2" data-testid="transfer-list">
          {transfers.items.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                data-testid={`transfer-${row.documentNo}`}
                aria-current={openId === row.id}
                onClick={() => {
                  setOpenId(row.id);
                }}
                className={`flex w-full flex-col gap-1 rounded-md border p-3 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                  openId === row.id ? 'border-focus bg-layer-3' : 'border-default bg-layer-2 hover:bg-layer-3'
                }`}
              >
                <DocumentSummary document={row} />
                {isInTransit(row.status) ? <Badge tone="warning">In transit — on neither shelf</Badge> : null}
              </button>
            </li>
          ))}
        </ul>
        {transfers.hasMore ? (
          <Button variant="secondary" size="sm" onClick={transfers.loadMore} disabled={transfers.isFetching}>
            {transfers.isFetching ? 'Loading the next page…' : 'Load the next page'}
          </Button>
        ) : null}
      </AsyncPanel>

      {openId === null ? (
        <EmptyState
          cause="No transfer opened."
          nextAction="Open one above to approve it, dispatch it, or record what actually arrived."
        />
      ) : (
        <AsyncPanel
          loading={opened.isPending}
          error={opened.error}
          isEmpty={document === null}
          skeletonLabel="Loading the transfer"
          skeletonRows={5}
          onRetry={() => void opened.refetch()}
          empty={
            <EmptyState
              cause="That transfer could not be read."
              nextAction="It may belong to another branch. Try one from the list above."
            />
          }
        >
          {document === null ? null : (
            <section
              className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
              data-testid="transfer-detail"
            >
              <DocumentSummary document={document} />

              <ol className="flex flex-wrap gap-2" data-testid="transfer-stages">
                {TRANSFER_STAGES.map((label, index) => (
                  <li key={label} className="flex items-center gap-2">
                    <Badge
                      tone={
                        index < stage
                          ? 'success'
                          : index === stage
                            ? index === 2
                              ? 'warning'
                              : 'accent'
                            : 'neutral'
                      }
                    >
                      {index + 1}. {humanise(label)}
                    </Badge>
                  </li>
                ))}
              </ol>
              {isInTransit(document.status) ? (
                <p className="rounded-md border border-warning-border bg-warning-surface p-2 text-sm text-warning-on-surface">
                  This stock has left the sending store and has not been received. Neither store may issue it,
                  and it is not counted on either shelf.
                </p>
              ) : null}

              <DocumentLinesTable
                document={document}
                caption={`Lines on transfer ${document.documentNo}`}
                extras={[
                  { header: 'Received', keys: ['qtyReceivedBase', 'qty_received_base'], numeric: true },
                ]}
              />

              <div className="flex flex-wrap gap-2">
                {document.status === 'draft' && canApprove ? (
                  <Button
                    variant="primary"
                    data-testid="approve-transfer"
                    disabled={approve.isPending}
                    onClick={() => {
                      approve.mutate(document.id);
                    }}
                  >
                    {approve.isPending ? 'Approving…' : 'Approve'}
                  </Button>
                ) : null}
                {document.status === 'approved' && canDispatch ? (
                  <>
                    <div className="flex min-w-48 flex-col gap-1">
                      <Label htmlFor="gate-pass">Gate pass number</Label>
                      <Input
                        id="gate-pass"
                        data-testid="gate-pass"
                        value={gatePassNo}
                        onChange={(event) => {
                          setGatePassNo(event.target.value);
                        }}
                      />
                    </div>
                    <Button
                      variant="primary"
                      data-testid="dispatch-transfer"
                      disabled={dispatch.isPending}
                      onClick={() => {
                        dispatch.mutate(document.id);
                      }}
                    >
                      {dispatch.isPending ? 'Dispatching…' : 'Dispatch'}
                    </Button>
                  </>
                ) : null}
              </div>
              {approve.error === null ? null : <ProblemCard error={approve.error} />}
              {dispatch.error === null ? null : <ProblemCard error={dispatch.error} />}

              {isInTransit(document.status) && canReceive ? (
                <div className="flex flex-col gap-3" data-testid="receive-transfer">
                  <h3 className="text-md font-medium text-fg-default">What actually arrived?</h3>
                  <p className="text-sm text-fg-muted">
                    Count it before you sign. A short delivery is recorded as a short delivery with its reason
                    — the difference stays visible rather than being absorbed.
                  </p>
                  <ul className="flex flex-col gap-2">
                    {document.lines.map((line) => (
                      <li key={line.id} className="flex flex-wrap items-end gap-3">
                        <span className="min-w-56 text-sm text-fg-default">
                          {line.itemName}
                          <span className="ms-2 font-mono text-2xs text-fg-subtle">
                            sent {formatQty(line.qtyBase)}
                          </span>
                        </span>
                        <div className="flex w-28 flex-col gap-1">
                          <Label htmlFor={`received-${line.id}`}>Arrived</Label>
                          <Input
                            id={`received-${line.id}`}
                            data-testid={`received-${line.itemCode}`}
                            inputMode="decimal"
                            value={received[line.id] ?? ''}
                            placeholder={line.qtyEntered}
                            onChange={(event) => {
                              setReceived((previous) => ({ ...previous, [line.id]: event.target.value }));
                            }}
                          />
                        </div>
                        <div className="flex min-w-56 flex-col gap-1">
                          <Label htmlFor={`discrepancy-${line.id}`}>If short, why?</Label>
                          <Input
                            id={`discrepancy-${line.id}`}
                            data-testid={`discrepancy-${line.itemCode}`}
                            value={discrepancy[line.id] ?? ''}
                            onChange={(event) => {
                              setDiscrepancy((previous) => ({ ...previous, [line.id]: event.target.value }));
                            }}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                  <Button
                    variant="primary"
                    className="self-start"
                    data-testid="confirm-receive-transfer"
                    disabled={receive.isPending}
                    onClick={() => {
                      receive.mutate(document);
                    }}
                  >
                    {receive.isPending ? 'Receiving…' : 'Confirm what arrived'}
                  </Button>
                  {receive.error === null ? null : <ProblemCard error={receive.error} />}
                </div>
              ) : null}
            </section>
          )}
        </AsyncPanel>
      )}
    </section>
  );
}
