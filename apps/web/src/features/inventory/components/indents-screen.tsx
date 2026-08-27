'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, Textarea, useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import {
  approveStoreIndent,
  createStoreIndent,
  generatePickList,
  getStoreIndent,
  listStoreIndents,
  rejectStoreIndent,
} from '../api/client';
import { inventoryKeys } from '../api/keys';
import type { DocumentView } from '../api/types';
import { useCursorList } from '../lib/cursor-list';
import { extraText } from '../lib/documents';
import { DocumentLinesTable, DocumentSummary } from './document-panel';
import { StorePicker } from './store-picker';
import { formatQty } from '@/features/pharmacy/lib/format';

/**
 * NC-006 §3.5 — indent → approval → pick list → issue.
 *
 * ── The approved quantity is not the asked quantity ─────────────────────────
 *
 * A ward asks for 100 and the store approves 60, because there are 80 on the
 * shelf and two other wards. That is the normal case, not an exception, so the
 * approval form is a quantity per line rather than a yes/no button — and the
 * asked figure stays visible beside it so the ward can see what happened.
 *
 * ── The pick list is FEFO written down ──────────────────────────────────────
 *
 * `POST /indents/{id}/pick-list` records which batch FEFO chose *before* anybody
 * walks to the shelf, so taking a different one is a documented override rather
 * than an unrecorded decision. That is the same rule the dispensing counter
 * applies, and the two paths deliberately cannot disagree about what an override
 * is.
 */
export function IndentsScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = inventoryKeys(hospitalId);
  const { publish } = useToast();

  const [fromStoreId, setFromStoreId] = useState('');
  const [toStoreId, setToStoreId] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<Record<string, string>>({});
  const [rejectReason, setRejectReason] = useState('');
  const [raising, setRaising] = useState(false);
  const [itemId, setItemId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [justification, setJustification] = useState('');

  const canCreate = granted.has('inventory.store_indent.create');
  const canApprove = granted.has('inventory.store_indent.approve');
  const canPick = granted.has('inventory.issue.pick');

  const indents = useCursorList<DocumentView>({
    queryKey: keys.storeIndents('all', 'paged'),
    fetchPage: (cursor, signal) => listStoreIndents({ cursor }, signal === undefined ? {} : { signal }),
  });

  const opened = useQuery({
    queryKey: keys.storeIndent(openId ?? 'none'),
    queryFn: ({ signal }) =>
      openId === null ? Promise.reject(new Error('no indent')) : getStoreIndent(openId, { signal }),
    enabled: openId !== null,
  });

  const create = useMutation({
    mutationFn: () =>
      createStoreIndent({
        fromStoreId,
        toStoreId,
        indentType: 'regular',
        ...(justification.trim() === '' ? {} : { justification: justification.trim() }),
        lines: [{ itemId: itemId.trim(), qtyEntered: Number(quantity) }],
      }),
    onSuccess: (created) => {
      setRaising(false);
      setItemId('');
      setQuantity('');
      indents.refetch();
      setOpenId(created.id);
      publish({ title: `Indent ${created.documentNo} raised`, severity: 'success' });
    },
  });

  const approve = useMutation({
    mutationFn: (document: DocumentView) =>
      approveStoreIndent(document.id, {
        lines: document.lines.map((line) => ({
          lineId: line.id,
          qtyApprovedEntered: Number(approvals[line.id] ?? line.qtyEntered),
        })),
      }),
    onSuccess: () => {
      void opened.refetch();
      indents.refetch();
      publish({
        title: 'Approved',
        description: 'The approved quantity is what the pick list will be built from.',
        severity: 'success',
      });
    },
  });

  const reject = useMutation({
    mutationFn: (id: string) => rejectStoreIndent(id, rejectReason.trim()),
    onSuccess: () => {
      setRejectReason('');
      void opened.refetch();
      indents.refetch();
    },
  });

  const pick = useMutation({
    mutationFn: (id: string) => generatePickList(id),
    onSuccess: () => {
      void opened.refetch();
      publish({
        title: 'Pick list generated',
        description: 'FEFO has chosen the batches. Taking a different one now needs a reason.',
        severity: 'success',
      });
    },
  });

  const document = opened.data ?? null;

  return (
    <section className="flex flex-col gap-4" data-testid="indents-screen">
      <PageHeader
        eyebrow="NC-006 · movements"
        title="Indents & issues"
        description="A ward asks, the holding store approves a quantity, FEFO proposes the batches, and the receiving end confirms what actually arrived."
        primaryAction={
          canCreate ? (
            <Button
              variant="primary"
              data-testid="open-raise-indent"
              onClick={() => {
                setRaising(true);
              }}
            >
              Raise an indent
            </Button>
          ) : undefined
        }
      />

      {raising ? (
        <section
          className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
          data-testid="raise-indent"
        >
          <h2 className="text-md font-medium text-fg-default">Raise an indent</h2>
          <div className="flex flex-wrap items-end gap-3">
            <StorePicker value={fromStoreId} onChange={setFromStoreId} label="From (holding store)" />
            <StorePicker value={toStoreId} onChange={setToStoreId} label="To (your sub-store)" />
            <div className="flex min-w-56 flex-col gap-1">
              <Label htmlFor="indent-item">Item id</Label>
              <Input
                id="indent-item"
                data-testid="indent-item"
                value={itemId}
                onChange={(event) => {
                  setItemId(event.target.value);
                }}
              />
            </div>
            <div className="flex w-28 flex-col gap-1">
              <Label htmlFor="indent-qty">Quantity</Label>
              <Input
                id="indent-qty"
                data-testid="indent-qty"
                inputMode="decimal"
                value={quantity}
                onChange={(event) => {
                  setQuantity(event.target.value);
                }}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="indent-justification">Why (optional, but read by the approver)</Label>
            <Textarea
              id="indent-justification"
              data-testid="indent-justification"
              rows={2}
              value={justification}
              onChange={(event) => {
                setJustification(event.target.value);
              }}
            />
          </div>
          <div className="flex gap-2">
            <Button
              variant="primary"
              data-testid="confirm-raise-indent"
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
          </div>
          {fromStoreId !== '' && fromStoreId === toStoreId ? (
            <p className="text-sm text-danger-fg">
              A store cannot indent on itself. Choose a different holding store.
            </p>
          ) : null}
          {create.error === null ? null : <ProblemCard error={create.error} />}
        </section>
      ) : null}

      <AsyncPanel
        loading={indents.isPending}
        error={indents.error}
        isEmpty={indents.items.length === 0}
        skeletonLabel="Loading indents"
        skeletonRows={6}
        onRetry={indents.refetch}
        empty={
          <EmptyState
            cause="No store indent has been raised."
            nextAction="A ward or sub-store raises one when its shelf runs low. Auto-indents from reorder levels appear here too."
          />
        }
      >
        <ul className="flex flex-col gap-2" data-testid="indent-list">
          {indents.items.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                data-testid={`indent-${row.documentNo}`}
                aria-current={openId === row.id}
                onClick={() => {
                  setOpenId(row.id);
                  setApprovals({});
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
        {indents.hasMore ? (
          <Button variant="secondary" size="sm" onClick={indents.loadMore} disabled={indents.isFetching}>
            {indents.isFetching ? 'Loading the next page…' : 'Load the next page'}
          </Button>
        ) : null}
      </AsyncPanel>

      {openId === null ? (
        <EmptyState
          cause="No indent opened."
          nextAction="Open one above to approve a quantity per line, or to generate its pick list."
        />
      ) : (
        <AsyncPanel
          loading={opened.isPending}
          error={opened.error}
          isEmpty={document === null}
          skeletonLabel="Loading the indent"
          skeletonRows={5}
          onRetry={() => void opened.refetch()}
          empty={
            <EmptyState
              cause="That indent could not be read."
              nextAction="It may belong to another branch. Try one from the list above."
            />
          }
        >
          {document === null ? null : (
            <section
              className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
              data-testid="indent-detail"
            >
              <DocumentSummary document={document} />

              <DocumentLinesTable
                document={document}
                caption={`Lines on indent ${document.documentNo}`}
                extras={[
                  { header: 'Approved', keys: ['qty_approved_base', 'qtyApprovedBase'], numeric: true },
                  { header: 'Issued', keys: ['qty_issued_base', 'qtyIssuedBase'], numeric: true },
                  { header: 'Received', keys: ['qty_received_base', 'qtyReceivedBase'], numeric: true },
                ]}
              />

              {canApprove && document.status === 'pending_approval' ? (
                <div className="flex flex-col gap-3" data-testid="indent-approval">
                  <h3 className="text-md font-medium text-fg-default">Approve a quantity per line</h3>
                  <p className="text-sm text-fg-muted">
                    Leave a line blank to approve what was asked for. Approving less than was asked is normal
                    — the ward sees the figure, so it knows what is coming.
                  </p>
                  <ul className="flex flex-col gap-2">
                    {document.lines.map((line) => (
                      <li key={line.id} className="flex flex-wrap items-end gap-3">
                        <span className="min-w-56 text-sm text-fg-default">
                          {line.itemName}
                          <span className="ms-2 font-mono text-2xs text-fg-subtle">
                            asked {formatQty(line.qtyBase)}
                            {extraText(line, 'qty_approved_base', 'qtyApprovedBase') === null
                              ? ''
                              : ` · approved ${formatQty(extraText(line, 'qty_approved_base', 'qtyApprovedBase'))}`}
                          </span>
                        </span>
                        <div className="flex w-28 flex-col gap-1">
                          <Label htmlFor={`approve-${line.id}`}>Approve</Label>
                          <Input
                            id={`approve-${line.id}`}
                            data-testid={`approve-${line.itemCode}`}
                            inputMode="decimal"
                            value={approvals[line.id] ?? ''}
                            placeholder={line.qtyEntered}
                            onChange={(event) => {
                              setApprovals((previous) => ({ ...previous, [line.id]: event.target.value }));
                            }}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="primary"
                      data-testid="confirm-approve-indent"
                      disabled={approve.isPending}
                      onClick={() => {
                        approve.mutate(document);
                      }}
                    >
                      {approve.isPending ? 'Approving…' : 'Approve'}
                    </Button>
                  </div>
                  {approve.error === null ? null : <ProblemCard error={approve.error} />}

                  <div className="flex flex-col gap-1">
                    <Label htmlFor="indent-reject-reason">Or reject it, with a reason</Label>
                    <Textarea
                      id="indent-reject-reason"
                      data-testid="indent-reject-reason"
                      rows={2}
                      value={rejectReason}
                      onChange={(event) => {
                        setRejectReason(event.target.value);
                      }}
                    />
                    <Button
                      variant="danger"
                      size="sm"
                      className="mt-2 self-start"
                      data-testid="confirm-reject-indent"
                      disabled={rejectReason.trim().length < 8 || reject.isPending}
                      onClick={() => {
                        reject.mutate(document.id);
                      }}
                    >
                      {reject.isPending ? 'Rejecting…' : 'Reject'}
                    </Button>
                  </div>
                  {reject.error === null ? null : <ProblemCard error={reject.error} />}
                </div>
              ) : null}

              {canPick && document.status === 'approved' ? (
                <div className="flex flex-col gap-2">
                  <Button
                    variant="secondary"
                    className="self-start"
                    data-testid="generate-pick-list"
                    disabled={pick.isPending}
                    onClick={() => {
                      pick.mutate(document.id);
                    }}
                  >
                    {pick.isPending ? 'Choosing batches…' : 'Generate the FEFO pick list'}
                  </Button>
                  <p className="text-2xs text-fg-muted">
                    This writes down which batch FEFO chose before anybody walks to the shelf, so taking a
                    different one is a documented override rather than an unrecorded decision.
                  </p>
                  {pick.error === null ? null : <ProblemCard error={pick.error} />}
                </div>
              ) : null}

              {!canApprove ? (
                <p className="text-sm text-fg-muted">
                  Approving an indent needs <span className="font-mono">inventory.store_indent.approve</span>,
                  which is held by the store that gives the stock away rather than by the ward that asks for
                  it.
                </p>
              ) : null}

              <Badge tone="neutral">
                {document.storeId === null ? 'No store' : `Store ${document.storeId.slice(-6)}`}
              </Badge>
            </section>
          )}
        </AsyncPanel>
      )}
    </section>
  );
}
