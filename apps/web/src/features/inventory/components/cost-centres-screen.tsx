'use client';

import { useQuery } from '@tanstack/react-query';
import { EmptyState, Input, Label, WorklistTable } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { formatMoney, humanise } from '@/features/pharmacy/lib/format';
import { listCostCentreConsumption, listCostCentres } from '../api/client';
import { inventoryKeys } from '../api/keys';
import type { CostCentreConsumptionRow, CostCentreView } from '../api/types';
import { boundedList, useCursorList } from '../lib/cursor-list';
import { worklistLabels } from '../lib/worklist-labels';
import { lastClosedPeriod } from './consignment-screen';

/**
 * NC-008 — the cost-centre half.
 *
 * ── Why this is not a tab on the consumption screen ─────────────────────────
 *
 * It was, briefly, and testing it as an accountant showed why that was wrong:
 * the consumption console is gated on `inventory.consumption.list`, which the
 * finance roles do not hold, so the person the roll-up exists for could not
 * reach it. The rule this repo already follows — a screen is gated on the key of
 * the list it loads first — is not a style preference; a screen carrying two
 * permission domains is unreachable by half the people who need it.
 *
 * So the transaction lives with stores (`inventory.consumption.list`) and the
 * money lives with finance (`finance.costcentre.read`), on two screens that read
 * the same rows from two ends.
 *
 * ── The unattributed row is shown, never dropped ────────────────────────────
 *
 * Consumption that nobody costed still left the shelf. A roll-up that silently
 * omitted it would not reconcile against what stores issued, and the gap would
 * be discovered at year end rather than at month end.
 */
export function CostCentresScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = inventoryKeys(hospitalId);

  const [tab, setTab] = useState<'rollup' | 'master'>('rollup');
  const [period, setPeriod] = useState(lastClosedPeriod());
  const periodIsValid = /^\d{4}-\d{2}$/.test(period);

  const rollupQuery = useQuery({
    queryKey: keys.costCentreConsumption(period),
    queryFn: ({ signal }) => listCostCentreConsumption(period, { signal }),
    enabled: tab === 'rollup' && periodIsValid,
  });
  const rollup = boundedList<CostCentreConsumptionRow>(rollupQuery.data, {
    isPending: rollupQuery.isPending,
    isFetching: rollupQuery.isFetching,
    error: rollupQuery.error,
    refetch: () => {
      void rollupQuery.refetch();
    },
  });

  const centres = useCursorList<CostCentreView>({
    queryKey: keys.costCentres('all', 'paged'),
    fetchPage: (cursor, signal) => listCostCentres({ cursor }, signal === undefined ? {} : { signal }),
    enabled: tab === 'master',
  });

  const rollupTotal = rollup.items.reduce((total, row) => total + Number(row.value), 0);

  return (
    <section className="flex flex-col gap-4" data-testid="cost-centres-screen">
      <PageHeader
        eyebrow="NC-008 · cost centres"
        title="Cost centres"
        description="What each ward, theatre and department consumed in a period, and the cost-centre master behind the attribution."
      />

      <nav aria-label="Cost centre views" className="flex flex-wrap gap-1 border-b border-default">
        {(
          [
            { key: 'rollup', label: 'Consumption by centre' },
            { key: 'master', label: 'Cost centre master' },
          ] as const
        ).map((entry) => (
          <button
            key={entry.key}
            type="button"
            data-testid={`cost-centre-tab-${entry.key}`}
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

      {tab === 'rollup' ? (
        <div className="flex flex-col gap-3">
          <div className="flex min-w-40 max-w-xs flex-col gap-1">
            <Label htmlFor="rollup-period">Period</Label>
            <Input
              id="rollup-period"
              data-testid="rollup-period"
              value={period}
              placeholder="YYYY-MM"
              autoComplete="off"
              onChange={(event) => {
                setPeriod(event.target.value);
              }}
            />
          </div>

          {periodIsValid ? null : (
            <p className="text-sm text-fg-muted">A period is four digits, a hyphen and two digits.</p>
          )}

          {periodIsValid ? (
            <AsyncPanel
              loading={rollup.isPending}
              error={rollup.error}
              isEmpty={rollup.items.length === 0}
              skeletonLabel="Loading the cost-centre roll-up"
              skeletonRows={6}
              onRetry={rollup.refetch}
              empty={
                <EmptyState
                  cause={`Nothing was consumed in ${period}.`}
                  nextAction="Either the period is still open and nothing has been recorded yet, or it is the wrong month."
                />
              }
            >
              <div className="flex flex-col gap-3">
                <p className="text-sm text-fg-muted" data-testid="rollup-total">
                  {rollup.items.length} cost centre{rollup.items.length === 1 ? '' : 's'} consumed{' '}
                  <strong className="text-fg-default">{formatMoney(String(rollupTotal))}</strong> in {period}.
                </p>
                <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
                  <table className="w-full text-sm">
                    <caption className="sr-only">Consumption by cost centre for {period}</caption>
                    <thead>
                      <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                        <th scope="col" className="px-3 py-2 text-start">
                          Cost centre
                        </th>
                        <th scope="col" className="px-3 py-2 text-start">
                          Code
                        </th>
                        <th scope="col" className="px-3 py-2 text-end">
                          Entries
                        </th>
                        <th scope="col" className="px-3 py-2 text-end">
                          Value
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rollup.items.map((row) => (
                        <tr
                          key={row.costCentreId ?? 'unattributed'}
                          className="border-b border-default last:border-0"
                        >
                          <td className="px-3 py-2">
                            {row.name ?? (
                              <span className="text-fg-muted">Not attributed to a cost centre</span>
                            )}
                          </td>
                          <td className="px-3 py-2 font-mono text-2xs text-fg-muted">{row.code ?? '—'}</td>
                          <td className="px-3 py-2 text-end font-mono">{row.entries}</td>
                          <td className="px-3 py-2 text-end font-mono">{formatMoney(row.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-2xs text-fg-subtle">
                  An unattributed row is consumption nobody costed. It is shown rather than dropped, because a
                  roll-up that silently omits it does not add up to what the stores issued.
                </p>
              </div>
            </AsyncPanel>
          ) : null}
        </div>
      ) : null}

      {tab === 'master' ? (
        <AsyncPanel
          loading={centres.isPending}
          error={centres.error}
          isEmpty={centres.items.length === 0}
          skeletonLabel="Loading cost centres"
          skeletonRows={8}
          onRetry={centres.refetch}
          empty={
            <EmptyState
              cause="No cost centres are defined."
              nextAction="Until one exists, consumption is recorded but cannot be attributed, and every entry lands in the unattributed row of the roll-up."
            />
          }
        >
          <WorklistTable<CostCentreView>
            rows={centres.items}
            getRowId={(row) => row.id}
            labels={worklistLabels('Cost centres')}
            empty={{
              cause: 'No cost centres are defined.',
              nextAction: 'Consumption cannot be attributed until one exists.',
            }}
            hasMore={centres.hasMore}
            loading={centres.isFetching}
            onLoadMore={centres.loadMore}
            columns={[
              {
                key: 'code',
                header: 'Code',
                hideable: false,
                render: (row) => <span className="font-mono text-xs">{row.code}</span>,
              },
              { key: 'name', header: 'Name', hideable: false, render: (row) => row.name },
              { key: 'type', header: 'Kind', render: (row) => humanise(row.centreType) },
              { key: 'basis', header: 'Allocation basis', render: (row) => humanise(row.allocationBasis) },
              { key: 'active', header: 'Status', render: (row) => (row.active ? 'Active' : 'Inactive') },
            ]}
          />
        </AsyncPanel>
      ) : null}
    </section>
  );
}
