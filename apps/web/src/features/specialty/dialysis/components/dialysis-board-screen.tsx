'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState } from '@vims/ui';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { getBoard } from '../api/client';
import { dialysisKeys } from '../api/keys';
import type { DialysisBoardRow, DialysisSessionRow } from '../api/types';

/**
 * OP-012 — the unit board.
 *
 * ── Grouped by zone, because the zone is what decides who can go where ──────
 *
 * Not by chair number, not by shift. When a machine goes down at seven in the
 * morning the only question is which *other* machine in the same zone is free,
 * and a board that makes you scan for that is a board that produces the wrong
 * answer under pressure.
 *
 * ── Every machine says what it would refuse ─────────────────────────────────
 *
 * `blockedBy` comes from the server, computed from the same figures the
 * triggers refuse against. A nurse who can see the refusal coming never meets
 * it — which is the whole point of putting it on a board rather than in an
 * error.
 */
export function DialysisBoardScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = dialysisKeys(hospitalId);

  const board = useQuery({
    queryKey: keys.board(),
    queryFn: ({ signal }) => getBoard({ signal }),
    refetchInterval: 30_000,
  });

  const rows = board.data ?? [];
  const zones = groupByZone(rows);
  const down = rows.filter((r) => r.machine.status === 'breakdown' || r.machine.status === 'maintenance');

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Dialysis unit"
        description="Every machine, its isolation zone, who is on it and who is next. A machine that is down takes a shift's bookings with it, and they can only move within the zone."
      />

      {down.length > 0 ? (
        <section
          aria-label="Machines out of service"
          className="rounded-lg border border-warning-border bg-warning-surface p-4"
        >
          <h2 className="text-sm font-semibold text-warning-on-surface">
            {down.length} {down.length === 1 ? 'machine is' : 'machines are'} out of service
          </h2>
          <p className="mt-1 text-xs text-warning-on-surface">
            {down.reduce((n, r) => n + r.machine.liveSessions, 0)} booking(s) are still on them. Each has to
            move to another machine in the same zone — and a zone with nothing free is a patient who does not
            get dialysed today.
          </p>
          <ul className="mt-3 flex flex-wrap gap-2 text-sm">
            {down.map((row) => (
              <li key={row.machine.id} className="rounded-md border border-warning-border bg-layer-1 p-2">
                <span className="font-mono text-xs">{row.machine.code}</span>{' '}
                <Badge tone="warning">{row.machine.status}</Badge>{' '}
                <span className="text-fg-muted">
                  {row.machine.zone} · {row.machine.liveSessions} booked
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <AsyncPanel
        loading={board.isPending}
        error={board.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading the unit board"
        skeletonRows={6}
        onRetry={() => void board.refetch()}
        empty={
          <EmptyState
            cause="No machine is registered at this branch."
            nextAction="Commission the machines first — each one carries the isolation zone that decides which patients may be treated on it."
          />
        }
      >
        <div className="flex flex-col gap-5">
          {zones.map(([zone, machines]) => (
            <section key={zone} aria-label={`${zone} zone`} className="flex flex-col gap-2">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <ZoneChip zone={zone} />
                <span className="text-fg-muted">
                  {machines.filter((m) => m.machine.free).length} of {machines.length} free
                </span>
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {machines.map((row) => (
                  <MachineCard key={row.machine.id} row={row} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </AsyncPanel>
    </section>
  );
}

function MachineCard({ row }: { readonly row: DialysisBoardRow }): React.JSX.Element {
  const { machine, current, next } = row;
  return (
    <article
      className={[
        'flex flex-col gap-2 rounded-lg border p-3 text-sm',
        machine.status === 'breakdown' || machine.status === 'maintenance'
          ? 'border-danger bg-danger-subtle'
          : 'border-default bg-layer-1',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-semibold">{machine.code}</span>
        <Badge tone={machine.free ? 'success' : machine.status === 'in_use' ? 'accent' : 'warning'}>
          {machine.status.replace(/_/g, ' ')}
        </Badge>
        {machine.serviceOverdue ? <Badge tone="warning">service overdue</Badge> : null}
      </div>

      {current === null ? (
        <p className="text-xs text-fg-muted">Nobody on it.</p>
      ) : (
        <SessionLine session={current} label="On the machine" />
      )}
      {next === null ? null : <SessionLine session={next} label="Next" />}

      {machine.model === null ? null : (
        <p className="text-xs text-fg-muted">
          {machine.model} · {machine.hoursRun} h
        </p>
      )}
    </article>
  );
}

function SessionLine({
  session,
  label,
}: {
  readonly session: DialysisSessionRow;
  readonly label: string;
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-default bg-layer-2 p-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">{label}</span>
        <span className="font-mono">
          {new Date(session.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–
          {new Date(session.scheduledEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
        {session.ufGoalL === null ? null : (
          <span className="text-fg-muted">
            {session.ufGoalL} L{session.ufRateMlKgH === null ? null : ` · ${session.ufRateMlKgH} ml/kg/h`}
          </span>
        )}
        {session.minutesRun === null ? null : (
          <span className="text-fg-muted">{session.minutesRun} min in</span>
        )}
      </div>
      {/* What would refuse it, in the words the refusal would use. */}
      {session.blockedBy.length > 0 ? (
        <p className="mt-1 text-xs text-fg-danger">{session.blockedBy.join('; ')}</p>
      ) : null}
    </div>
  );
}

/**
 * The zone, coloured. The one label on this screen that is never a preference:
 * it is computed from the patient's serology and it is what stops hepatitis
 * moving through the unit.
 */
function ZoneChip({ zone }: { readonly zone: string }): React.JSX.Element {
  const tone = zone === 'general' ? 'neutral' : zone === 'hbv' ? 'danger' : 'warning';
  return <Badge tone={tone}>{zone === 'general' ? 'General' : zone.toUpperCase()}</Badge>;
}

function groupByZone(rows: readonly DialysisBoardRow[]): [string, DialysisBoardRow[]][] {
  const order = ['general', 'hbv', 'hcv', 'hiv'];
  const map = new Map<string, DialysisBoardRow[]>();
  for (const row of rows) {
    const list = map.get(row.machine.zone);
    if (list === undefined) map.set(row.machine.zone, [row]);
    else list.push(row);
  }
  return [...map.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
}
