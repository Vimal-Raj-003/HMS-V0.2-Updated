'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, WorklistTable } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { ScanSearch } from '@/lib/icons';
import { useSession } from '@/lib/session-context';
import { getAvailability, listFefoBatches, listItems, listSubstitutes, resolveBarcode } from '../api/client';
import { inventoryKeys } from '../api/keys';
import type { ItemView } from '../api/types';
import { useCursorList } from '../lib/cursor-list';
import { worklistLabels } from '../lib/worklist-labels';
import { fefoVerdict } from '../lib/documents';
import { formatDate, formatMoney, formatQty, humanise } from '@/features/pharmacy/lib/format';
import { StorePicker } from './store-picker';

/**
 * NC-006 §3.1 — the item master, and the two questions everybody actually asks
 * of it: *what is this box* and *where is there one*.
 *
 * ── The barcode field is first for a reason ─────────────────────────────────
 *
 * EN-013 §3: a scan resolves item, pack, batch and expiry in one round trip.
 * Anybody standing in a store holding something they cannot identify has a
 * barcode in their hand and a name they cannot spell, so the scan field comes
 * before the search box.
 *
 * ── The UoM ladder is rendered in full, and deliberately ────────────────────
 *
 * `phase-04 §Constraints`: "every quantity has a UoM; any arithmetic mixing UoMs
 * without conversion is a bug". The ladder — base ↔ strip ↔ box ↔ case with its
 * factors — is the thing that makes every quantity in the system mean something,
 * and a factor typed wrong is every quantity of that item wrong for ever. So it
 * is on the screen where somebody can notice, not behind an edit dialog.
 */
const ITEM_TYPES: readonly { readonly value: string; readonly label: string }[] = [
  { value: '', label: 'Every kind' },
  { value: 'drug', label: 'Drugs' },
  { value: 'consumable', label: 'Consumables' },
  { value: 'surgical', label: 'Surgical' },
  { value: 'implant', label: 'Implants' },
  { value: 'reagent', label: 'Reagents' },
  { value: 'instrument', label: 'Instruments' },
];

export function ItemsScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = inventoryKeys(hospitalId);

  const [term, setTerm] = useState('');
  const [itemType, setItemType] = useState('');
  const [barcode, setBarcode] = useState('');
  const [scanned, setScanned] = useState('');
  const [selected, setSelected] = useState<ItemView | null>(null);
  const [storeId, setStoreId] = useState('');

  const canScan = granted.has('inventory.item.read');
  const canSeeStock = granted.has('inventory.stock.read');
  const canSeeBatches = granted.has('inventory.batch.list');

  const items = useCursorList<ItemView>({
    queryKey: keys.items(term, itemType === '' ? 'all' : itemType, 'paged'),
    fetchPage: (cursor, signal) =>
      listItems(
        { q: term === '' ? undefined : term, itemType: itemType === '' ? undefined : itemType, cursor },
        signal === undefined ? {} : { signal },
      ),
  });

  const resolution = useQuery({
    queryKey: keys.scan(scanned),
    queryFn: ({ signal }) => resolveBarcode(scanned, { signal }),
    enabled: scanned !== '' && canScan,
    retry: false,
  });

  const availability = useQuery({
    queryKey: keys.availability(selected?.id ?? 'none'),
    queryFn: ({ signal }) =>
      selected === null ? Promise.reject(new Error('no item')) : getAvailability(selected.id, { signal }),
    enabled: selected !== null && canSeeStock,
  });

  const batches = useQuery({
    queryKey: keys.batches(storeId, selected?.id ?? 'none'),
    queryFn: ({ signal }) =>
      selected === null || storeId === ''
        ? Promise.reject(new Error('no item'))
        : listFefoBatches(selected.id, storeId, { signal }),
    enabled: selected !== null && storeId !== '' && canSeeBatches,
  });

  const substitutes = useQuery({
    queryKey: keys.substitutes(selected?.id ?? 'none'),
    queryFn: ({ signal }) =>
      selected === null ? Promise.reject(new Error('no item')) : listSubstitutes(selected.id, { signal }),
    enabled: selected !== null && canScan,
  });

  const fefo = fefoVerdict(batches.data?.items ?? [], null);

  return (
    <section className="flex flex-col gap-4" data-testid="items-screen">
      <PageHeader
        eyebrow="NC-006 · masters"
        title="Item master"
        description="What a box is, what it converts to, what it costs in tax terms, and where in the hospital there is one."
      />

      <section className="flex flex-wrap items-end gap-3 rounded-lg border border-strong bg-layer-1 p-4">
        <div className="flex min-w-64 flex-col gap-1">
          <Label htmlFor="item-barcode">Scan a pack</Label>
          <Input
            id="item-barcode"
            data-testid="item-barcode"
            value={barcode}
            autoComplete="off"
            placeholder="GS1 DataMatrix, EAN-13 or an internal code"
            onChange={(event) => {
              setBarcode(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              setScanned(barcode.trim());
            }}
          />
        </div>
        <div className="flex min-w-64 flex-1 flex-col gap-1">
          <Label htmlFor="item-search">…or search by name, generic or code</Label>
          <Input
            id="item-search"
            data-testid="item-search"
            value={term}
            autoComplete="off"
            onChange={(event) => {
              setTerm(event.target.value);
            }}
          />
        </div>
        <div className="flex min-w-48 flex-col gap-1">
          <Label htmlFor="item-type">Kind</Label>
          <select
            id="item-type"
            data-testid="item-type"
            className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            value={itemType}
            onChange={(event) => {
              setItemType(event.target.value);
            }}
          >
            {ITEM_TYPES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      {scanned === '' ? null : resolution.error !== null ? (
        <div
          role="status"
          data-testid="scan-unresolved"
          className="rounded-lg border border-warning-border bg-warning-surface p-3 text-sm text-warning-on-surface"
        >
          <p className="font-medium">No item in this hospital carries the barcode &ldquo;{scanned}&rdquo;.</p>
          <p className="mt-1">
            Check the label, or search by name below. A barcode from another branch resolves to nothing here,
            which is the tenancy boundary doing its job — and an unmapped GTIN has to be mapped by somebody
            who holds <span className="font-mono">inventory.item.gtin.map</span> before it will scan.
          </p>
        </div>
      ) : resolution.data === undefined ? null : (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-success-border bg-success-surface p-3"
          data-testid="scan-resolved"
        >
          <ScanSearch className="size-4 text-success-on-surface" aria-hidden="true" />
          <span className="text-md text-success-on-surface">{resolution.data.itemName}</span>
          <span className="font-mono text-2xs text-success-on-surface">{resolution.data.itemCode}</span>
          {resolution.data.batchNo === null ? null : (
            <Badge tone="neutral">
              Batch {resolution.data.batchNo} · exp {formatDate(resolution.data.expiryDate)}
            </Badge>
          )}
          <Badge tone={resolution.data.isNarcotic ? 'violet' : 'neutral'}>
            Schedule {resolution.data.schedule.toUpperCase()}
          </Badge>
          <span className="text-2xs text-success-on-surface">
            resolved from {humanise(resolution.data.source)}
          </span>
        </div>
      )}

      <AsyncPanel
        loading={items.isPending}
        error={items.error}
        isEmpty={items.items.length === 0}
        skeletonLabel="Searching the item master"
        skeletonRows={8}
        onRetry={items.refetch}
        empty={
          <EmptyState
            icon={<ScanSearch aria-hidden="true" />}
            cause={term === '' ? 'The item master is empty for this filter.' : `Nothing matches "${term}".`}
            nextAction="Try the generic name or the item code. If it genuinely is not there, somebody with inventory.item.create has to add it before anything can be bought or dispensed."
          />
        }
      >
        <WorklistTable<ItemView>
          rows={items.items}
          getRowId={(row) => row.id}
          labels={worklistLabels('Item master')}
          empty={{ cause: 'Nothing matches this filter.', nextAction: 'Try the generic name or the code.' }}
          hasMore={items.hasMore}
          loading={items.isFetching}
          onLoadMore={items.loadMore}
          onRowOpen={setSelected}
          columns={[
            {
              key: 'code',
              header: 'Code',
              hideable: false,
              render: (row) => <span className="font-mono text-xs">{row.code}</span>,
            },
            {
              key: 'name',
              header: 'Item',
              hideable: false,
              render: (row) => (
                <span>
                  <span className={row.isLasa ? 'font-semibold uppercase' : ''}>{row.name}</span>
                  {row.genericName === null ? null : (
                    <span className="ms-2 text-2xs text-fg-subtle">{row.genericName}</span>
                  )}
                </span>
              ),
            },
            {
              key: 'flags',
              header: 'Flags',
              hideable: false,
              render: (row) => (
                <span className="flex flex-wrap gap-1">
                  {row.schedule === 'otc' ? null : (
                    <Badge tone={row.isNarcotic ? 'violet' : 'neutral'}>
                      Schedule {row.schedule.toUpperCase()}
                    </Badge>
                  )}
                  {row.isHighAlert ? <Badge tone="danger">High alert</Badge> : null}
                  {row.isLasa ? <Badge tone="warning">LASA</Badge> : null}
                  {row.dpcoScheduled ? <Badge tone="info">DPCO</Badge> : null}
                </span>
              ),
            },
            { key: 'type', header: 'Kind', render: (row) => humanise(row.itemType) },
            { key: 'hsn', header: 'HSN', render: (row) => row.hsnCode ?? '—' },
            {
              key: 'classes',
              header: 'ABC / VED / FSN',
              importance: 'secondary',
              render: (row) =>
                `${row.abcClass.toUpperCase()} / ${humanise(row.vedClass)} / ${humanise(row.fsnClass)}`,
            },
            {
              key: 'storage',
              header: 'Storage',
              importance: 'secondary',
              render: (row) => humanise(row.storageCondition),
            },
            {
              key: 'status',
              header: 'Status',
              render: (row) => (
                <Badge tone={row.status === 'active' ? 'success' : 'warning'}>{humanise(row.status)}</Badge>
              ),
            },
          ]}
        />
      </AsyncPanel>

      {selected === null ? (
        <EmptyState
          cause="No item opened."
          nextAction="Open a row above to see its unit ladder, its substitutes and where in the hospital there is stock of it."
        />
      ) : (
        <section className="flex flex-col gap-4" data-testid="item-detail">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-default pb-2">
            <h2 className="text-xl font-semibold text-fg-default">
              {selected.name}
              <span className="ms-2 font-mono text-sm text-fg-subtle">{selected.code}</span>
            </h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelected(null);
              }}
            >
              Close
            </Button>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <section className="flex flex-col gap-2 rounded-lg border border-strong bg-layer-1 p-4">
              <h3 className="font-display text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                Unit ladder
              </h3>
              <p className="text-2xs text-fg-muted">
                Every quantity anywhere in the system is stored in the base unit. These factors are what
                convert a box into it — a factor typed wrong is every quantity of this item wrong.
              </p>
              {selected.uoms.length === 0 ? (
                <EmptyState
                  cause="This item has no unit ladder."
                  nextAction="It can only be counted in its base unit until somebody adds one. A purchase in boxes cannot be received against it."
                />
              ) : (
                <ul className="flex flex-col gap-1">
                  {selected.uoms.map((uom) => (
                    <li key={uom.uomId} className="flex justify-between gap-2 text-sm">
                      <span className="text-fg-default">
                        {uom.name} ({uom.code}) · {humanise(uom.packLevel)}
                      </span>
                      <span className="font-mono text-fg-muted">
                        {uom.isBase ? 'base' : `× ${formatQty(uom.factorToBase)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="flex flex-col gap-2 rounded-lg border border-strong bg-layer-1 p-4">
              <h3 className="font-display text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                Where there is stock
              </h3>
              {!canSeeStock ? (
                <p className="text-sm text-fg-muted">
                  Seeing availability needs <span className="font-mono">inventory.stock.read</span>.
                </p>
              ) : (
                <AsyncPanel
                  loading={availability.isPending}
                  error={availability.error}
                  isEmpty={(availability.data?.items ?? []).length === 0}
                  skeletonLabel="Loading availability"
                  skeletonRows={3}
                  onRetry={() => void availability.refetch()}
                  empty={
                    <EmptyState
                      cause="No store in this hospital holds any of this item."
                      nextAction="Raise a purchase indent, or check whether it is held under a different item code."
                    />
                  }
                >
                  <ul className="flex flex-col gap-1">
                    {(availability.data?.items ?? []).map((row) => (
                      <li key={row.storeId} className="flex justify-between gap-2 text-sm">
                        <span className="text-fg-default">
                          {row.storeName}
                          <span className="ms-1 font-mono text-2xs text-fg-subtle">{row.storeCode}</span>
                        </span>
                        <span className="font-mono text-fg-muted">
                          {formatQty(row.qtyAvailable)} · {row.batchCount} batch(es) · earliest expiry{' '}
                          {formatDate(row.earliestExpiry)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </AsyncPanel>
              )}
            </section>

            <section className="flex flex-col gap-2 rounded-lg border border-strong bg-layer-1 p-4">
              <h3 className="font-display text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                Substitutes
              </h3>
              <AsyncPanel
                loading={substitutes.isPending}
                error={substitutes.error}
                isEmpty={(substitutes.data?.items ?? []).length === 0}
                skeletonLabel="Loading substitutes"
                skeletonRows={3}
                onRetry={() => void substitutes.refetch()}
                empty={
                  <EmptyState
                    cause="No substitute is mapped for this item."
                    nextAction="A stock-out of it cannot be filled with anything else without a new prescription."
                  />
                }
              >
                <ul className="flex flex-col gap-1">
                  {(substitutes.data?.items ?? []).map((row) => (
                    <li key={row.itemId} className="flex flex-wrap justify-between gap-2 text-sm">
                      <span className="text-fg-default">
                        {row.name}
                        <span className="ms-1 font-mono text-2xs text-fg-subtle">{row.code}</span>
                      </span>
                      <span className="flex gap-1">
                        {row.isPreferred ? <Badge tone="success">Preferred</Badge> : null}
                        {row.requiresPrescriberApproval ? (
                          <Badge tone="warning">Prescriber must approve</Badge>
                        ) : (
                          <Badge tone="neutral">Substitutable under policy</Badge>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </AsyncPanel>
            </section>
          </div>

          <section className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h3 className="font-display text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                Batches in FEFO order
              </h3>
              <StorePicker value={storeId} onChange={setStoreId} label="In which store" />
            </div>
            {!canSeeBatches ? (
              <p className="text-sm text-fg-muted">
                Seeing batches needs <span className="font-mono">inventory.batch.list</span>.
              </p>
            ) : storeId === '' ? (
              <EmptyState
                cause="No store chosen."
                nextAction="Batches live on a shelf, not in a master. Choose the store you are asking about."
              />
            ) : (
              <AsyncPanel
                loading={batches.isPending}
                error={batches.error}
                isEmpty={(batches.data?.items ?? []).length === 0}
                skeletonLabel="Loading batches"
                skeletonRows={4}
                onRetry={() => void batches.refetch()}
                empty={
                  <EmptyState
                    cause="This store holds no usable batch of this item."
                    nextAction="Nothing can be picked or dispensed against it here. Raise an indent on the holding store."
                  />
                }
              >
                <>
                  {fefo.kind === 'fefo' ? (
                    <p className="text-2xs text-fg-muted" data-testid="fefo-note">
                      FEFO picks <span className="font-mono">{fefo.batch.batchNo}</span> — the earliest expiry
                      with stock. Taking any other batch is an override and needs a reason.
                    </p>
                  ) : null}
                  <ul className="flex flex-col gap-1">
                    {(batches.data?.items ?? []).map((batch, index) => (
                      <li key={batch.batchId} className="flex flex-wrap justify-between gap-2 text-sm">
                        <span className="font-mono text-fg-default">
                          {index === 0 ? '▸ ' : '   '}
                          {batch.batchNo}
                        </span>
                        <span className="font-mono text-fg-muted">
                          exp {formatDate(batch.expiryDate)} · {formatQty(batch.qtyAvailable)} available ·
                          cost {formatMoney(batch.unitCost)} · MRP {formatMoney(batch.mrp)}
                          {batch.isConsignment ? ' · consignment' : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              </AsyncPanel>
            )}
          </section>
        </section>
      )}

      {resolution.error === null ? null : null}
      {items.error === null ? null : <ProblemCard error={items.error} onRetry={items.refetch} />}
    </section>
  );
}
