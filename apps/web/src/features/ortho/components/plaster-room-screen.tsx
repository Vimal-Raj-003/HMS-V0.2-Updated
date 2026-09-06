'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState } from '@vims/ui';
import Link from 'next/link';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { getCasts } from '../api/client';
import { orthoKeys } from '../api/keys';
import type { CastApplicationView } from '../api/types';

const SIDE_TONE: Readonly<Record<string, 'danger' | 'info' | 'neutral'>> = {
  left: 'info',
  right: 'danger',
  bilateral: 'neutral',
  not_applicable: 'neutral',
};

const WEIGHT_BEARING: Readonly<Record<string, string>> = {
  nwb: 'non weight-bearing',
  ttwb: 'touch weight-bearing',
  pwb: 'partial weight-bearing',
  wbat: 'weight-bearing as tolerated',
  fwb: 'full weight-bearing',
};

/**
 * TR-005 — the plaster room worklist.
 *
 * ── The sort is the whole screen ────────────────────────────────────────────
 *
 * A red flag first, then a check that is overdue, then a check that is due, and
 * only then everything else. A limb whose neurovascular check was missed is the
 * failure this list exists to prevent, and it cannot be at the bottom of an
 * alphabetical table.
 *
 * ── Overdue is stated in hours, not as a colour ─────────────────────────────
 *
 * "Due 14:00" makes the reader do the arithmetic against a clock they are not
 * looking at. "3 h overdue" does not.
 */
export function PlasterRoomScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = orthoKeys(hospitalId);
  const [dueOnly, setDueOnly] = useState(false);

  const casts = useQuery({
    queryKey: keys.casts(dueOnly ? 'due' : 'all'),
    queryFn: ({ signal }) => getCasts({ dueOnly }, { signal }),
    // A neurovascular check going overdue while the tab sits open is the thing
    // this list is for, so it refreshes on its own rather than on a click.
    refetchInterval: 60_000,
  });

  const rows: readonly CastApplicationView[] = [...(casts.data?.items ?? [])].sort(rank);
  const flagged = rows.filter((c) => c.lastCheckRedFlag).length;
  const due = rows.filter((c) => c.checkDue).length;

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Plaster room"
        description="Every cast, splint, brace and traction in place, ordered by how urgently the limb inside needs looking at."
      />

      <div className="flex flex-wrap items-center gap-3">
        {flagged > 0 ? (
          <Badge tone="danger">{`${String(flagged)} with a red flag on the last check`}</Badge>
        ) : (
          <Badge tone="success">no red flags outstanding</Badge>
        )}
        {due > 0 ? (
          <Badge tone="warning">{`${String(due)} check(s) due`}</Badge>
        ) : (
          <span className="text-2xs text-fg-subtle">every check up to date</span>
        )}
        <label className="flex min-h-12 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={dueOnly}
            onChange={(e) => {
              setDueOnly(e.target.checked);
            }}
          />
          Only limbs with a check due
        </label>
      </div>

      <AsyncPanel
        loading={casts.isPending}
        error={casts.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading the plaster room"
        skeletonRows={8}
        onRetry={() => {
          void casts.refetch();
        }}
        empty={
          <EmptyState
            cause={dueOnly ? 'No neurovascular check is due.' : 'Nothing is in plaster.'}
            nextAction={
              dueOnly
                ? 'Clear the filter to see everything in place.'
                : 'Apply one against a request from the clinic, the ward or the emergency floor.'
            }
          />
        }
      >
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm" data-testid="plaster-room">
            <caption className="sr-only">Casts and splints in place</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {['Check', 'Kind', 'Side', 'Region', 'Material', 'Weight-bearing', 'Applied', 'Off'].map(
                  (h) => (
                    <th key={h} scope="col" className="px-3 py-2 text-start">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr
                  key={c.id}
                  className="border-b border-default last:border-0"
                  data-testid={`cast-row-${c.id}`}
                >
                  <td className="px-3 py-2">
                    <Link
                      href={{ pathname: '/ortho/plaster/cast', query: { id: c.id } }}
                      className="text-fg-link underline-offset-2 hover:underline"
                    >
                      {checkLabel(c)}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{c.kind.replace('_', ' ')}</td>
                  <td className="px-3 py-2">
                    <Badge tone={SIDE_TONE[c.side] ?? 'neutral'}>{c.side.replace('_', ' ')}</Badge>
                  </td>
                  <td className="px-3 py-2">{c.bodyRegion}</td>
                  <td className="px-3 py-2 text-2xs text-fg-muted">{c.material.replace(/_/gu, ' ')}</td>
                  <td className="px-3 py-2 text-2xs">
                    {c.weightBearing === null ? (
                      <span className="text-fg-subtle">not stated</span>
                    ) : (
                      (WEIGHT_BEARING[c.weightBearing] ?? c.weightBearing)
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-2xs">{(c.appliedAt ?? '').slice(0, 16)}</td>
                  <td className="px-3 py-2">
                    {c.removedAt === null ? (
                      <span className="text-2xs text-fg-subtle">in place</span>
                    ) : (
                      <span className="text-2xs text-fg-subtle">off {c.removedAt.slice(0, 10)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      <p className="text-2xs text-fg-subtle">
        A red flag on the last check sorts to the top and stays there until a clean check is recorded. Pain
        out of proportion, pain on passive stretch and paraesthesia in a limb in plaster are compartment
        syndrome until proven otherwise, and the window is hours.
      </p>
    </section>
  );
}

/** Red flag, then overdue, then due, then everything else. */
function rank(a: CastApplicationView, b: CastApplicationView): number {
  const score = (c: CastApplicationView): number => {
    if (c.removedAt !== null) return 4;
    if (c.lastCheckRedFlag) return 0;
    if (c.checkDue) return 1;
    return c.nextCheckDueAt === null ? 3 : 2;
  };
  const d = score(a) - score(b);
  if (d !== 0) return d;
  return (a.nextCheckDueAt ?? '9999').localeCompare(b.nextCheckDueAt ?? '9999');
}

function checkLabel(c: CastApplicationView): string {
  if (c.removedAt !== null) return 'removed';
  if (c.lastCheckRedFlag) return 'red flag — recheck';
  if (c.nextCheckDueAt === null) return 'no check scheduled';

  const minutes = Math.round((new Date(c.nextCheckDueAt).getTime() - Date.now()) / 60_000);
  if (minutes <= 0) return `${describe(-minutes)} overdue`;
  return `due in ${describe(minutes)}`;
}

function describe(minutes: number): string {
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)} h`;
  return `${String(Math.round(hours / 24))} d`;
}
