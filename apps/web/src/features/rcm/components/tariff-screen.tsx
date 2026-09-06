'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, WorklistTable, useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { formatDate, formatInstant, formatMoney, humanise } from '@/features/pharmacy/lib/format';
import {
  listItems,
  listPlans,
  listVersions,
  publishVersion,
  resolveRate,
  submitVersion,
} from '../api/client';
import { rcmKeys } from '../api/keys';
import type { RateResolution, TariffItemView, TariffPlanView, TariffVersionView } from '../api/types';

/**
 * RC-003 — the tariff console.
 *
 * ── The screen is organised around "which price applies", not around CRUD ───
 *
 * A rate grid is a spreadsheet, and a spreadsheet with a save button is the
 * easiest possible screen to build and the wrong one. The question finance
 * actually asks is *which* of several plans priced a line and *why*, and the
 * question a receptionist asks at the counter is what a patient will pay. So the
 * console leads with the plan list and its live version, and carries a rate
 * checker that answers both — including when the answer is "nothing".
 *
 * ── Submit and publish are rendered as different acts ───────────────────────
 *
 * They are different permissions held by different roles and carry a `block`
 * segregation rule, so most people see exactly one of the two buttons. Rendering
 * them side by side would suggest a single workflow one person walks through,
 * which is precisely what RC-003 §5's "requester ≠ approver" forbids. The button
 * you cannot press is therefore not disabled, it is absent, and a sentence says
 * who holds it.
 *
 * ── A miss is shown as an answer, not as an error ───────────────────────────
 *
 * `MISSING_RATE` comes back 200 with an explanation chain. Rendering it in a red
 * error card would teach people to dismiss it; it is a finding — a service being
 * delivered with no price — and it reads as one.
 */
export function TariffScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = rcmKeys(hospitalId);
  const { publish } = useToast();

  const [openPlanId, setOpenPlanId] = useState<string | null>(null);
  const [openVersionId, setOpenVersionId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [checkServiceId, setCheckServiceId] = useState('');
  const [checkAt, setCheckAt] = useState(new Date().toISOString().slice(0, 10));
  const [checked, setChecked] = useState<RateResolution | null>(null);

  const canSubmit = granted.has('tariff.version.submit');
  const canPublish = granted.has('tariff.version.publish');
  const canResolve = granted.has('tariff.rate.resolve');
  const canSeeItems = granted.has('tariff.item.list');

  const plans = useQuery({
    queryKey: keys.plans('all', 'active'),
    queryFn: ({ signal }) => listPlans({ status: 'active' }, { signal }),
  });

  const versions = useQuery({
    queryKey: keys.versions(openPlanId ?? 'none'),
    queryFn: ({ signal }) =>
      openPlanId === null ? Promise.reject(new Error('no plan')) : listVersions(openPlanId, { signal }),
    enabled: openPlanId !== null,
  });

  const items = useQuery({
    queryKey: keys.items(openVersionId ?? 'none'),
    queryFn: ({ signal }) =>
      openVersionId === null ? Promise.reject(new Error('no version')) : listItems(openVersionId, { signal }),
    enabled: openVersionId !== null && canSeeItems,
  });

  const submit = useMutation({
    mutationFn: (id: string) => submitVersion(id, { reason }),
    onSuccess: () => {
      void versions.refetch();
      setReason('');
      publish({ title: 'Sent for approval', severity: 'success' });
    },
  });

  const doPublish = useMutation({
    mutationFn: (id: string) => publishVersion(id, { reason }),
    onSuccess: () => {
      void versions.refetch();
      void plans.refetch();
      setReason('');
      publish({
        title: 'Version published',
        description: 'From its effective date this version prices every bill line in its window.',
        severity: 'success',
      });
    },
  });

  const check = useMutation({
    mutationFn: () => resolveRate({ serviceId: checkServiceId, at: checkAt }),
    onSuccess: (result) => {
      setChecked(result);
    },
  });

  const planRows = plans.data?.items ?? [];
  const versionRows = versions.data?.items ?? [];
  const itemRows = items.data?.items ?? [];

  return (
    <section className="flex flex-col gap-4" data-testid="tariff-screen">
      <PageHeader
        eyebrow="RC-003 · tariff"
        title="Tariff"
        description="The pricing authority. Every bill line, estimate and pre-auth resolves its rate here — and a service with no rate holds the line rather than billing at zero."
      />

      <AsyncPanel
        loading={plans.isPending}
        error={plans.error}
        isEmpty={planRows.length === 0}
        skeletonLabel="Loading rate plans"
        skeletonRows={5}
        onRetry={() => {
          void plans.refetch();
        }}
        empty={
          <EmptyState
            cause="No rate plans are configured."
            nextAction="Until at least one plan has a published version, nothing can be priced and every bill line is held."
          />
        }
      >
        <WorklistTable<TariffPlanView>
          rows={planRows}
          getRowId={(row) => row.id}
          labels={{
            caption: 'Rate plans',
            scrollRegion: 'Rate plans — scrollable list',
            selectAll: 'Select every row on this page',
            selectRow: 'Select this row',
            sortAscending: 'Sorted oldest first',
            sortDescending: 'Sorted newest first',
            notSorted: 'Not sorted by this column',
            density: 'Row height',
            densityOption: {
              compact: 'Compact — more rows on screen',
              default: 'Default',
              touch: 'Touch — larger targets for a tablet',
            },
            columns: 'Choose columns',
            savedView: 'Saved view',
            savedViewPlaceholder: 'No saved view',
            saveView: 'Save this view',
            loadMore: 'Load the next page',
            loading: 'Loading the next page…',
            selectedCount: (count: number) => `${String(count)} selected`,
            clearSelection: 'Clear the selection',
            rowCount: (count: number) => `${String(count)} on this page`,
            expandRow: 'Show the remaining columns for this row',
            rowActions: 'Actions for this row',
          }}
          empty={{ cause: 'No rate plans.', nextAction: 'Nothing can be priced until one exists.' }}
          columns={[
            {
              key: 'plan',
              header: 'Plan',
              hideable: false,
              render: (row) => (
                <span>
                  <span className="font-mono text-xs">{row.code}</span>
                  <span className="ms-2">{row.name}</span>
                  {row.isDefaultSelfPay ? (
                    <Badge tone="neutral" className="ms-2">
                      default self-pay
                    </Badge>
                  ) : null}
                </span>
              ),
            },
            { key: 'type', header: 'Kind', render: (row) => humanise(row.planType) },
            {
              key: 'derived',
              header: 'Derived',
              render: (row) =>
                row.derivedFromPlanId === null ? (
                  <span className="text-fg-subtle">own grid</span>
                ) : (
                  <span className="text-fg-muted">from another plan</span>
                ),
            },
            {
              key: 'live',
              header: 'Live version',
              render: (row) =>
                row.publishedVersionId === null ? (
                  <Badge tone="warning">nothing published</Badge>
                ) : (
                  <Badge tone="success">published</Badge>
                ),
            },
            {
              key: 'action',
              header: 'Action',
              render: (row) => (
                <Button
                  variant="ghost"
                  data-testid={`open-plan-${row.code}`}
                  onClick={() => {
                    setOpenPlanId(row.id === openPlanId ? null : row.id);
                    setOpenVersionId(null);
                  }}
                >
                  {row.id === openPlanId ? 'Close' : 'Versions'}
                </Button>
              ),
            },
          ]}
        />
      </AsyncPanel>

      {openPlanId === null ? null : (
        <AsyncPanel
          loading={versions.isPending}
          error={versions.error}
          isEmpty={versionRows.length === 0}
          skeletonLabel="Loading versions"
          skeletonRows={3}
          onRetry={() => {
            void versions.refetch();
          }}
          empty={
            <EmptyState
              cause="This plan has no versions."
              nextAction="A plan prices nothing until a version is created, filled and published."
            />
          }
        >
          <div className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
            <h2 className="text-sm font-semibold">Versions</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Versions of the selected rate plan</caption>
                <thead>
                  <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                    <th scope="col" className="px-3 py-2 text-start">
                      Version
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Effective
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Status
                    </th>
                    <th scope="col" className="px-3 py-2 text-end">
                      Rates
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {versionRows.map((v: TariffVersionView) => (
                    <tr key={v.id} className="border-b border-default last:border-0">
                      <td className="px-3 py-2 font-mono text-2xs">v{v.versionNo}</td>
                      <td className="px-3 py-2 text-2xs">
                        {formatDate(v.effectiveFrom)}
                        {v.effectiveTo === null ? ' →' : ` → ${formatDate(v.effectiveTo)}`}
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={v.status === 'published' ? 'success' : 'neutral'}>
                          {humanise(v.status)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-end font-mono">{v.itemCount}</td>
                      <td className="px-3 py-2">
                        <Button
                          variant="ghost"
                          data-testid={`open-version-${String(v.versionNo)}`}
                          onClick={() => {
                            setOpenVersionId(v.id === openVersionId ? null : v.id);
                          }}
                        >
                          {v.id === openVersionId ? 'Close' : 'Rates'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {submit.error === null ? null : <ProblemCard error={submit.error} />}
            {doPublish.error === null ? null : <ProblemCard error={doPublish.error} />}

            {openVersionId === null ? null : (
              <div className="flex flex-wrap items-end gap-3 border-t border-default pt-3">
                <div className="flex min-w-72 flex-1 flex-col gap-1">
                  <Label htmlFor="tariff-reason">Reason</Label>
                  <Input
                    id="tariff-reason"
                    data-testid="tariff-reason"
                    value={reason}
                    autoComplete="off"
                    onChange={(event) => {
                      setReason(event.target.value);
                    }}
                  />
                </div>
                {canSubmit ? (
                  <Button
                    data-testid="submit-version"
                    disabled={reason.trim() === '' || submit.isPending}
                    onClick={() => {
                      submit.mutate(openVersionId);
                    }}
                  >
                    Send for approval
                  </Button>
                ) : null}
                {canPublish ? (
                  <Button
                    data-testid="publish-version"
                    disabled={reason.trim() === '' || doPublish.isPending}
                    onClick={() => {
                      doPublish.mutate(openVersionId);
                    }}
                  >
                    Publish
                  </Button>
                ) : null}
                {!canSubmit && !canPublish ? (
                  <p className="text-sm text-fg-muted">
                    Changing what is live needs <code>tariff.version.submit</code> or{' '}
                    <code>tariff.version.publish</code>. They are deliberately held by different people.
                  </p>
                ) : null}
              </div>
            )}
          </div>
        </AsyncPanel>
      )}

      {openVersionId === null || !canSeeItems ? null : (
        <AsyncPanel
          loading={items.isPending}
          error={items.error}
          isEmpty={itemRows.length === 0}
          skeletonLabel="Loading the rate grid"
          skeletonRows={8}
          onRetry={() => {
            void items.refetch();
          }}
          empty={
            <EmptyState
              cause="This version has no rates."
              nextAction="A version with no rates prices nothing. Add rows before submitting it."
            />
          }
        >
          <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
            <table className="w-full text-sm" data-testid="rate-grid">
              <caption className="sr-only">The rate grid of the selected version</caption>
              <thead>
                <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  <th scope="col" className="px-3 py-2 text-start">
                    Service
                  </th>
                  <th scope="col" className="px-3 py-2 text-end">
                    Rate
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    Tax
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    HSN / SAC
                  </th>
                </tr>
              </thead>
              <tbody>
                {itemRows.map((i: TariffItemView) => (
                  <tr key={i.id} className="border-b border-default last:border-0">
                    <td className="px-3 py-2">
                      <span className="font-mono text-2xs text-fg-muted">{i.serviceCode}</span>
                      <span className="ms-2">{i.serviceName}</span>
                    </td>
                    <td className="px-3 py-2 text-end font-mono">{formatMoney(i.baseRate)}</td>
                    <td className="px-3 py-2 text-2xs">
                      {i.taxTreatment === 'taxable' ? (
                        <Badge tone="warning">GST {i.gstRate}%</Badge>
                      ) : (
                        <span className="text-fg-muted">{humanise(i.taxTreatment)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-2xs text-fg-muted">{i.hsnSac ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AsyncPanel>
      )}

      {canResolve ? (
        <div
          className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
          data-testid="rate-checker"
        >
          <h2 className="text-sm font-semibold">Rate checker</h2>
          <p className="text-sm text-fg-muted">
            Asks the same resolver a bill line uses, and shows the chain it walked. A service with no rate
            answers here too — that answer is the finding, not an error.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-72 flex-1 flex-col gap-1">
              <Label htmlFor="check-service">Service</Label>
              <Input
                id="check-service"
                data-testid="check-service"
                value={checkServiceId}
                autoComplete="off"
                onChange={(event) => {
                  setCheckServiceId(event.target.value);
                }}
              />
            </div>
            <div className="flex min-w-40 flex-col gap-1">
              <Label htmlFor="check-at">On date</Label>
              <Input
                id="check-at"
                data-testid="check-at"
                value={checkAt}
                autoComplete="off"
                onChange={(event) => {
                  setCheckAt(event.target.value);
                }}
              />
            </div>
            <Button
              data-testid="check-rate"
              disabled={checkServiceId.trim() === '' || check.isPending}
              onClick={() => {
                check.mutate();
              }}
            >
              Resolve
            </Button>
          </div>

          {check.error === null ? null : <ProblemCard error={check.error} />}

          {checked === null ? null : (
            <div className="flex flex-col gap-2" data-testid="rate-result">
              {checked.outcome === 'resolved' ? (
                <p className="text-md">
                  <strong className="font-mono">{formatMoney(checked.rate)}</strong>{' '}
                  <span className="text-fg-muted">
                    from {checked.planCode}
                    {checked.appliedRules.length === 0
                      ? ''
                      : ` (list ${formatMoney(checked.listRate)}, ${checked.appliedRules.join(', ')})`}
                  </span>
                </p>
              ) : (
                <div className="rounded-md border border-warning-border bg-warning-surface p-3">
                  <p className="text-sm font-semibold text-warning-on-surface">No rate applies</p>
                  <p className="text-sm text-warning-on-surface">{checked.message}</p>
                </div>
              )}
              <ol className="flex flex-col gap-1 text-2xs text-fg-subtle">
                {checked.chain.map((step, index) => (
                  <li key={`${step.stage}-${String(index)}`}>
                    <span className="font-mono">{step.matched ? '✓' : '✕'}</span>{' '}
                    <span className="font-mono">{step.stage}</span> — {step.detail}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      ) : null}

      <p className="text-2xs text-fg-subtle">
        A published version is immutable: the database refuses an edit to one, so a bill raised two years ago
        can still be explained by the rate that priced it. Corrections are new versions.{' '}
        {plans.dataUpdatedAt === 0 ? null : <>Last read {formatInstant(new Date().toISOString())}.</>}
      </p>
    </section>
  );
}
