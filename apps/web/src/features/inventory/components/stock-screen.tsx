'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
  EmptyState,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  WorklistTable,
} from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { checkStockIntegrity, listExpiring, listLedger, listStock } from '../api/client';
import { inventoryKeys } from '../api/keys';
import type { LedgerEntryView, StockBalanceView } from '../api/types';
import { useCursorList } from '../lib/cursor-list';
import { worklistLabels } from '../lib/worklist-labels';
import {
  EXPIRY_BAND_LABEL,
  EXPIRY_BAND_TONE,
  daysUntil,
  expiryBand,
  formatDate,
  formatInstant,
  formatMoney,
  formatQty,
  humanise,
} from '@/features/pharmacy/lib/format';
import { StorePicker } from './store-picker';

/**
 * NC-006 §3.3 — stock on hand, the ledger behind it, and the integrity check
 * that proves the two agree.
 *
 * ── Why the ledger is a first-class tab rather than a drill-down ────────────
 *
 * `phase-04 §Constraints`: "the stock ledger never gets an UPDATE. Corrections
 * are new compensating entries with reason." A system whose ledger is buried
 * three clicks under a balance teaches people that the balance is the truth and
 * the ledger is an audit artefact. It is the other way round — the balance is a
 * cache of the ledger — and this screen is laid out to say so.
 *
 * ── The integrity check (exit gate 6) ───────────────────────────────────────
 *
 * `GET /inventory/integrity` recomputes `sum(ledger) = on_hand` for every
 * item/batch/store and returns the rows that disagree. An empty list is the
 * pass. It is a button rather than a background poll because it is a full scan,
 * and because the answer only matters when somebody is asking.
 */
export function StockScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = inventoryKeys(hospitalId);

  const [storeId, setStoreId] = useState('');
  const [days, setDays] = useState(90);
  const [integrityAsked, setIntegrityAsked] = useState(false);

  const canLedger = granted.has('inventory.ledger.list');
  const canExpiry = granted.has('inventory.expiry.read');
  const canIntegrity = granted.has('inventory.report.read');
  const now = new Date();

  const stock = useCursorList<StockBalanceView>({
    queryKey: keys.stock(storeId, 'all', 'paged'),
    fetchPage: (cursor, signal) =>
      listStock(
        { storeId: storeId === '' ? undefined : storeId, cursor },
        signal === undefined ? {} : { signal },
      ),
    enabled: storeId !== '',
  });

  const ledger = useCursorList<LedgerEntryView>({
    queryKey: keys.ledger(storeId, 'all', 'paged'),
    fetchPage: (cursor, signal) =>
      listLedger(
        { storeId: storeId === '' ? undefined : storeId, cursor },
        signal === undefined ? {} : { signal },
      ),
    enabled: storeId !== '' && canLedger,
  });

  const expiring = useCursorList<StockBalanceView>({
    queryKey: keys.expiring(storeId, days, 'paged'),
    fetchPage: (cursor, signal) =>
      listExpiring(
        { storeId: storeId === '' ? undefined : storeId, days, cursor },
        signal === undefined ? {} : { signal },
      ),
    enabled: storeId !== '' && canExpiry,
  });

  const integrity = useQuery({
    queryKey: keys.integrity(),
    queryFn: ({ signal }) => checkStockIntegrity({ signal }),
    enabled: integrityAsked && canIntegrity,
    retry: false,
  });

  return (
    <section className="flex flex-col gap-4" data-testid="stock-screen">
      <PageHeader
        eyebrow="NC-006 · stock"
        title="Stock & ledger"
        description="The balance is a cache of the ledger, not the other way round. Every figure here can be traced to the movements that produced it."
        actions={
          <div className="flex flex-wrap items-end gap-3">
            <StorePicker value={storeId} onChange={setStoreId} label="Store" />
          </div>
        }
      />

      {storeId === '' ? (
        <EmptyState
          cause="No store chosen yet."
          nextAction="Stock is held per store. Choose the one whose shelf you are asking about."
        />
      ) : (
        <Tabs defaultValue="balances">
          <TabsList>
            <TabsTrigger value="balances">On hand</TabsTrigger>
            <TabsTrigger value="expiring">Expiring</TabsTrigger>
            <TabsTrigger value="ledger">Ledger</TabsTrigger>
            <TabsTrigger value="integrity">Integrity</TabsTrigger>
          </TabsList>

          <TabsContent value="balances">
            <AsyncPanel
              loading={stock.isPending}
              error={stock.error}
              isEmpty={stock.items.length === 0}
              skeletonLabel="Loading stock balances"
              skeletonRows={8}
              onRetry={stock.refetch}
              empty={
                <EmptyState
                  cause="This store holds nothing."
                  nextAction="Either nothing has ever been received into it, or everything has been issued out. The ledger tab will say which."
                />
              }
            >
              <WorklistTable<StockBalanceView>
                rows={stock.items}
                getRowId={(row) => row.id}
                labels={worklistLabels('Stock on hand')}
                empty={{ cause: 'This store holds nothing.', nextAction: 'Check the ledger tab.' }}
                hasMore={stock.hasMore}
                loading={stock.isFetching}
                onLoadMore={stock.loadMore}
                columns={[
                  {
                    key: 'item',
                    header: 'Item',
                    hideable: false,
                    render: (row) => (
                      <span>
                        {row.itemName}
                        <span className="ms-2 font-mono text-2xs text-fg-subtle">{row.itemCode}</span>
                      </span>
                    ),
                  },
                  {
                    key: 'batch',
                    header: 'Batch',
                    hideable: false,
                    render: (row) => <span className="font-mono text-xs">{row.batchNo ?? 'no batch'}</span>,
                  },
                  {
                    key: 'expiry',
                    header: 'Expiry',
                    hideable: false,
                    render: (row) => {
                      const band = expiryBand(daysUntil(row.expiryDate, now));
                      return (
                        <span className={EXPIRY_BAND_TONE[band]}>
                          {formatDate(row.expiryDate)}
                          <span className="ms-1 text-2xs">{EXPIRY_BAND_LABEL[band]}</span>
                        </span>
                      );
                    },
                  },
                  {
                    key: 'onhand',
                    header: 'On hand',
                    numeric: true,
                    render: (row) => formatQty(row.qtyOnHand),
                  },
                  {
                    key: 'reserved',
                    header: 'Reserved',
                    numeric: true,
                    render: (row) => formatQty(row.qtyReserved),
                  },
                  {
                    key: 'available',
                    header: 'Available',
                    numeric: true,
                    hideable: false,
                    render: (row) => <span className="font-mono">{formatQty(row.qtyAvailable)}</span>,
                  },
                  {
                    key: 'value',
                    header: 'Value',
                    numeric: true,
                    importance: 'secondary',
                    render: (row) => formatMoney(row.value),
                  },
                  {
                    key: 'consignment',
                    header: 'Ownership',
                    importance: 'secondary',
                    render: (row) => (
                      <Badge tone={row.isConsignment ? 'violet' : 'neutral'}>
                        {row.isConsignment ? 'On consignment' : 'Owned'}
                      </Badge>
                    ),
                  },
                  {
                    key: 'moved',
                    header: 'Last movement',
                    importance: 'secondary',
                    render: (row) => (
                      <span className="font-mono text-xs">{formatInstant(row.lastMovementAt)}</span>
                    ),
                  },
                ]}
              />
            </AsyncPanel>
          </TabsContent>

          <TabsContent value="expiring">
            <div className="mb-3 flex min-w-40 flex-col gap-1">
              <Label htmlFor="stock-expiry-horizon">Expiring within</Label>
              <select
                id="stock-expiry-horizon"
                data-testid="stock-expiry-horizon"
                className="h-9 w-40 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                value={days}
                onChange={(event) => {
                  setDays(Number(event.target.value));
                }}
              >
                {[30, 60, 90, 180, 365].map((horizon) => (
                  <option key={horizon} value={horizon}>
                    {horizon} days
                  </option>
                ))}
              </select>
            </div>
            {!canExpiry ? (
              <p className="text-sm text-fg-muted">
                Seeing the expiry board needs <span className="font-mono">inventory.expiry.read</span>.
              </p>
            ) : (
              <AsyncPanel
                loading={expiring.isPending}
                error={expiring.error}
                isEmpty={expiring.items.length === 0}
                skeletonLabel="Loading expiring stock"
                skeletonRows={6}
                onRetry={expiring.refetch}
                empty={
                  <EmptyState
                    cause={`Nothing in this store expires within ${String(days)} days.`}
                    nextAction="Widen the horizon to see what is coming, or move on — this is the answer you want."
                  />
                }
              >
                <ul className="flex flex-col gap-2" data-testid="expiring-list">
                  {expiring.items.map((row) => {
                    const band = expiryBand(daysUntil(row.expiryDate, now));
                    return (
                      <li
                        key={row.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-default bg-layer-2 p-3 text-sm"
                      >
                        <span className="text-fg-default">
                          {row.itemName}
                          <span className="ms-2 font-mono text-2xs text-fg-subtle">
                            batch {row.batchNo ?? '—'}
                          </span>
                        </span>
                        <span className={`font-mono text-2xs ${EXPIRY_BAND_TONE[band]}`}>
                          {formatDate(row.expiryDate)} · {EXPIRY_BAND_LABEL[band]} ·{' '}
                          {formatQty(row.qtyOnHand)} on hand · {formatMoney(row.value)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {expiring.hasMore ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={expiring.loadMore}
                    disabled={expiring.isFetching}
                  >
                    {expiring.isFetching ? 'Loading the next page…' : 'Load the next page'}
                  </Button>
                ) : null}
              </AsyncPanel>
            )}
          </TabsContent>

          <TabsContent value="ledger">
            {!canLedger ? (
              <p className="text-sm text-fg-muted">
                Reading the ledger needs <span className="font-mono">inventory.ledger.list</span>.
              </p>
            ) : (
              <AsyncPanel
                loading={ledger.isPending}
                error={ledger.error}
                isEmpty={ledger.items.length === 0}
                skeletonLabel="Loading the stock ledger"
                skeletonRows={10}
                onRetry={ledger.refetch}
                empty={
                  <EmptyState
                    cause="Nothing has ever moved in this store."
                    nextAction="A store's first ledger entry is its opening balance or its first goods receipt."
                  />
                }
              >
                <WorklistTable<LedgerEntryView>
                  rows={ledger.items}
                  getRowId={(row) => row.id}
                  labels={worklistLabels('Stock ledger — append-only')}
                  empty={{
                    cause: 'Nothing has ever moved in this store.',
                    nextAction: 'Its first entry is an opening balance or a goods receipt.',
                  }}
                  hasMore={ledger.hasMore}
                  loading={ledger.isFetching}
                  onLoadMore={ledger.loadMore}
                  criticalRowIds={
                    new Set(ledger.items.filter((row) => row.correctsLedgerId !== null).map((row) => row.id))
                  }
                  columns={[
                    {
                      key: 'when',
                      header: 'Moved at',
                      hideable: false,
                      render: (row) => (
                        <span className="font-mono text-xs">{formatInstant(row.movedAt)}</span>
                      ),
                    },
                    { key: 'item', header: 'Item', hideable: false, render: (row) => row.itemCode },
                    {
                      key: 'batch',
                      header: 'Batch',
                      render: (row) => <span className="font-mono text-xs">{row.batchNo ?? '—'}</span>,
                    },
                    {
                      key: 'movement',
                      header: 'Movement',
                      hideable: false,
                      render: (row) => (
                        <span className="flex items-center gap-1">
                          {humanise(row.movementType)}
                          {row.correctsLedgerId === null ? null : <Badge tone="warning">Correction</Badge>}
                        </span>
                      ),
                    },
                    {
                      key: 'qty',
                      header: 'Quantity',
                      numeric: true,
                      hideable: false,
                      render: (row) => (
                        <span
                          className={`font-mono ${Number(row.qtyBase) < 0 ? 'text-danger-fg' : 'text-success-fg'}`}
                        >
                          {formatQty(row.qtyBase)}
                        </span>
                      ),
                    },
                    {
                      key: 'value',
                      header: 'Value',
                      numeric: true,
                      importance: 'secondary',
                      render: (row) => formatMoney(row.value),
                    },
                    {
                      key: 'ref',
                      header: 'Document',
                      render: (row) => <span className="font-mono text-xs">{humanise(row.refType)}</span>,
                    },
                    {
                      key: 'reason',
                      header: 'Reason',
                      importance: 'secondary',
                      render: (row) => row.reason ?? '—',
                    },
                    {
                      key: 'who',
                      header: 'Signatures',
                      importance: 'secondary',
                      render: (row) => (row.secondActorId === null ? 'One' : 'Two'),
                    },
                  ]}
                />
              </AsyncPanel>
            )}
          </TabsContent>

          <TabsContent value="integrity">
            <section className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
              <h2 className="text-md font-medium text-fg-default">Does the ledger add up to the balances?</h2>
              <p className="text-sm text-fg-muted">
                Recomputes <span className="font-mono">sum(ledger) = on_hand</span> for every item, batch and
                store in this hospital. It is a full scan, so it runs when you ask rather than on a timer. An
                empty result is the pass.
              </p>
              {!canIntegrity ? (
                <p className="text-sm text-fg-muted">
                  Running it needs <span className="font-mono">inventory.report.read</span>.
                </p>
              ) : (
                <Button
                  variant="primary"
                  className="self-start"
                  data-testid="run-integrity"
                  disabled={integrity.isFetching}
                  onClick={() => {
                    setIntegrityAsked(true);
                    void integrity.refetch();
                  }}
                >
                  {integrity.isFetching ? 'Checking…' : 'Run the integrity check'}
                </Button>
              )}

              {integrity.error === null ? null : (
                <ProblemCard error={integrity.error} onRetry={() => void integrity.refetch()} />
              )}

              {integrity.data === undefined ? null : integrity.data.ok ? (
                <p
                  data-testid="integrity-pass"
                  className="rounded-md border border-success-border bg-success-surface p-3 text-sm text-success-on-surface"
                >
                  Every item, batch and store reconciles. The ledger and the balances agree exactly.
                </p>
              ) : (
                <div
                  role="alert"
                  data-testid="integrity-fail"
                  className="flex flex-col gap-2 rounded-md border border-danger-border bg-danger-surface p-3"
                >
                  <p className="text-sm font-medium text-danger-on-surface">
                    {integrity.data.rows.length} balance(s) do not agree with the ledger. This is a defect,
                    not a variance — do not adjust it away.
                  </p>
                  <ul className="flex flex-col gap-1">
                    {integrity.data.rows.map((row) => (
                      <li
                        key={`${row.storeId}-${row.itemId}-${row.batchId ?? 'none'}`}
                        className="font-mono text-2xs text-danger-on-surface"
                      >
                        store {row.storeId.slice(-6)} · item {row.itemId.slice(-6)} · batch{' '}
                        {row.batchId?.slice(-6) ?? 'none'} · ledger {row.ledgerSum} vs balance{' '}
                        {row.balanceQty} (difference {row.difference})
                      </li>
                    ))}
                  </ul>
                  <p className="text-2xs text-danger-on-surface">
                    Raise this with engineering. A compensating adjustment would hide the bug rather than fix
                    it.
                  </p>
                </div>
              )}
            </section>
          </TabsContent>
        </Tabs>
      )}
    </section>
  );
}
