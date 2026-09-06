'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, WorklistTable, useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { formatDate, formatInstant, formatMoney, formatQty } from '@/features/pharmacy/lib/format';
import {
  approveConsignmentAgreement,
  createConsignmentReconciliation,
  getConsignmentAgreement,
  listConsignmentAgreements,
  listConsignmentStock,
  listConsignmentUsages,
  reverseConsignmentUsage,
  signConsignmentReconciliation,
} from '../api/client';
import { inventoryKeys } from '../api/keys';
import type { ConsignmentStockRow, DocumentView } from '../api/types';
import { boundedList, useCursorList } from '../lib/cursor-list';
import { statusTone } from '../lib/documents';
import { worklistLabels } from '../lib/worklist-labels';
import { DocumentLinesTable, DocumentSummary } from './document-panel';
import { StorePicker } from './store-picker';

/**
 * NC-007 — consignment.
 *
 * ── The one idea this screen has to carry ───────────────────────────────────
 *
 * The stock on these shelves **is not the hospital's**. Nothing here has been
 * paid for, and the moment that changes is not a receipt and not an invoice — it
 * is the scan at the operating table. So the tabs are ordered the way the
 * liability moves: what is on the shelf, what the theatre used, what both sides
 * agreed at month end. A screen that led with agreements would put the paperwork
 * before the fact that creates the debt.
 *
 * ── Why usage is read-and-reverse here, never recorded ──────────────────────
 *
 * `POST /usages` is the OT scanner's route, not a desk's: it writes the ledger,
 * the usage, the traceability row and the replenishment order in one
 * transaction, and it is `@Idempotent()` because a retried scan would bill the
 * patient for a second implant they do not have. Offering a keyboard form for it
 * here would be a second, slower path to the thing the scanner already does
 * atomically — and the one that gets the UDI wrong. So this screen *reads*
 * usages and offers the reversal, which is a decision a person makes with a
 * reason attached (NC-007 §5: reversed, never edited).
 *
 * ── The reconciliation is the only place a vendor's name is typed ───────────
 *
 * `vendorSignedBy` is free text because the person signing is the vendor's
 * representative at the counter, not a user of this system. It is captured as a
 * name and an `agreed` boolean rather than as a signature image: the evidentiary
 * weight lives in the append-only document and its audit row, and a scanned
 * squiggle would imply a stronger claim than the data supports. A dispute is
 * recorded rather than discarded — it is the evidence behind a credit note.
 */
const USAGE_STATUSES: readonly { readonly value: string; readonly label: string }[] = [
  { value: '', label: 'Every status' },
  { value: 'used', label: 'Used' },
  { value: 'wasted', label: 'Wasted' },
  { value: 'reversed', label: 'Reversed' },
];

type Tab = 'stock' | 'usages' | 'agreements' | 'reconciliation';

const TABS: readonly { readonly key: Tab; readonly label: string }[] = [
  { key: 'stock', label: 'On our shelves' },
  { key: 'usages', label: 'Theatre usage' },
  { key: 'agreements', label: 'Agreements' },
  { key: 'reconciliation', label: 'Month-end' },
];

/**
 * `YYYY-MM` for the month that has just closed — the one being reconciled.
 *
 * `getUTCMonth()` is 0-indexed, so it already names last month in 1-indexed
 * terms; January wraps to December of the previous year.
 */
export function lastClosedPeriod(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const shifted = month === 0 ? { y: year - 1, m: 12 } : { y: year, m: month };
  return `${String(shifted.y)}-${String(shifted.m).padStart(2, '0')}`;
}

export function ConsignmentScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = inventoryKeys(hospitalId);
  const { publish } = useToast();

  const [tab, setTab] = useState<Tab>('stock');
  const [storeId, setStoreId] = useState('');
  const [usageStatus, setUsageStatus] = useState('');
  const [openUsageId, setOpenUsageId] = useState<string | null>(null);
  const [openAgreementId, setOpenAgreementId] = useState<string | null>(null);
  const [reverseReason, setReverseReason] = useState('');

  const [period, setPeriod] = useState(lastClosedPeriod());
  const [reconAgreementId, setReconAgreementId] = useState('');
  const [reconVendorId, setReconVendorId] = useState('');
  const [reconciliation, setReconciliation] = useState<DocumentView | null>(null);
  const [signedBy, setSignedBy] = useState('');
  const [signNote, setSignNote] = useState('');

  const canApproveAgreement = granted.has('inventory.consignment.agreement.approve');
  const canReverse = granted.has('inventory.consignment.approve');
  const canReconcile = granted.has('inventory.consignment.reconcile');
  const canSign = granted.has('inventory.consignment.sign');
  const canSeeStock = granted.has('inventory.consignment.stock.read');
  const canSeeUsages = granted.has('inventory.consignment.usage.list');

  const stockQuery = useQuery({
    queryKey: keys.consignmentStock(storeId === '' ? 'all' : storeId),
    queryFn: ({ signal }) => listConsignmentStock(storeId === '' ? undefined : storeId, { signal }),
    enabled: tab === 'stock' && canSeeStock,
  });
  const stock = boundedList<ConsignmentStockRow>(stockQuery.data, {
    isPending: stockQuery.isPending,
    isFetching: stockQuery.isFetching,
    error: stockQuery.error,
    refetch: () => {
      void stockQuery.refetch();
    },
  });

  const usages = useCursorList<DocumentView>({
    queryKey: keys.usages('all', 'all', usageStatus === '' ? 'all' : usageStatus, 'paged'),
    fetchPage: (cursor, signal) =>
      listConsignmentUsages(
        { status: usageStatus === '' ? undefined : usageStatus, cursor },
        signal === undefined ? {} : { signal },
      ),
    enabled: tab === 'usages' && canSeeUsages,
  });

  const agreements = useCursorList<DocumentView>({
    queryKey: keys.agreements(storeId === '' ? 'all' : storeId, 'paged'),
    fetchPage: (cursor, signal) =>
      listConsignmentAgreements(
        { storeId: storeId === '' ? undefined : storeId, cursor },
        signal === undefined ? {} : { signal },
      ),
    enabled: tab === 'agreements',
  });

  const openedAgreement = useQuery({
    queryKey: keys.agreement(openAgreementId ?? 'none'),
    queryFn: ({ signal }) =>
      openAgreementId === null
        ? Promise.reject(new Error('no agreement'))
        : getConsignmentAgreement(openAgreementId, { signal }),
    enabled: openAgreementId !== null,
  });

  const approve = useMutation({
    mutationFn: (id: string) => approveConsignmentAgreement(id),
    onSuccess: () => {
      agreements.refetch();
      void openedAgreement.refetch();
      publish({ title: 'Agreement approved', severity: 'success' });
    },
  });

  const reverse = useMutation({
    mutationFn: (id: string) => reverseConsignmentUsage(id, { reason: reverseReason }),
    onSuccess: () => {
      usages.refetch();
      stock.refetch();
      setOpenUsageId(null);
      setReverseReason('');
      publish({
        title: 'Usage reversed',
        description: 'The implant returns to the vendor’s stock and the replenishment is cancelled.',
        severity: 'success',
      });
    },
  });

  const buildReconciliation = useMutation({
    mutationFn: () =>
      createConsignmentReconciliation({
        vendorId: reconVendorId,
        agreementId: reconAgreementId,
        period,
      }),
    onSuccess: (document) => {
      setReconciliation(document);
      publish({ title: `Reconciliation ${document.documentNo} built`, severity: 'success' });
    },
  });

  const sign = useMutation({
    mutationFn: (agreed: boolean) =>
      signConsignmentReconciliation(reconciliation?.id ?? '', {
        vendorSignedBy: signedBy,
        agreed,
        ...(signNote === '' ? {} : { note: signNote }),
      }),
    onSuccess: (document) => {
      setReconciliation(document);
      publish({
        title: 'Reconciliation signed',
        description: 'Both sides have agreed the period. The vendor may now raise an invoice.',
        severity: 'success',
      });
    },
  });

  const consignedValue = stock.items.reduce((total, row) => total + Number(row.value), 0);
  const openUsage = usages.items.find((row) => row.id === openUsageId) ?? null;

  return (
    <section className="flex flex-col gap-4" data-testid="consignment-screen">
      <PageHeader
        eyebrow="NC-007 · consignment"
        title="Consignment"
        description="Stock standing on our shelves that the vendor still owns. It becomes ours — and payable — the moment the theatre scans it, not when it arrives."
        actions={
          <div className="flex flex-wrap items-end gap-3">
            <StorePicker value={storeId} onChange={setStoreId} label="Store" />
          </div>
        }
      />

      <nav aria-label="Consignment views" className="flex flex-wrap gap-1 border-b border-default">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            data-testid={`consignment-tab-${entry.key}`}
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

      {tab === 'stock' && !canSeeStock ? (
        <EmptyState
          cause="You cannot read consignment stock."
          nextAction="inventory.consignment.stock.read is held by stores and theatre staff. Ask your administrator if you need it."
        />
      ) : null}

      {tab === 'stock' && canSeeStock ? (
        <AsyncPanel
          loading={stock.isPending}
          error={stock.error}
          isEmpty={stock.items.length === 0}
          skeletonLabel="Loading consignment stock"
          skeletonRows={6}
          onRetry={stock.refetch}
          empty={
            <EmptyState
              cause="No consignment stock in this store."
              nextAction="Consignment arrives against an approved agreement. Check the Agreements tab, or widen the store filter."
            />
          }
        >
          <div className="flex flex-col gap-3">
            <p className="text-sm text-fg-muted" data-testid="consignment-stock-total">
              {stock.items.length} batch{stock.items.length === 1 ? '' : 'es'} on the shelf, worth{' '}
              <strong className="text-fg-default">{formatMoney(String(consignedValue))}</strong> to the vendor
              if used. The hospital has paid for none of it.
            </p>
            <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
              <table className="w-full text-sm">
                <caption className="sr-only">Consignment stock on hand, by batch</caption>
                <thead>
                  <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                    <th scope="col" className="px-3 py-2 text-start">
                      Item
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Batch
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Expires
                    </th>
                    <th scope="col" className="px-3 py-2 text-end">
                      On hand
                    </th>
                    <th scope="col" className="px-3 py-2 text-end">
                      Vendor value
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {stock.items.map((row) => (
                    <tr
                      key={`${row.itemId}-${row.batchId ?? 'none'}`}
                      className="border-b border-default last:border-0"
                    >
                      <td className="px-3 py-2 font-mono text-2xs text-fg-muted">{row.itemCode}</td>
                      <td className="px-3 py-2 font-mono text-2xs">{row.batchNo ?? 'no batch'}</td>
                      <td className="px-3 py-2 text-2xs">{formatDate(row.expiryDate)}</td>
                      <td className="px-3 py-2 text-end font-mono">{formatQty(row.qtyOnHand)}</td>
                      <td className="px-3 py-2 text-end font-mono">{formatMoney(row.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </AsyncPanel>
      ) : null}

      {tab === 'usages' && !canSeeUsages ? (
        <EmptyState
          cause="You cannot read consignment usage."
          nextAction="inventory.consignment.usage.list is held by theatre, stores and purchase staff."
        />
      ) : null}

      {tab === 'usages' && canSeeUsages ? (
        <div className="flex flex-col gap-3">
          <div className="flex min-w-56 max-w-xs flex-col gap-1">
            <Label htmlFor="usage-status">Status</Label>
            <select
              id="usage-status"
              data-testid="usage-status"
              className="h-9 rounded-md border border-control bg-layer-1 px-2 text-sm"
              value={usageStatus}
              onChange={(event) => {
                setUsageStatus(event.target.value);
              }}
            >
              {USAGE_STATUSES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <p className="text-sm text-fg-muted">
            A usage is recorded by the scanner at the table, which writes the ledger, the traceability row and
            the replenishment order in one transaction. It is corrected by reversal, never by an edit.
          </p>

          <AsyncPanel
            loading={usages.isPending}
            error={usages.error}
            isEmpty={usages.items.length === 0}
            skeletonLabel="Loading consignment usage"
            skeletonRows={6}
            onRetry={usages.refetch}
            empty={
              <EmptyState
                cause="No consignment usage recorded."
                nextAction="Usage appears here as the theatre scans implants against an approved agreement."
              />
            }
          >
            <WorklistTable<DocumentView>
              rows={usages.items}
              getRowId={(row) => row.id}
              labels={worklistLabels('Consignment usage')}
              empty={{
                cause: 'No consignment usage recorded.',
                nextAction: 'Usage appears here as the theatre scans implants.',
              }}
              hasMore={usages.hasMore}
              loading={usages.isFetching}
              onLoadMore={usages.loadMore}
              columns={[
                {
                  key: 'document',
                  header: 'Usage',
                  hideable: false,
                  render: (row) => <DocumentSummary document={row} />,
                },
                {
                  key: 'when',
                  header: 'Recorded',
                  render: (row) => (
                    <span className="text-2xs text-fg-subtle">{formatInstant(row.createdAt)}</span>
                  ),
                },
                {
                  key: 'action',
                  header: 'Action',
                  render: (row) => (
                    <Button
                      variant="ghost"
                      data-testid={`open-usage-${row.documentNo}`}
                      onClick={() => {
                        setOpenUsageId(row.id === openUsageId ? null : row.id);
                        setReverseReason('');
                      }}
                    >
                      {row.id === openUsageId ? 'Close' : 'Open'}
                    </Button>
                  ),
                },
              ]}
            />
          </AsyncPanel>

          {openUsage === null ? null : (
            <div
              className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
              data-testid="usage-detail"
            >
              <DocumentSummary document={openUsage} title="consignment usage" />
              <DocumentLinesTable
                document={openUsage}
                caption={`Lines of consignment usage ${openUsage.documentNo}`}
                extras={[
                  { header: 'Serial / UDI', keys: ['serialNo', 'serial_no', 'udiFull', 'udi_full'] },
                  { header: 'Side', keys: ['side'] },
                ]}
              />
              {reverse.error === null ? null : <ProblemCard error={reverse.error} />}
              {openUsage.status === 'reversed' ? (
                <p className="text-sm text-fg-muted">
                  This usage is already reversed. A reversal is itself a document; it is never undone.
                </p>
              ) : canReverse ? (
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex min-w-72 flex-1 flex-col gap-1">
                    <Label htmlFor="reverse-reason">Why is this being reversed?</Label>
                    <Input
                      id="reverse-reason"
                      data-testid="reverse-reason"
                      value={reverseReason}
                      autoComplete="off"
                      onChange={(event) => {
                        setReverseReason(event.target.value);
                      }}
                    />
                  </div>
                  <Button
                    variant="danger"
                    data-testid="reverse-usage"
                    disabled={reverseReason.trim() === '' || reverse.isPending}
                    onClick={() => {
                      reverse.mutate(openUsage.id);
                    }}
                  >
                    Reverse this usage
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-fg-muted">
                  Reversing a usage needs <code>inventory.consignment.approve</code>, which is deliberately
                  not the key that records one.
                </p>
              )}
            </div>
          )}
        </div>
      ) : null}

      {tab === 'agreements' ? (
        <div className="flex flex-col gap-3">
          <AsyncPanel
            loading={agreements.isPending}
            error={agreements.error}
            isEmpty={agreements.items.length === 0}
            skeletonLabel="Loading consignment agreements"
            skeletonRows={6}
            onRetry={agreements.refetch}
            empty={
              <EmptyState
                cause="No consignment agreements."
                nextAction="An agreement names the vendor, the items, the price paid on use and the replenishment SLA. Stock cannot be received without one."
              />
            }
          >
            <WorklistTable<DocumentView>
              rows={agreements.items}
              getRowId={(row) => row.id}
              labels={worklistLabels('Consignment agreements')}
              empty={{
                cause: 'No consignment agreements.',
                nextAction: 'Stock cannot be received without one.',
              }}
              hasMore={agreements.hasMore}
              loading={agreements.isFetching}
              onLoadMore={agreements.loadMore}
              columns={[
                {
                  key: 'document',
                  header: 'Agreement',
                  hideable: false,
                  render: (row) => <DocumentSummary document={row} />,
                },
                {
                  key: 'action',
                  header: 'Action',
                  render: (row) => (
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        data-testid={`open-agreement-${row.documentNo}`}
                        onClick={() => {
                          setOpenAgreementId(row.id === openAgreementId ? null : row.id);
                        }}
                      >
                        {row.id === openAgreementId ? 'Close' : 'Open'}
                      </Button>
                      {canApproveAgreement && row.status !== 'approved' ? (
                        <Button
                          data-testid={`approve-agreement-${row.documentNo}`}
                          disabled={approve.isPending}
                          onClick={() => {
                            approve.mutate(row.id);
                          }}
                        >
                          Approve
                        </Button>
                      ) : null}
                    </div>
                  ),
                },
              ]}
            />
          </AsyncPanel>

          {approve.error === null ? null : <ProblemCard error={approve.error} />}

          {openAgreementId === null ? null : (
            <AsyncPanel
              loading={openedAgreement.isPending}
              error={openedAgreement.error}
              isEmpty={false}
              skeletonLabel="Loading the agreement"
              skeletonRows={4}
              onRetry={() => {
                void openedAgreement.refetch();
              }}
              empty={<EmptyState cause="No agreement." nextAction="Pick one from the list." />}
            >
              {openedAgreement.data === undefined ? null : (
                <div
                  className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
                  data-testid="agreement-detail"
                >
                  <DocumentSummary document={openedAgreement.data} title="consignment agreement" />
                  <DocumentLinesTable
                    document={openedAgreement.data}
                    caption={`Items on agreement ${openedAgreement.data.documentNo}`}
                    extras={[
                      { header: 'Vendor price', keys: ['vendorPrice', 'vendor_price'], numeric: true },
                      { header: 'Min stock', keys: ['minStockBase', 'min_stock_base'], numeric: true },
                    ]}
                  />
                </div>
              )}
            </AsyncPanel>
          )}
        </div>
      ) : null}

      {tab === 'reconciliation' ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-fg-muted">
            Month-end. The hospital states what it used; the vendor agrees or disputes it; only then is an
            invoice raised. Both halves are recorded, including a disagreement.
          </p>

          {canReconcile ? (
            <div className="flex flex-wrap items-end gap-3 rounded-lg border border-strong bg-layer-1 p-4">
              <div className="flex min-w-40 flex-col gap-1">
                <Label htmlFor="recon-period">Period</Label>
                <Input
                  id="recon-period"
                  data-testid="recon-period"
                  value={period}
                  placeholder="YYYY-MM"
                  autoComplete="off"
                  onChange={(event) => {
                    setPeriod(event.target.value);
                  }}
                />
              </div>
              <div className="flex min-w-72 flex-col gap-1">
                <Label htmlFor="recon-agreement">Agreement</Label>
                <Input
                  id="recon-agreement"
                  data-testid="recon-agreement"
                  value={reconAgreementId}
                  autoComplete="off"
                  onChange={(event) => {
                    setReconAgreementId(event.target.value);
                  }}
                />
              </div>
              <div className="flex min-w-72 flex-col gap-1">
                <Label htmlFor="recon-vendor">Vendor</Label>
                <Input
                  id="recon-vendor"
                  data-testid="recon-vendor"
                  value={reconVendorId}
                  autoComplete="off"
                  onChange={(event) => {
                    setReconVendorId(event.target.value);
                  }}
                />
              </div>
              <Button
                data-testid="build-reconciliation"
                disabled={
                  buildReconciliation.isPending ||
                  reconAgreementId.trim() === '' ||
                  reconVendorId.trim() === '' ||
                  !/^\d{4}-\d{2}$/.test(period)
                }
                onClick={() => {
                  buildReconciliation.mutate();
                }}
              >
                Build the statement
              </Button>
            </div>
          ) : (
            <EmptyState
              cause="You cannot build a reconciliation."
              nextAction="inventory.consignment.reconcile is held by the purchase department and stores management."
            />
          )}

          {buildReconciliation.error === null ? null : <ProblemCard error={buildReconciliation.error} />}

          {reconciliation === null ? null : (
            <div
              className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
              data-testid="reconciliation-detail"
            >
              <DocumentSummary document={reconciliation} title={`period ${period}`} />
              <DocumentLinesTable
                document={reconciliation}
                caption={`Reconciliation lines for ${reconciliation.documentNo}`}
                extras={[{ header: 'Value', keys: ['value', 'amount'], numeric: true }]}
              />

              {sign.error === null ? null : <ProblemCard error={sign.error} />}

              {reconciliation.status === 'signed' ? (
                <Badge tone="neutral" className={statusTone('signed')}>
                  Signed — the vendor may invoice this period
                </Badge>
              ) : canSign ? (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="flex min-w-72 flex-col gap-1">
                      <Label htmlFor="signed-by">Vendor representative</Label>
                      <Input
                        id="signed-by"
                        data-testid="signed-by"
                        value={signedBy}
                        autoComplete="off"
                        onChange={(event) => {
                          setSignedBy(event.target.value);
                        }}
                      />
                    </div>
                    <div className="flex min-w-72 flex-1 flex-col gap-1">
                      <Label htmlFor="sign-note">Note</Label>
                      <Input
                        id="sign-note"
                        data-testid="sign-note"
                        value={signNote}
                        autoComplete="off"
                        onChange={(event) => {
                          setSignNote(event.target.value);
                        }}
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      data-testid="sign-agreed"
                      disabled={signedBy.trim() === '' || sign.isPending}
                      onClick={() => {
                        sign.mutate(true);
                      }}
                    >
                      The vendor agrees
                    </Button>
                    <Button
                      variant="danger"
                      data-testid="sign-disputed"
                      disabled={signedBy.trim() === '' || sign.isPending}
                      onClick={() => {
                        sign.mutate(false);
                      }}
                    >
                      The vendor disputes it
                    </Button>
                  </div>
                  <p className="text-2xs text-fg-subtle">
                    A dispute is recorded, not discarded — it is the evidence behind a credit note.
                  </p>
                </div>
              ) : (
                <p className="text-sm text-fg-muted">
                  Signing needs <code>inventory.consignment.sign</code>. Building the statement and agreeing
                  it are deliberately different hands.
                </p>
              )}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
