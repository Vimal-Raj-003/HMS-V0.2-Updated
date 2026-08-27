'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, WorklistTable, useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { approveVendor, getVendor, listRateContracts, listVendors } from '../api/client';
import { inventoryKeys } from '../api/keys';
import type { VendorView } from '../api/types';
import { useCursorList } from '../lib/cursor-list';
import { worklistLabels } from '../lib/worklist-labels';
import { statusTone } from '../lib/documents';
import { formatDate, formatMoney, humanise } from '@/features/pharmacy/lib/format';

/**
 * NC-021 — the vendor master.
 *
 * ── The two dates that stop a delivery ──────────────────────────────────────
 *
 * A drug licence with a past validity date and a blacklist that has not expired
 * are both reasons a receipt should not happen, and both are easy to miss in a
 * table of twenty columns. So they get their own chips with words on them, and
 * the licence date is rendered in red once it is behind us rather than being one
 * more grey date.
 *
 * ── Maker ≠ checker, at the row level ───────────────────────────────────────
 *
 * `vendor.master.approve` is a different key from `vendor.master.manage`, *and*
 * `VendorsService.approve` refuses the specific person who created the record.
 * The key split alone would let one person hold both; the row check alone would
 * make the control invisible in the role matrix. The screen offers the button
 * and lets the refusal arrive with its reason.
 *
 * ── The PAN is masked and stays masked ──────────────────────────────────────
 *
 * The API returns `panMasked` and nothing else. There is no unmasked field to
 * render, which is the right shape: a purchase clerk needs to recognise a PAN,
 * not to read one out.
 */
const STATUSES: readonly { readonly value: string; readonly label: string }[] = [
  { value: '', label: 'Every status' },
  { value: 'pending_approval', label: 'Waiting for approval' },
  { value: 'approved', label: 'Approved' },
  { value: 'hold', label: 'On hold' },
  { value: 'watch_list', label: 'Watch list' },
  { value: 'blacklisted', label: 'Blacklisted' },
  { value: 'inactive', label: 'Inactive' },
];

export function VendorsScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = inventoryKeys(hospitalId);
  const { publish } = useToast();

  const [term, setTerm] = useState('');
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const canApprove = granted.has('vendor.master.approve');
  const canSeeContracts = granted.has('vendor.contract.list');
  const now = new Date();

  const vendors = useCursorList<VendorView>({
    queryKey: keys.vendors(term, status === '' ? 'all' : status, 'paged'),
    fetchPage: (cursor, signal) =>
      listVendors(
        { q: term === '' ? undefined : term, status: status === '' ? undefined : status, cursor },
        signal === undefined ? {} : { signal },
      ),
  });

  const opened = useQuery({
    queryKey: keys.vendor(openId ?? 'none'),
    queryFn: ({ signal }) =>
      openId === null ? Promise.reject(new Error('no vendor')) : getVendor(openId, { signal }),
    enabled: openId !== null,
  });

  const contracts = useQuery({
    queryKey: keys.rateContracts(openId ?? 'none'),
    queryFn: ({ signal }) =>
      openId === null ? Promise.reject(new Error('no vendor')) : listRateContracts(openId, { signal }),
    enabled: openId !== null && canSeeContracts,
  });

  const approve = useMutation({
    mutationFn: (id: string) => approveVendor(id, undefined),
    onSuccess: () => {
      void opened.refetch();
      vendors.refetch();
      publish({ title: 'Vendor approved', severity: 'success' });
    },
  });

  const vendor = opened.data ?? null;
  const licenceExpired =
    vendor?.drugLicenceValidTo != null && Date.parse(vendor.drugLicenceValidTo) < now.getTime();

  return (
    <section className="flex flex-col gap-4" data-testid="vendors-screen">
      <PageHeader
        eyebrow="NC-021 · vendors"
        title="Vendors"
        description="Who the hospital buys from, what their licences say, and the maker-checker approval the service refuses to let one person do alone."
        actions={
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-56 flex-col gap-1">
              <Label htmlFor="vendor-search">Search</Label>
              <Input
                id="vendor-search"
                data-testid="vendor-search"
                value={term}
                autoComplete="off"
                onChange={(event) => {
                  setTerm(event.target.value);
                }}
              />
            </div>
            <div className="flex min-w-48 flex-col gap-1">
              <Label htmlFor="vendor-status">Status</Label>
              <select
                id="vendor-status"
                data-testid="vendor-status"
                className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                }}
              >
                {STATUSES.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        }
      />

      <AsyncPanel
        loading={vendors.isPending}
        error={vendors.error}
        isEmpty={vendors.items.length === 0}
        skeletonLabel="Loading vendors"
        skeletonRows={8}
        onRetry={vendors.refetch}
        empty={
          <EmptyState
            cause={term === '' ? 'No vendor matches this filter.' : `No vendor matches "${term}".`}
            nextAction="Try the trade name as well as the legal one. A new supplier has to be onboarded and approved by two different people before an order can be raised on them."
          />
        }
      >
        <WorklistTable<VendorView>
          rows={vendors.items}
          getRowId={(row) => row.id}
          labels={worklistLabels('Vendor master')}
          empty={{ cause: 'No vendor matches this filter.', nextAction: 'Try the trade name.' }}
          hasMore={vendors.hasMore}
          loading={vendors.isFetching}
          onLoadMore={vendors.loadMore}
          onRowOpen={(row) => {
            setOpenId(row.id);
          }}
          criticalRowIds={
            new Set(
              vendors.items
                .filter(
                  (row) =>
                    row.status === 'blacklisted' ||
                    (row.drugLicenceValidTo !== null && Date.parse(row.drugLicenceValidTo) < now.getTime()),
                )
                .map((row) => row.id),
            )
          }
          columns={[
            {
              key: 'code',
              header: 'Code',
              hideable: false,
              render: (row) => <span className="font-mono text-xs">{row.vendorCode}</span>,
            },
            {
              key: 'name',
              header: 'Vendor',
              hideable: false,
              render: (row) => (
                <span>
                  {row.legalName}
                  {row.tradeName === null ? null : (
                    <span className="ms-2 text-2xs text-fg-subtle">{row.tradeName}</span>
                  )}
                </span>
              ),
            },
            { key: 'type', header: 'Kind', render: (row) => humanise(row.vendorType) },
            { key: 'gstin', header: 'GSTIN', render: (row) => row.primaryGstin ?? '—' },
            {
              key: 'licence',
              header: 'Drug licence',
              hideable: false,
              render: (row) => {
                if (row.drugLicenceValidTo === null) return <span className="text-fg-subtle">none</span>;
                const expired = Date.parse(row.drugLicenceValidTo) < now.getTime();
                return (
                  <span className={expired ? 'text-danger-fg' : 'text-fg-muted'}>
                    {formatDate(row.drugLicenceValidTo)}
                    {expired ? ' — expired' : ''}
                  </span>
                );
              },
            },
            {
              key: 'status',
              header: 'Status',
              hideable: false,
              render: (row) => (
                <Badge tone="neutral" className={statusTone(row.status)}>
                  {humanise(row.status)}
                </Badge>
              ),
            },
            {
              key: 'credit',
              header: 'Credit days',
              numeric: true,
              importance: 'secondary',
              render: (row) => row.creditDays,
            },
            {
              key: 'lead',
              header: 'Lead time',
              numeric: true,
              importance: 'secondary',
              render: (row) => (row.leadTimeDaysAvg === null ? '—' : `${row.leadTimeDaysAvg} d`),
            },
            {
              key: 'score',
              header: 'Score',
              numeric: true,
              importance: 'secondary',
              render: (row) => row.lastScore ?? '—',
            },
          ]}
        />
      </AsyncPanel>

      {openId === null ? (
        <EmptyState
          cause="No vendor opened."
          nextAction="Open a row above to see its licences, its rate contracts and its approval state."
        />
      ) : (
        <AsyncPanel
          loading={opened.isPending}
          error={opened.error}
          isEmpty={vendor === null}
          skeletonLabel="Loading the vendor"
          skeletonRows={4}
          onRetry={() => void opened.refetch()}
          empty={
            <EmptyState
              cause="That vendor could not be read."
              nextAction="It may belong to another hospital in the group. Try one from the list above."
            />
          }
        >
          {vendor === null ? null : (
            <section
              className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
              data-testid="vendor-detail"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold text-fg-default">{vendor.legalName}</h2>
                <span className="font-mono text-sm text-fg-subtle">{vendor.vendorCode}</span>
                <Badge tone="neutral" className={statusTone(vendor.status)}>
                  {humanise(vendor.status)}
                </Badge>
                {vendor.blacklistedUntil === null ? null : (
                  <Badge tone="danger">Blacklisted until {formatDate(vendor.blacklistedUntil)}</Badge>
                )}
                {licenceExpired ? <Badge tone="danger">Drug licence expired</Badge> : null}
              </div>

              {vendor.statusReason === null ? null : (
                <p className="text-sm text-fg-muted">{vendor.statusReason}</p>
              )}

              <dl className="grid grid-cols-2 gap-3 text-2xs text-fg-muted sm:grid-cols-4">
                <div>
                  <dt className="text-fg-subtle">Kind</dt>
                  <dd>{humanise(vendor.vendorType)}</dd>
                </div>
                <div>
                  <dt className="text-fg-subtle">GST registration</dt>
                  <dd className="font-mono">
                    {vendor.primaryGstin ?? '—'} ({humanise(vendor.gstType)})
                  </dd>
                </div>
                <div>
                  <dt className="text-fg-subtle">PAN</dt>
                  <dd className="font-mono">{vendor.panMasked ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-fg-subtle">Drug licence</dt>
                  <dd className={`font-mono ${licenceExpired ? 'text-danger-fg' : ''}`}>
                    {vendor.drugLicenceNo ?? '—'} · valid to {formatDate(vendor.drugLicenceValidTo)}
                  </dd>
                </div>
                <div>
                  <dt className="text-fg-subtle">Credit days</dt>
                  <dd className="font-mono">{vendor.creditDays}</dd>
                </div>
                <div>
                  <dt className="text-fg-subtle">Average lead time</dt>
                  <dd className="font-mono">
                    {vendor.leadTimeDaysAvg === null ? '—' : `${vendor.leadTimeDaysAvg} days`}
                  </dd>
                </div>
                <div>
                  <dt className="text-fg-subtle">Risk rating</dt>
                  <dd>{humanise(vendor.riskRating)}</dd>
                </div>
                <div>
                  <dt className="text-fg-subtle">Last score</dt>
                  <dd className="font-mono">{vendor.lastScore ?? 'never scored'}</dd>
                </div>
              </dl>

              {vendor.categories.length === 0 ? null : (
                <ul className="flex flex-wrap gap-1">
                  {vendor.categories.map((category) => (
                    <li key={category}>
                      <Badge tone="neutral">{category}</Badge>
                    </li>
                  ))}
                </ul>
              )}

              {vendor.status === 'pending_approval' ? (
                canApprove ? (
                  <div className="flex flex-col gap-2">
                    <Button
                      variant="primary"
                      className="self-start"
                      data-testid="approve-vendor"
                      disabled={approve.isPending}
                      onClick={() => {
                        approve.mutate(vendor.id);
                      }}
                    >
                      {approve.isPending ? 'Approving…' : 'Approve this vendor'}
                    </Button>
                    <p className="text-2xs text-fg-muted">
                      The service refuses this if you are the person who created the record. That is not a bug
                      in the button; it is the control.
                    </p>
                    {approve.error === null ? null : <ProblemCard error={approve.error} />}
                  </div>
                ) : (
                  <p className="text-sm text-fg-muted">
                    Approving a vendor needs <span className="font-mono">vendor.master.approve</span>, which
                    is deliberately not the key that creates one.
                  </p>
                )
              ) : null}

              <section className="flex flex-col gap-2">
                <h3 className="font-display text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  Rate contracts
                </h3>
                {!canSeeContracts ? (
                  <p className="text-sm text-fg-muted">
                    Seeing rate contracts needs <span className="font-mono">vendor.contract.list</span>.
                  </p>
                ) : (
                  <AsyncPanel
                    loading={contracts.isPending}
                    error={contracts.error}
                    isEmpty={(contracts.data?.items ?? []).length === 0}
                    skeletonLabel="Loading rate contracts"
                    skeletonRows={3}
                    onRetry={() => void contracts.refetch()}
                    empty={
                      <EmptyState
                        cause="This vendor has no rate contract."
                        nextAction="Every order on them will be priced from its own quotation rather than from an agreed rate."
                      />
                    }
                  >
                    <ul className="flex flex-col gap-1">
                      {(contracts.data?.items ?? []).map((contract) => (
                        <li key={contract.id} className="flex flex-wrap justify-between gap-2 text-sm">
                          <span className="text-fg-default">
                            <span className="font-mono text-2xs">{contract.contractNo}</span> {contract.title}
                          </span>
                          <span className="font-mono text-2xs text-fg-muted">
                            {formatDate(contract.validFrom)} → {formatDate(contract.validTo)} ·{' '}
                            {contract.lineCount} line(s) · cap {formatMoney(contract.maxValue)} ·{' '}
                            {humanise(contract.status)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </AsyncPanel>
                )}
              </section>
            </section>
          )}
        </AsyncPanel>
      )}
    </section>
  );
}
