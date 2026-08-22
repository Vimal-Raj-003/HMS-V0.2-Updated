'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  EmptyState,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  WorklistTable,
  type WorklistColumn,
  type WorklistTableLabels,
} from '@vims/ui';
import { useId, useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { getAlertFatigue } from '../api/client';
import { clinicalKeys } from '../api/keys';
import { familyLabel } from '../lib/cdss';
import { MIN_FIRES_FOR_RATE, familyRows, fatigueVerdict, reasonRows, type FamilyRow } from '../lib/fatigue';
import { overrideReasonLabel } from '../lib/override-reasons';

/**
 * Phase-02 exit gate 8 — "the alert-fatigue dashboard shows override rate; a
 * deliberately noisy rule can be tuned without a code change".
 *
 * ## What this screen is for
 *
 * Alert fatigue is not a UI problem, it is a governance one: the cost of a noisy
 * rule is paid by the *quiet* rule that gets dismissed with it. So the numbers
 * here are the ones a committee can act on — how loud each family is, how often
 * clinicians prescribe through it, and which reason they give — rather than a
 * leaderboard of doctors, which EN-029 §8 explicitly does not put on a public
 * dashboard.
 *
 * A rate over a handful of fires is noise dressed as evidence, so a family below
 * `MIN_FIRES_FOR_RATE` shows its counts and says the rate is not judgeable yet.
 *
 * ## The half of the gate this screen cannot deliver
 *
 * "…can be tuned without a code change" is true of the *system* — rules,
 * interruption levels and suppression are rows in `clinical.cdss_rules` — but
 * there is **no rule-catalogue API** in this build: no `GET /cdss/rules`, no
 * `PATCH /cdss/rules/{id}`, no shadow/disable endpoint. So this screen reports
 * and does not tune, and the tuning is done in the database until EN-029's rule
 * catalogue and builder are exposed. That is a reported gap.
 */

const TABLE_LABELS: WorklistTableLabels = {
  caption: 'Alert families in the window, loudest first',
  scrollRegion: 'Alert families',
  selectAll: 'Select all families',
  selectRow: 'Select this family',
  sortAscending: 'Sorted ascending',
  sortDescending: 'Sorted descending',
  notSorted: 'Not sorted',
  density: 'Row height',
  densityOption: { compact: 'Compact', default: 'Default', touch: 'Touch' },
  columns: 'Columns',
  savedView: 'Saved view',
  savedViewPlaceholder: 'Choose a view',
  saveView: 'Save this view',
  loadMore: 'Load more',
  loading: 'Loading',
  selectedCount: (count) => `${String(count)} selected`,
  clearSelection: 'Clear the selection',
  rowCount: (count) => `${String(count)} families`,
  expandRow: 'Show the rest of this row',
  rowActions: 'Actions for this family',
};

const WINDOWS = [1, 7, 14, 30] as const;

export function AlertFatigueScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = clinicalKeys(hospitalId);
  const windowId = useId();
  const [days, setDays] = useState<number>(7);

  const report = useQuery({
    queryKey: keys.fatigue(days),
    queryFn: ({ signal }) => getAlertFatigue(days, { signal }),
    staleTime: 60_000,
  });

  const data = report.data;
  const families = data === undefined ? [] : familyRows(data);
  const reasons = data === undefined ? [] : reasonRows(data);
  const verdict = data === undefined ? null : fatigueVerdict(data);

  const columns: readonly WorklistColumn<FamilyRow>[] = [
    {
      key: 'family',
      header: 'Rule family',
      importance: 'always',
      render: (row) => <span className="text-fg-default">{familyLabel(row.family)}</span>,
    },
    {
      key: 'fires',
      header: 'Fired',
      numeric: true,
      importance: 'always',
      render: (row) => <span className="tabular-nums">{row.fires}</span>,
    },
    {
      key: 'share',
      header: 'Share of all alerts',
      numeric: true,
      render: (row) => <span className="tabular-nums">{row.shareOfFiresPct}%</span>,
    },
    {
      key: 'overrides',
      header: 'Overridden',
      numeric: true,
      importance: 'always',
      render: (row) => <span className="tabular-nums">{row.overrides}</span>,
    },
    {
      key: 'rate',
      header: 'Override rate',
      numeric: true,
      importance: 'always',
      render: (row) =>
        row.overrideRatePct === null ? (
          <span className="text-2xs text-fg-muted" data-testid={`rate-unjudgeable-${row.family}`}>
            too few to judge
          </span>
        ) : (
          <Badge
            tone={row.overrideRatePct >= 50 ? 'danger' : row.overrideRatePct >= 25 ? 'warning' : 'success'}
            data-testid={`rate-${row.family}`}
          >
            {row.overrideRatePct}%
          </Badge>
        ),
    },
    {
      key: 'blocks',
      header: 'Blocked',
      numeric: true,
      // Hard stops are the column a governance committee must never lose from
      // the view: a rule that blocks is not one to tune away casually.
      hideable: false,
      render: (row) => <span className="tabular-nums">{row.blocks}</span>,
    },
  ];

  return (
    <section className="flex flex-col gap-4" data-testid="alert-fatigue">
      <PageHeader
        eyebrow="Clinical governance"
        title="Alert fatigue"
        description="How loud the safety rules are, and how often clinicians prescribe through them. The rule a clinician meets forty times a day is the one that trains them to dismiss the one that matters."
        meta={
          data === undefined ? null : (
            <>
              <Badge tone="neutral" data-testid="alerts-per-1000">
                {data.alertsPer1000Orders} alerts per 1000 orders
              </Badge>
              <Badge tone={verdict?.tone ?? 'neutral'} data-testid="override-rate">
                {data.overrideRatePct}% overridden
              </Badge>
              <Badge tone="neutral">{data.ordersEvaluated} orders evaluated</Badge>
            </>
          )
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={windowId}>Window</Label>
          <Select
            value={String(days)}
            onValueChange={(value) => {
              setDays(Number(value));
            }}
          >
            <SelectTrigger id={windowId} data-testid="fatigue-window" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WINDOWS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  Last {option} day{option === 1 ? '' : 's'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <AsyncPanel
        loading={report.isLoading}
        error={report.error}
        isEmpty={data !== undefined && data.fires === 0}
        skeletonLabel="Loading the alert-fatigue report"
        skeletonRows={6}
        onRetry={() => void report.refetch()}
        empty={
          <EmptyState
            cause="No safety alert fired in this window."
            nextAction="Widen the window, or check that prescribing has been going through this system for the period."
          />
        }
      >
        {data === undefined ? null : (
          <div className="flex flex-col gap-4">
            {verdict === null ? null : (
              <p
                role="status"
                data-testid="fatigue-verdict"
                className={
                  verdict.tone === 'danger'
                    ? 'rounded-md border border-danger-border bg-danger-surface p-3 text-sm text-danger-on-surface'
                    : verdict.tone === 'warning'
                      ? 'rounded-md border border-warning-border bg-warning-surface p-3 text-sm text-warning-on-surface'
                      : 'rounded-md border border-success-border bg-success-surface p-3 text-sm text-success-on-surface'
                }
              >
                {verdict.summary}
              </p>
            )}

            <dl className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="fatigue-totals">
              <Metric label="Fired" value={data.fires} />
              <Metric label="Shown to a clinician" value={data.displays} />
              <Metric label="Blocked an order" value={data.blocks} />
              <Metric label="Overridden" value={data.overrides} />
              <Metric label="Acknowledged" value={data.acknowledgements} />
            </dl>

            <WorklistTable
              rows={families}
              getRowId={(row) => row.family}
              columns={columns}
              labels={TABLE_LABELS}
              empty={{
                cause: 'No family fired in this window.',
                nextAction: 'Widen the window.',
              }}
            />

            <section aria-label="Override reasons" data-testid="override-reasons">
              <h2 className="text-md font-medium text-fg-default">Why clinicians prescribed through</h2>
              {reasons.length === 0 ? (
                <p className="mt-1 text-sm text-fg-muted">
                  Nothing was overridden in this window, so no reason was recorded.
                </p>
              ) : (
                <ul className="mt-2 flex flex-col gap-1">
                  {reasons.map((reason) => (
                    <li
                      key={reason.code}
                      className="flex flex-wrap items-center justify-between gap-2 text-sm"
                      data-testid={`reason-${reason.code}`}
                    >
                      <span className="text-fg-default">{overrideReasonLabel(reason.code)}</span>
                      <span className="tabular-nums text-fg-muted">
                        {reason.count} ({reason.sharePct}%)
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <p className="text-2xs text-fg-subtle">
              A rate is only shown for a family that fired at least {MIN_FIRES_FOR_RATE} times in the window —
              below that the percentage says more than it knows. Tuning a rule (shadow, disable, change the
              interruption level) is a database change today: this build exposes no rule-catalogue API.
            </p>
          </div>
        )}
      </AsyncPanel>
    </section>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: number }): React.JSX.Element {
  return (
    <div className="rounded-md border border-default bg-layer-1 p-3">
      <dt className="text-2xs text-fg-muted">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums text-fg-default">{value}</dd>
    </div>
  );
}
