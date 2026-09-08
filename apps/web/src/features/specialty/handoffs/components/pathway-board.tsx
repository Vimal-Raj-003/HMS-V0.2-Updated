'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState } from '@vims/ui';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { getPathways, getVarianceReport } from '../api/client';
import { handoffKeys } from '../api/keys';
import type { PathwayInstanceRow } from '../api/types';

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  clinical: 'Clinical — the patient needed something else',
  patient: 'Patient — they declined, or were not ready',
  system: 'System — the process did not deliver',
  resource: 'Resource — the person or the equipment was not there',
};

/**
 * IP-020 — the pathway board.
 *
 * ── The variance analysis is above the pathways, not below them ────────────
 *
 * A pathway that is followed tells you nothing. The variances are the data,
 * and a board that leads with a wall of green ticks buries the four numbers
 * that are the reason anybody wrote the pathway down.
 *
 * ── And one of the four categories is separated from the others ────────────
 *
 * A patient who declined is not a failure of the hospital. Counting that
 * departure alongside a missing physiotherapist makes a well-run pathway look
 * like a badly-run one, and the first thing anybody does with a number like
 * that is stop believing it.
 */
export function PathwayBoard(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = handoffKeys(hospitalId);

  const pathways = useQuery({
    queryKey: keys.pathways('open'),
    queryFn: ({ signal }) => getPathways({ openOnly: true }, { signal }),
    refetchInterval: 300_000,
  });

  const variance = useQuery({
    queryKey: keys.variance('all'),
    queryFn: ({ signal }) => getVarianceReport(undefined, { signal }),
    refetchInterval: 600_000,
  });

  const rows = pathways.data ?? [];
  const tallies = variance.data ?? [];
  const ours = tallies.filter((t) => t.hospitalOwned);
  const theirs = tallies.filter((t) => !t.hospitalOwned);
  const ourTotal = ours.reduce((sum, t) => sum + t.count, 0);

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Clinical pathways"
        description="A pathway that is followed tells you nothing. The variances are the data, and which of four kinds they are is the finding."
      />

      <section aria-label="Variance analysis" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Where the departures come from</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {ours.map((tally) => (
            <div
              key={tally.varianceCategory}
              className="rounded-lg border border-warning-border bg-warning-surface p-3"
            >
              <p className="text-2xl font-semibold text-warning-on-surface">{tally.count}</p>
              <p className="text-xs text-warning-on-surface">
                {CATEGORY_LABELS[tally.varianceCategory] ?? tally.varianceCategory}
              </p>
            </div>
          ))}
          {theirs.map((tally) => (
            <div key={tally.varianceCategory} className="rounded-lg border border-default bg-layer-1 p-3">
              <p className="text-2xl font-semibold">{tally.count}</p>
              <p className="text-xs text-fg-muted">
                {CATEGORY_LABELS[tally.varianceCategory] ?? tally.varianceCategory}
              </p>
              {/* Kept out of the actionable total on purpose. */}
              <p className="mt-1 text-xs text-fg-muted">Not the hospital&rsquo;s to fix.</p>
            </div>
          ))}
          {tallies.length === 0 ? (
            <p className="text-xs text-fg-muted">No variance has been recorded yet.</p>
          ) : null}
        </div>
        {ourTotal > 0 ? (
          <p className="text-xs text-fg-muted">
            {ourTotal} {ourTotal === 1 ? 'departure is' : 'departures are'} the hospital&rsquo;s to act on.
          </p>
        ) : null}
      </section>

      <section aria-label="Open pathways" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Open pathways</h2>
        <AsyncPanel
          loading={pathways.isPending}
          error={pathways.error}
          isEmpty={rows.length === 0}
          skeletonLabel="Loading open pathways"
          skeletonRows={4}
          onRetry={() => void pathways.refetch()}
          empty={
            <EmptyState
              cause="Nobody is on a pathway."
              nextAction="Start one. Adherence is counted from the step records, so there is nothing to keep up to date beyond recording what happened."
            />
          }
        >
          <ul className="flex flex-col gap-2 text-sm">
            {rows.map((row) => (
              <PathwayLine key={row.id} row={row} />
            ))}
          </ul>
        </AsyncPanel>
      </section>
    </section>
  );
}

/**
 * One pathway, with the two numbers that are not the same question.
 *
 * `adherence` is what fraction of the *recorded* steps went to plan.
 * `outstanding` is the steps with no record at all — which no roll-up can see,
 * because a step nobody recorded leaves no row to count. A pathway showing 100%
 * with four steps outstanding is not a pathway going well.
 */
function PathwayLine({ row }: { readonly row: PathwayInstanceRow }): React.JSX.Element {
  const adherence = row.adherencePct === null ? null : Number.parseFloat(row.adherencePct);
  const tone =
    adherence === null ? 'neutral' : adherence >= 90 ? 'success' : adherence >= 70 ? 'warning' : 'danger';

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border border-default bg-layer-1 p-3">
      <span className="flex-1 truncate font-medium">{row.pathwayName}</span>
      <span className="font-mono text-xs text-fg-muted">v{row.version}</span>
      <Badge tone={tone}>{adherence === null ? 'not started' : `${row.adherencePct}% adherence`}</Badge>
      {row.varianceCount > 0 ? (
        <Badge tone="warning">
          {row.varianceCount} {row.varianceCount === 1 ? 'variance' : 'variances'}
        </Badge>
      ) : null}
      {row.outstanding.length > 0 ? (
        <span className="text-xs text-fg-muted">
          {row.outstanding.length} not yet recorded: {row.outstanding.slice(0, 3).join(', ')}
          {row.outstanding.length > 3 ? '…' : ''}
        </span>
      ) : (
        <Badge tone="success">every step recorded</Badge>
      )}
    </li>
  );
}
