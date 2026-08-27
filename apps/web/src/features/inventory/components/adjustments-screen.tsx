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
  approveAdjustment,
  approveCount,
  createAdjustment,
  createCountPlan,
  getAdjustment,
  getCountPlan,
  listAdjustments,
  listCountPlans,
  recordCount,
} from '../api/client';
import { inventoryKeys } from '../api/keys';
import type { AdjustmentType, DocumentView } from '../api/types';
import { useCursorList } from '../lib/cursor-list';
import { countApprovalProblems, countVariances, extraText } from '../lib/documents';
import { DocumentLinesTable, DocumentSummary } from './document-panel';
import { StorePicker } from './store-picker';
import { formatQty } from '@/features/pharmacy/lib/format';

/**
 * NC-006 §3.7 — corrections and cycle counts.
 *
 * ── Nothing here edits a ledger row ─────────────────────────────────────────
 *
 * `phase-04 §Constraints`: "the stock ledger never gets an UPDATE. Corrections
 * are new compensating entries with reason." So an adjustment is a *document*
 * with a maker, a checker and a reason, and approving it is what posts the
 * ledger entry. There is no field on this screen that sets a balance.
 *
 * ── Maker ≠ checker, and the screen says so ─────────────────────────────────
 *
 * The service and the database both refuse the same person raising and approving
 * an adjustment. Rather than hiding the Approve button and leaving somebody
 * puzzled, the screen shows it and lets the refusal arrive with its reason —
 * except where the session simply lacks the key, which it says in words.
 *
 * ── The blind count ─────────────────────────────────────────────────────────
 *
 * A blind count hides the system figure until it is posted, and this screen
 * keeps it hidden. A counting sheet that shows the expected number is a
 * confirmation exercise, and confirmation exercises find nothing.
 */
const ADJUSTMENT_TYPES: readonly { readonly value: AdjustmentType; readonly label: string }[] = [
  { value: 'plus', label: 'Increase — found stock' },
  { value: 'minus', label: 'Decrease — missing stock' },
  { value: 'writeoff_expiry', label: 'Write off — expired' },
  { value: 'writeoff_damage', label: 'Write off — damaged' },
  { value: 'writeoff_recall', label: 'Write off — recalled' },
  { value: 'repack', label: 'Repack' },
  { value: 'donation', label: 'Donation' },
  { value: 'sample', label: 'Sample' },
];

export function AdjustmentsScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = inventoryKeys(hospitalId);
  const { publish } = useToast();

  const [storeId, setStoreId] = useState('');
  const [openAdjustmentId, setOpenAdjustmentId] = useState<string | null>(null);
  const [openCountId, setOpenCountId] = useState<string | null>(null);
  const [adjustmentType, setAdjustmentType] = useState<AdjustmentType>('minus');
  const [reasonCode, setReasonCode] = useState('breakage');
  const [reason, setReason] = useState('');
  const [itemId, setItemId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [countReason, setCountReason] = useState('');
  const [counted, setCounted] = useState<Record<string, string>>({});

  const canCreate = granted.has('inventory.adjustment.create');
  const canApprove = granted.has('inventory.adjustment.approve');
  const canPlan = granted.has('inventory.count.plan');
  const canCount = granted.has('inventory.count.count');
  const canApproveCount = granted.has('inventory.count.approve');

  const adjustments = useCursorList<DocumentView>({
    queryKey: keys.adjustments(storeId, 'all', 'paged'),
    fetchPage: (cursor, signal) =>
      listAdjustments(
        { storeId: storeId === '' ? undefined : storeId, cursor },
        signal === undefined ? {} : { signal },
      ),
  });

  const counts = useCursorList<DocumentView>({
    queryKey: keys.counts(storeId, 'paged'),
    fetchPage: (cursor, signal) =>
      listCountPlans(
        { storeId: storeId === '' ? undefined : storeId, cursor },
        signal === undefined ? {} : { signal },
      ),
  });

  const openedAdjustment = useQuery({
    queryKey: keys.adjustment(openAdjustmentId ?? 'none'),
    queryFn: ({ signal }) =>
      openAdjustmentId === null
        ? Promise.reject(new Error('no adjustment'))
        : getAdjustment(openAdjustmentId, { signal }),
    enabled: openAdjustmentId !== null,
  });

  const openedCount = useQuery({
    queryKey: keys.count(openCountId ?? 'none'),
    queryFn: ({ signal }) =>
      openCountId === null ? Promise.reject(new Error('no count')) : getCountPlan(openCountId, { signal }),
    enabled: openCountId !== null,
  });

  const create = useMutation({
    mutationFn: () =>
      createAdjustment({
        storeId,
        adjustmentType,
        reasonCode: reasonCode.trim(),
        reason: reason.trim(),
        lines: [{ itemId: itemId.trim(), qtyEntered: Number(quantity) }],
      }),
    onSuccess: (created) => {
      setItemId('');
      setQuantity('');
      setReason('');
      adjustments.refetch();
      setOpenAdjustmentId(created.id);
      publish({
        title: `Adjustment ${created.documentNo} raised`,
        description:
          'Nothing has moved. Somebody else has to approve it, and that is what posts the ledger entry.',
        severity: 'success',
      });
    },
  });

  const approve = useMutation({
    mutationFn: (id: string) => approveAdjustment(id, undefined),
    onSuccess: () => {
      void openedAdjustment.refetch();
      adjustments.refetch();
      publish({ title: 'Approved and posted', severity: 'success' });
    },
  });

  const plan = useMutation({
    mutationFn: () =>
      createCountPlan({
        storeId,
        countType: 'cycle',
        scheduledFor: new Date().toISOString().slice(0, 10),
        blind: true,
        freezeMovements: true,
      }),
    onSuccess: (created) => {
      counts.refetch();
      setOpenCountId(created.id);
    },
  });

  /**
   * The count sheet a line belongs to.
   *
   * `POST /counts/sheets/{id}/lines` is keyed on the **sheet**, and the API
   * publishes the sheet id on each line's `extra` rather than on the plan
   * header — a plan can be split across several counters' sheets. So the id is
   * read from the first line that has one, and a plan whose lines carry none is
   * a plan with no sheet to record against, which the mutation says in words
   * rather than posting to `/counts/sheets/null/lines`.
   */
  function sheetIdOf(document: DocumentView): string | null {
    for (const line of document.lines) {
      const sheetId = extraText(line, 'sheetId', 'sheet_id');
      if (sheetId !== null) return sheetId;
    }
    return null;
  }

  const record = useMutation({
    mutationFn: (document: DocumentView) => {
      const sheetId = sheetIdOf(document);
      if (sheetId === null) {
        throw new Error(
          'This count plan has no sheet to record against yet. A sheet is created when the plan is assigned to a counter.',
        );
      }
      return recordCount(sheetId, {
        lines: document.lines
          .filter((line) => (counted[line.id] ?? '') !== '')
          .map((line) => ({ lineId: line.id, countedEntered: Number(counted[line.id] ?? '0') })),
      });
    },
    onSuccess: () => {
      setCounted({});
      void openedCount.refetch();
    },
  });

  const approveVariance = useMutation({
    mutationFn: (id: string) => approveCount(id, { reason: countReason.trim(), postAdjustment: true }),
    onSuccess: () => {
      setCountReason('');
      void openedCount.refetch();
      counts.refetch();
      adjustments.refetch();
      publish({
        title: 'Variance approved',
        description:
          'A compensating ledger entry has been posted under your reason. No ledger row was edited.',
        severity: 'success',
      });
    },
  });

  const adjustment = openedAdjustment.data ?? null;
  const countPlan = openedCount.data ?? null;
  const variances = countPlan === null ? [] : countVariances(countPlan);
  const varianceProblems = countApprovalProblems(countReason, variances);

  return (
    <section className="flex flex-col gap-4" data-testid="adjustments-screen">
      <PageHeader
        eyebrow="NC-006 · movements"
        title="Adjustments & counts"
        description="Nothing here edits a ledger row. A correction is a new compensating entry with a reason, raised by one person and approved by another."
        actions={<StorePicker value={storeId} onChange={setStoreId} label="Store" />}
      />

      <Tabs defaultValue="adjustments">
        <TabsList>
          <TabsTrigger value="adjustments">Adjustments</TabsTrigger>
          <TabsTrigger value="counts">Cycle counts</TabsTrigger>
        </TabsList>

        <TabsContent value="adjustments">
          <div className="flex flex-col gap-4">
            {canCreate && storeId !== '' ? (
              <section
                className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
                data-testid="raise-adjustment"
              >
                <h2 className="text-md font-medium text-fg-default">Raise an adjustment</h2>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex min-w-64 flex-col gap-1">
                    <Label htmlFor="adjustment-type">What kind?</Label>
                    <select
                      id="adjustment-type"
                      data-testid="adjustment-type"
                      className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                      value={adjustmentType}
                      onChange={(event) => {
                        setAdjustmentType(event.target.value as AdjustmentType);
                      }}
                    >
                      {ADJUSTMENT_TYPES.map((entry) => (
                        <option key={entry.value} value={entry.value}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex min-w-40 flex-col gap-1">
                    <Label htmlFor="adjustment-code">Reason code</Label>
                    <Input
                      id="adjustment-code"
                      data-testid="adjustment-code"
                      value={reasonCode}
                      onChange={(event) => {
                        setReasonCode(event.target.value);
                      }}
                    />
                  </div>
                  <div className="flex min-w-56 flex-col gap-1">
                    <Label htmlFor="adjustment-item">Item id</Label>
                    <Input
                      id="adjustment-item"
                      data-testid="adjustment-item"
                      value={itemId}
                      onChange={(event) => {
                        setItemId(event.target.value);
                      }}
                    />
                  </div>
                  <div className="flex w-28 flex-col gap-1">
                    <Label htmlFor="adjustment-qty">Quantity</Label>
                    <Input
                      id="adjustment-qty"
                      data-testid="adjustment-qty"
                      inputMode="decimal"
                      value={quantity}
                      onChange={(event) => {
                        setQuantity(event.target.value);
                      }}
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="adjustment-reason">
                    Reason (at least 8 characters — the approver and an auditor both read it)
                  </Label>
                  <Textarea
                    id="adjustment-reason"
                    data-testid="adjustment-reason"
                    rows={2}
                    value={reason}
                    onChange={(event) => {
                      setReason(event.target.value);
                    }}
                  />
                </div>
                <Button
                  variant="primary"
                  className="self-start"
                  data-testid="confirm-raise-adjustment"
                  disabled={
                    reason.trim().length < 8 ||
                    itemId.trim() === '' ||
                    Number(quantity) <= 0 ||
                    create.isPending
                  }
                  onClick={() => {
                    create.mutate();
                  }}
                >
                  {create.isPending ? 'Raising…' : 'Raise for approval'}
                </Button>
                {create.error === null ? null : <ProblemCard error={create.error} />}
              </section>
            ) : null}

            <AsyncPanel
              loading={adjustments.isPending}
              error={adjustments.error}
              isEmpty={adjustments.items.length === 0}
              skeletonLabel="Loading adjustments"
              skeletonRows={6}
              onRetry={adjustments.refetch}
              empty={
                <EmptyState
                  cause="No adjustment has been raised."
                  nextAction="Raise one when the shelf and the system disagree — but a count is usually the better instrument, because it finds what nobody noticed."
                />
              }
            >
              <ul className="flex flex-col gap-2" data-testid="adjustment-list">
                {adjustments.items.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      data-testid={`adjustment-${row.documentNo}`}
                      aria-current={openAdjustmentId === row.id}
                      onClick={() => {
                        setOpenAdjustmentId(row.id);
                      }}
                      className={`flex w-full flex-col gap-1 rounded-md border p-3 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                        openAdjustmentId === row.id
                          ? 'border-focus bg-layer-3'
                          : 'border-default bg-layer-2 hover:bg-layer-3'
                      }`}
                    >
                      <DocumentSummary document={row} />
                    </button>
                  </li>
                ))}
              </ul>
              {adjustments.hasMore ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={adjustments.loadMore}
                  disabled={adjustments.isFetching}
                >
                  {adjustments.isFetching ? 'Loading the next page…' : 'Load the next page'}
                </Button>
              ) : null}
            </AsyncPanel>

            {adjustment === null ? null : (
              <section
                className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
                data-testid="adjustment-detail"
              >
                <DocumentSummary document={adjustment} />
                <DocumentLinesTable
                  document={adjustment}
                  caption={`Lines on adjustment ${adjustment.documentNo}`}
                  extras={[
                    { header: 'Value', keys: ['value'] },
                    { header: 'Line reason', keys: ['lineReason', 'line_reason'] },
                  ]}
                />
                {adjustment.status === 'pending_approval' ? (
                  canApprove ? (
                    <>
                      <Button
                        variant="primary"
                        className="self-start"
                        data-testid="approve-adjustment"
                        disabled={approve.isPending}
                        onClick={() => {
                          approve.mutate(adjustment.id);
                        }}
                      >
                        {approve.isPending ? 'Approving…' : 'Approve — this posts the ledger entry'}
                      </Button>
                      <p className="text-2xs text-fg-muted">
                        The database refuses this if you are the person who raised it. That is not a bug in
                        the button; it is the control.
                      </p>
                      {approve.error === null ? null : <ProblemCard error={approve.error} />}
                    </>
                  ) : (
                    <p className="text-sm text-fg-muted">
                      Approving an adjustment needs{' '}
                      <span className="font-mono">inventory.adjustment.approve</span>, held by the store
                      manager rather than the person who raised it.
                    </p>
                  )
                ) : null}
              </section>
            )}
          </div>
        </TabsContent>

        <TabsContent value="counts">
          <div className="flex flex-col gap-4">
            {canPlan && storeId !== '' ? (
              <Button
                variant="secondary"
                className="self-start"
                data-testid="plan-count"
                disabled={plan.isPending}
                onClick={() => {
                  plan.mutate();
                }}
              >
                {plan.isPending ? 'Planning…' : 'Plan a blind cycle count for today'}
              </Button>
            ) : null}
            {plan.error === null ? null : <ProblemCard error={plan.error} />}

            <AsyncPanel
              loading={counts.isPending}
              error={counts.error}
              isEmpty={counts.items.length === 0}
              skeletonLabel="Loading count plans"
              skeletonRows={5}
              onRetry={counts.refetch}
              empty={
                <EmptyState
                  cause="No cycle count has been planned for this store."
                  nextAction="A cycle count by ABC class is how a store finds what nobody noticed. Plan one — blind, so the counter cannot count to the expected figure."
                />
              }
            >
              <ul className="flex flex-col gap-2" data-testid="count-list">
                {counts.items.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      data-testid={`count-${row.documentNo}`}
                      aria-current={openCountId === row.id}
                      onClick={() => {
                        setOpenCountId(row.id);
                      }}
                      className={`flex w-full flex-col gap-1 rounded-md border p-3 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                        openCountId === row.id
                          ? 'border-focus bg-layer-3'
                          : 'border-default bg-layer-2 hover:bg-layer-3'
                      }`}
                    >
                      <DocumentSummary document={row} />
                    </button>
                  </li>
                ))}
              </ul>
              {counts.hasMore ? (
                <Button variant="secondary" size="sm" onClick={counts.loadMore} disabled={counts.isFetching}>
                  {counts.isFetching ? 'Loading the next page…' : 'Load the next page'}
                </Button>
              ) : null}
            </AsyncPanel>

            {countPlan === null ? null : (
              <section
                className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
                data-testid="count-detail"
              >
                <DocumentSummary document={countPlan} />
                {countPlan.header['blind'] === true ? (
                  <Badge tone="info">Blind count — the system figure is hidden until this is posted</Badge>
                ) : null}

                {countPlan.lines.length === 0 ? (
                  <EmptyState
                    cause="This count plan has no sheet lines yet."
                    nextAction="The plan covers no items. Plan one that names the items or the ABC class to be counted."
                  />
                ) : (
                  <>
                    {canCount ? (
                      <div className="flex flex-col gap-2" data-testid="count-sheet">
                        <h3 className="text-md font-medium text-fg-default">Count sheet</h3>
                        <ul className="flex flex-col gap-2">
                          {countPlan.lines.map((line) => (
                            <li key={line.id} className="flex flex-wrap items-end gap-3">
                              <span className="min-w-56 text-sm text-fg-default">
                                {line.itemName}
                                <span className="ms-2 font-mono text-2xs text-fg-subtle">
                                  batch {line.batchNo ?? '—'}
                                </span>
                              </span>
                              <div className="flex w-28 flex-col gap-1">
                                <Label htmlFor={`counted-${line.id}`}>Counted</Label>
                                <Input
                                  id={`counted-${line.id}`}
                                  data-testid={`counted-${line.itemCode}`}
                                  inputMode="decimal"
                                  value={counted[line.id] ?? ''}
                                  onChange={(event) => {
                                    setCounted((previous) => ({
                                      ...previous,
                                      [line.id]: event.target.value,
                                    }));
                                  }}
                                />
                              </div>
                              <span className="font-mono text-2xs text-fg-subtle">
                                system{' '}
                                {extraText(line, 'systemQtyBase', 'system_qty_base') === null
                                  ? 'hidden — blind count'
                                  : formatQty(extraText(line, 'systemQtyBase', 'system_qty_base'))}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <Button
                          variant="secondary"
                          className="self-start"
                          data-testid="record-count"
                          disabled={record.isPending}
                          onClick={() => {
                            record.mutate(countPlan);
                          }}
                        >
                          {record.isPending ? 'Recording…' : 'Record the count'}
                        </Button>
                        {record.error === null ? null : <ProblemCard error={record.error} />}
                      </div>
                    ) : null}

                    {variances.length === 0 ? (
                      <p className="text-sm text-success-fg">
                        Every counted line agrees with the system. Nothing to approve.
                      </p>
                    ) : (
                      <div className="flex flex-col gap-2" data-testid="count-variances">
                        <h3 className="text-md font-medium text-fg-default">
                          {variances.length} line(s) disagree with the system
                        </h3>
                        <ul className="flex flex-col gap-1">
                          {variances.map((variance) => (
                            <li
                              key={variance.lineId}
                              className="flex flex-wrap justify-between gap-2 text-sm"
                            >
                              <span className="text-fg-default">
                                {variance.itemName}
                                <span className="ms-2 font-mono text-2xs text-fg-subtle">
                                  {variance.itemCode}
                                </span>
                              </span>
                              <span className="font-mono text-warning-fg">
                                counted {formatQty(variance.counted)} · system{' '}
                                {variance.system === null ? 'hidden' : formatQty(variance.system)} · variance{' '}
                                {formatQty(variance.variance)}
                              </span>
                            </li>
                          ))}
                        </ul>

                        {canApproveCount ? (
                          <>
                            <Label htmlFor="count-reason">
                              What happened? The compensating ledger entry is posted under this reason.
                            </Label>
                            <Textarea
                              id="count-reason"
                              data-testid="count-reason"
                              rows={2}
                              value={countReason}
                              onChange={(event) => {
                                setCountReason(event.target.value);
                              }}
                            />
                            {varianceProblems.map((problem) => (
                              <p key={problem} className="text-2xs text-fg-muted">
                                {problem}
                              </p>
                            ))}
                            <Button
                              variant="primary"
                              className="self-start"
                              data-testid="approve-variance"
                              disabled={varianceProblems.length > 0 || approveVariance.isPending}
                              onClick={() => {
                                approveVariance.mutate(countPlan.id);
                              }}
                            >
                              {approveVariance.isPending
                                ? 'Approving…'
                                : 'Approve the variance and post the adjustment'}
                            </Button>
                            {approveVariance.error === null ? null : (
                              <ProblemCard error={approveVariance.error} />
                            )}
                          </>
                        ) : (
                          <p className="text-sm text-fg-muted">
                            Approving a variance needs{' '}
                            <span className="font-mono">inventory.count.approve</span>, and whoever counted
                            the shelf never approves their own variance.
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </section>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </section>
  );
}
