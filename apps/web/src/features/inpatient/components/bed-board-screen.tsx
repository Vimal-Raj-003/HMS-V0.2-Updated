'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { getBoard, getCensus } from '../api/client';
import { ipKeys } from '../api/keys';
import type { BedBoardRow, CensusRow } from '../api/types';

const STATUS_TONE: Readonly<Record<string, 'success' | 'danger' | 'warning' | 'info' | 'neutral'>> = {
  available: 'success',
  occupied: 'danger',
  reserved: 'info',
  cleaning: 'warning',
  blocked: 'neutral',
  retired: 'neutral',
};

const selectClass = 'h-10 rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

/**
 * IP-025 — the bed board.
 *
 * ── Nothing on this screen is a stored number ───────────────────────────────
 *
 * Every count comes from `clinical.v_bed_board`, which is a query over the
 * occupancy table. There is no `beds_free` column anywhere in the system, so
 * there is nothing here that can be stale in a way a refresh does not fix.
 *
 * ── Occupancy is over usable beds, not over all of them ─────────────────────
 *
 * A twenty-bed ward with four blocked for maintenance is running at 16/16, not
 * 16/20. Reporting the second makes a full ward look like it has room, which is
 * precisely the moment somebody is trying to find a bed.
 *
 * ── A bed waiting on a clean is shown as what it is ─────────────────────────
 *
 * Not as "available soon" and not merged into the free count. It is the queue
 * between a discharge and the next admission, and hiding it is how a hospital
 * believes it has beds it does not have.
 */
export function BedBoardScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = ipKeys(hospitalId);

  const [wardId, setWardId] = useState('');
  const [freeOnly, setFreeOnly] = useState(false);

  const census = useQuery({
    queryKey: keys.census(),
    queryFn: ({ signal }) => getCensus({ signal }),
    refetchInterval: 60_000,
  });

  const board = useQuery({
    queryKey: keys.board(`${wardId}|${String(freeOnly)}`),
    queryFn: ({ signal }) => getBoard({ ...(wardId === '' ? {} : { wardId }), freeOnly }, { signal }),
    refetchInterval: 60_000,
  });

  const wards: readonly CensusRow[] = census.data ?? [];
  const rows: readonly BedBoardRow[] = board.data?.items ?? [];
  const breached = wards.reduce((n, w) => n + w.cleaningBreached, 0);

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Bed board"
        description="Every bed and who is in it, derived from the occupancy table on every read. There is no counter to drift."
      />

      <AsyncPanel
        loading={census.isPending}
        error={census.error}
        isEmpty={wards.length === 0}
        skeletonLabel="Loading the census"
        skeletonRows={3}
        onRetry={() => {
          void census.refetch();
        }}
        empty={
          <EmptyState
            cause="No ward has been configured."
            nextAction="Add a building, a ward, a bed class and some beds before anybody can be admitted."
          />
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {wards.map((w) => (
            <div key={w.wardId} className="rounded-lg border border-strong bg-layer-1 p-4">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold text-fg-default">{w.wardName}</span>
                <span className="font-mono text-2xs text-fg-subtle">{w.wardType}</span>
              </div>
              <p className="mt-2 text-2xl font-semibold text-fg-default">
                {w.occupancyPct}
                <span className="text-sm font-normal text-fg-muted">% occupied</span>
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 text-2xs">
                <Stat label="Free" value={w.available} tone={w.available === 0 ? 'danger' : 'success'} />
                <Stat label="Occupied" value={w.occupied} tone="neutral" />
                <Stat
                  label="Cleaning"
                  value={w.cleaning}
                  tone={w.cleaningBreached > 0 ? 'danger' : w.cleaning > 0 ? 'warning' : 'neutral'}
                />
                <Stat label="Blocked" value={w.blocked} tone={w.blocked > 0 ? 'warning' : 'neutral'} />
              </dl>
              <p className="mt-2 border-t border-default pt-2 text-2xs text-fg-subtle">
                {w.dueForDischargeToday > 0
                  ? `${String(w.dueForDischargeToday)} expected out today`
                  : 'nobody expected out today'}
                {w.held > 0 ? ` · ${String(w.held)} held` : ''}
              </p>
            </div>
          ))}
        </div>
      </AsyncPanel>

      {breached > 0 ? (
        <Badge tone="danger">
          {`${String(breached)} bed(s) past their cleaning window — that is the queue between a discharge and the next admission`}
        </Badge>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-2xs uppercase tracking-[0.08em] text-fg-subtle" htmlFor="ip-ward">
            Ward
          </label>
          <select
            id="ip-ward"
            className={selectClass}
            value={wardId}
            onChange={(e) => {
              setWardId(e.target.value);
            }}
          >
            <option value="">Every ward</option>
            {wards.map((w) => (
              <option key={w.wardId} value={w.wardId}>
                {w.wardName}
              </option>
            ))}
          </select>
        </div>
        <label className="flex min-h-12 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={freeOnly}
            onChange={(e) => {
              setFreeOnly(e.target.checked);
            }}
          />
          Only beds that can be filled now
        </label>
      </div>

      <AsyncPanel
        loading={board.isPending}
        error={board.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading the bed board"
        skeletonRows={10}
        onRetry={() => {
          void board.refetch();
        }}
        empty={
          <EmptyState
            cause={freeOnly ? 'No bed can be filled right now.' : 'No bed matches this filter.'}
            nextAction={
              freeOnly
                ? 'Clear the filter to see what is occupied, held or waiting on a clean.'
                : 'Choose another ward.'
            }
          />
        }
      >
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm" data-testid="bed-board">
            <caption className="sr-only">Bed board</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {['Bed', 'Ward', 'Class', 'State', 'Patient', 'Since', 'Out', 'Fittings'].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 text-start">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr
                  key={b.bedId}
                  className="border-b border-default last:border-0"
                  data-testid={`bed-${b.bedId}`}
                >
                  <td className="px-3 py-2 font-mono text-2xs">{b.bedCode}</td>
                  <td className="px-3 py-2">{b.wardName}</td>
                  <td className="px-3 py-2 font-mono text-2xs">{b.classCode}</td>
                  <td className="px-3 py-2">
                    <Badge tone={STATUS_TONE[b.status] ?? 'neutral'}>{b.status}</Badge>
                    {b.cleaningBreached ? (
                      <div className="mt-1">
                        <Badge tone="danger">clean overdue</Badge>
                      </div>
                    ) : null}
                    {b.holdId === null ? null : (
                      <div className="mt-1">
                        <Badge tone="info">{`held · ${(b.holdReason ?? '').replace(/_/gu, ' ')}`}</Badge>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-2xs">{b.ipNo ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-2xs">
                    {b.occupiedSince === null ? '—' : b.occupiedSince.slice(0, 16).replace('T', ' ')}
                  </td>
                  <td className="px-3 py-2 font-mono text-2xs">
                    {b.expectedDischargeAt === null ? '—' : b.expectedDischargeAt.slice(0, 10)}
                  </td>
                  <td className="px-3 py-2 text-2xs text-fg-muted">{fittings(b)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      <p className="text-2xs text-fg-subtle">
        Occupancy is over usable beds — blocked and retired ones are not capacity. A ward with four beds
        blocked for maintenance is full at sixteen of sixteen, and reporting it as sixteen of twenty makes a
        full ward look like it has room.
      </p>
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone: 'danger' | 'warning' | 'success' | 'neutral';
}): React.JSX.Element {
  const cls =
    tone === 'danger'
      ? 'font-semibold text-fg-danger'
      : tone === 'warning'
        ? 'font-semibold text-fg-warning'
        : tone === 'success'
          ? 'font-semibold text-fg-success'
          : 'font-semibold text-fg-default';
  return (
    <div className="flex items-baseline justify-between gap-1">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className={cls}>{value}</dd>
    </div>
  );
}

/** What the bed physically has. A ventilated patient cannot go to a bed without a point. */
function fittings(b: BedBoardRow): string {
  const has: string[] = [];
  if (b.hasVentilatorPoint) has.push('ventilator');
  if (b.hasMonitor) has.push('monitor');
  if (b.isolationCapable) has.push('isolation');
  if (b.hasAttendantBed) has.push('attendant');
  if (!b.hasOxygenPoint) has.push('no oxygen');
  return has.length === 0 ? '—' : has.join(', ');
}
