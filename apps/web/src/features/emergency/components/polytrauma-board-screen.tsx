'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState } from '@vims/ui';
import Link from 'next/link';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { getBoards } from '../api/polytrauma-client';
import { erKeys } from '../api/keys';
import type { BoardCardView } from '../api/polytrauma-types';

const PRIORITY_TONE: Readonly<Record<string, 'danger' | 'warning' | 'info' | 'neutral'>> = {
  life_saving: 'danger',
  limb_saving: 'warning',
  definitive: 'info',
  adjunct: 'neutral',
};

const PRIORITY_LABEL: Readonly<Record<string, string>> = {
  life_saving: 'life-saving',
  limb_saving: 'limb-saving',
  definitive: 'definitive',
  adjunct: 'adjunct',
};

/**
 * TR-007 — every live polytrauma board.
 *
 * ── The card leads with what is next, not with who the patient is ───────────
 *
 * A coordination board is read by somebody deciding where to go now. "Damage-
 * control laparotomy, life-saving" is the reason to open the card; the case
 * number is how you find it again afterwards. So the next procedure is the
 * largest thing on the card and the identifiers are small.
 *
 * ── Four counts, and each is a person waiting ───────────────────────────────
 *
 * A breached consult is a specialty that has not come. Blood short is units
 * cross-matched and not in the fridge. A blocking task is theatre waiting on a
 * scan. Procedures outstanding is the work itself. None of them is a
 * percentage, and none is a colour without a number beside it.
 */
export function PolytraumaBoardScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = erKeys(hospitalId);
  const [closed, setClosed] = useState(false);

  const boards = useQuery({
    queryKey: keys.polytraumaBoards(closed ? 'all' : 'active'),
    queryFn: ({ signal }) => getBoards(closed ? {} : { state: 'active' }, { signal }),
    // A consult goes past its target while the tab sits open. That is the thing
    // this screen exists to notice, so it notices on its own.
    refetchInterval: 60_000,
  });

  const rows: readonly BoardCardView[] = [...(boards.data?.items ?? [])].sort(rank);
  const breached = rows.reduce((n, b) => n + b.consultsBreached, 0);
  const short = rows.reduce((n, b) => n + b.bloodShort, 0);

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Polytrauma boards"
        description="One card per patient injured in more than one system, ordered by what is waiting on each."
      />

      <div className="flex flex-wrap items-center gap-3">
        {breached > 0 ? (
          <Badge tone="danger">{`${String(breached)} consult(s) past their target`}</Badge>
        ) : (
          <Badge tone="success">every consult in time</Badge>
        )}
        {short > 0 ? (
          <Badge tone="warning">{`${String(short)} unit(s) of blood still to be reserved`}</Badge>
        ) : (
          <span className="text-2xs text-fg-subtle">blood reconciled on every board</span>
        )}
        <label className="flex min-h-12 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={closed}
            onChange={(e) => {
              setClosed(e.target.checked);
            }}
          />
          Include closed boards
        </label>
      </div>

      <AsyncPanel
        loading={boards.isPending}
        error={boards.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading the polytrauma boards"
        skeletonRows={4}
        onRetry={() => {
          void boards.refetch();
        }}
        empty={
          <EmptyState
            cause={closed ? 'No polytrauma board has been opened.' : 'No board is live.'}
            nextAction="Open one when a patient arrives injured in more than one system — the sequence is the thing that needs a shared owner."
          />
        }
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((b) => (
            <Link
              key={b.id}
              href={{ pathname: '/er/polytrauma/board', query: { id: b.id } }}
              className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4 hover:border-accent"
              data-testid={`pt-card-${b.id}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  {/* What is next, first and largest. */}
                  <p className="text-sm font-semibold text-fg-default">
                    {b.nextProcedure ?? 'Nothing queued'}
                  </p>
                  {b.nextPriority === null ? null : (
                    <div className="mt-1">
                      <Badge tone={PRIORITY_TONE[b.nextPriority] ?? 'neutral'}>
                        {PRIORITY_LABEL[b.nextPriority] ?? b.nextPriority}
                      </Badge>
                    </div>
                  )}
                </div>
                {b.state === 'closed' ? (
                  <Badge tone="neutral">closed</Badge>
                ) : (
                  <span className="whitespace-nowrap font-mono text-2xs text-fg-subtle">
                    {b.hoursOpen} h open
                  </span>
                )}
              </div>

              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-2xs">
                <Stat label="Procedures" value={b.proceduresOutstanding} tone="neutral" />
                <Stat
                  label="Consults open"
                  value={b.consultsOpen}
                  tone={b.consultsBreached > 0 ? 'danger' : 'neutral'}
                  note={b.consultsBreached > 0 ? `${String(b.consultsBreached)} past target` : undefined}
                />
                <Stat
                  label="Blood short"
                  value={b.bloodShort}
                  tone={b.bloodShort > 0 ? 'warning' : 'neutral'}
                  note={b.bloodShort > 0 ? 'units not reserved' : undefined}
                />
                <Stat
                  label="Blocking tasks"
                  value={b.blockingTasks}
                  tone={b.blockingTasks > 0 ? 'warning' : 'neutral'}
                />
              </dl>

              <div className="flex items-center justify-between border-t border-default pt-2 font-mono text-2xs text-fg-subtle">
                <span>{b.caseNo}</span>
                <span>{b.issAtOpen === null ? 'ISS not scored' : `ISS ${String(b.issAtOpen)}`}</span>
              </div>
            </Link>
          ))}
        </div>
      </AsyncPanel>

      <p className="text-2xs text-fg-subtle">
        Life-saving before limb-saving before definitive. The database refuses an arrangement that breaks it —
        a femoral nail ahead of a laparotomy for a bleeding spleen is a patient who dies with a beautifully
        fixed femur.
      </p>
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
  note,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone: 'danger' | 'warning' | 'neutral';
  readonly note?: string | undefined;
}): React.JSX.Element {
  return (
    <div>
      <dt className="uppercase tracking-[0.08em] text-fg-subtle">{label}</dt>
      <dd className="flex items-baseline gap-1">
        <span
          className={
            tone === 'danger'
              ? 'text-sm font-semibold text-fg-danger'
              : tone === 'warning'
                ? 'text-sm font-semibold text-fg-warning'
                : 'text-sm font-semibold text-fg-default'
          }
        >
          {value}
        </span>
        {note === undefined ? null : <span className="text-fg-muted">{note}</span>}
      </dd>
    </div>
  );
}

/** A breached consult first, then blood short, then blocking work, then age. */
function rank(a: BoardCardView, b: BoardCardView): number {
  const score = (x: BoardCardView): number => {
    if (x.state === 'closed') return 5;
    if (x.consultsBreached > 0) return 0;
    if (x.bloodShort > 0) return 1;
    if (x.blockingTasks > 0) return 2;
    if (x.proceduresOutstanding > 0) return 3;
    return 4;
  };
  const d = score(a) - score(b);
  return d !== 0 ? d : b.hoursOpen - a.hoursOpen;
}
