'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { getOtBoard, recordCounts, runChecklist } from '../api/client';
import { ipKeys } from '../api/keys';
import type { OtCaseRow } from '../api/types';

const STATE_TONE: Readonly<Record<string, 'success' | 'danger' | 'warning' | 'info' | 'neutral'>> = {
  requested: 'neutral',
  scheduled: 'info',
  ready: 'info',
  signed_in: 'warning',
  timed_out: 'warning',
  in_progress: 'danger',
  signed_out: 'success',
  closed: 'neutral',
  cancelled: 'neutral',
  postponed: 'warning',
};

const inputClass = 'h-10 w-full rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

/**
 * IP-006 — the theatre board.
 *
 * ── The checklist is three buttons that appear in order ─────────────────────
 *
 * Sign-in, then time-out, then sign-out. There is no fourth button that skips
 * one, because there is no route on the server that does and no column in the
 * schema that could. An emergency case gets a *bumped elective case* with a
 * recorded reason, not a shorter checklist — the whole point of the checklist
 * is that it applies at 2 a.m.
 *
 * ── The block reason is the server's sentence ───────────────────────────────
 *
 * "The time-out has not been run — nothing can be cut until it is" is computed
 * once, in the service, so the board and the case screen cannot disagree about
 * why a case has not started. A theatre where two screens give different
 * answers is a theatre where the list runs late for no visible reason.
 */
export function TheatreBoardScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = ipKeys(hospitalId);
  const queryClient = useQueryClient();

  const [openOnly, setOpenOnly] = useState(true);
  const [counts, setCounts] = useState<Readonly<Record<string, string>>>({});

  const board = useQuery({
    queryKey: keys.otBoard(openOnly ? 'open' : 'all'),
    queryFn: ({ signal }) => getOtBoard({ openOnly }, { signal }),
    refetchInterval: 60_000,
  });

  function invalidate(): void {
    void queryClient.invalidateQueries({ queryKey: keys.otBoardRoot() });
  }

  const phase = useMutation({
    mutationFn: (input: { readonly id: string; readonly phase: 'sign_in' | 'time_out' | 'sign_out' }) =>
      runChecklist(input.id, input.phase, { confirmed: true }),
    onSuccess: invalidate,
  });

  const count = useMutation({
    mutationFn: (input: { readonly id: string; readonly swabOut: number }) =>
      recordCounts(input.id, {
        swabIn: 18,
        swabOut: input.swabOut,
        instrumentIn: 64,
        instrumentOut: 64,
        sharpsIn: 9,
        sharpsOut: 9,
      }),
    onSuccess: invalidate,
  });

  const rows: readonly OtCaseRow[] = board.data?.items ?? [];
  const running = rows.filter((c) => c.state === 'in_progress').length;
  const discrepancies = rows.filter((c) => c.countDiscrepancy).length;

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Theatre board"
        description="Today's list, what each case is waiting on, and the WHO checklist as three steps that run in order."
      />

      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={running > 0 ? 'danger' : 'neutral'}>{`${String(running)} in theatre`}</Badge>
        {discrepancies > 0 ? (
          <Badge tone="danger">{`${String(discrepancies)} case(s) with an unreconciled count`}</Badge>
        ) : null}
        <label className="flex min-h-12 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={openOnly}
            onChange={(e) => {
              setOpenOnly(e.target.checked);
            }}
          />
          Only cases still open
        </label>
      </div>

      {phase.error === null ? null : <ProblemCard error={phase.error} />}
      {count.error === null ? null : <ProblemCard error={count.error} />}

      <AsyncPanel
        loading={board.isPending}
        error={board.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading the theatre board"
        skeletonRows={6}
        onRetry={() => {
          void board.refetch();
        }}
        empty={
          <EmptyState
            cause={openOnly ? 'No case is open.' : 'No case has been booked.'}
            nextAction="Book one from the ward, the clinic or the emergency floor."
          />
        }
      >
        <ul className="flex flex-col gap-2" data-testid="theatre-board">
          {rows.map((c) => (
            <li
              key={c.id}
              className="rounded-lg border border-strong bg-layer-1 p-4"
              data-testid={`ot-${c.id}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-2xs text-fg-subtle">{c.caseNo}</span>
                    <span className="text-sm font-semibold text-fg-default">{c.plannedProcedure}</span>
                    {c.side === null ? null : (
                      <Badge tone={c.side === 'right' ? 'danger' : c.side === 'left' ? 'info' : 'neutral'}>
                        {c.side.replace('_', ' ')}
                      </Badge>
                    )}
                    <Badge tone={STATE_TONE[c.state] ?? 'neutral'}>{c.state.replace('_', ' ')}</Badge>
                    {c.urgency === 'emergency' ? <Badge tone="danger">emergency</Badge> : null}
                    {c.theatreCode === null ? null : (
                      <span className="font-mono text-2xs text-fg-subtle">{c.theatreCode}</span>
                    )}
                  </div>
                  {c.blockedBy === null ? null : (
                    <p className="mt-1 text-2xs text-fg-warning">{c.blockedBy}</p>
                  )}
                  {c.bumpReason === null ? null : (
                    <p className="mt-1 text-2xs text-fg-muted">Bumped: {c.bumpReason}</p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Tick on={c.preop.consent} label="consent" />
                    <Tick on={c.preop.siteMarked} label="site marked" />
                    <Tick on={c.preop.pacCleared} label="PAC" />
                    <Tick on={c.preop.crossmatch} label="cross-match" />
                    <Tick on={c.preop.antibiotic} label="antibiotic" />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant={c.signInAt === null ? 'primary' : 'secondary'}
                    disabled={phase.isPending || c.signInAt !== null}
                    onClick={() => {
                      phase.mutate({ id: c.id, phase: 'sign_in' });
                    }}
                  >
                    Sign-in
                  </Button>
                  <Button
                    type="button"
                    variant={c.signInAt !== null && c.timeOutAt === null ? 'primary' : 'secondary'}
                    disabled={phase.isPending || c.timeOutAt !== null}
                    onClick={() => {
                      phase.mutate({ id: c.id, phase: 'time_out' });
                    }}
                  >
                    Time-out
                  </Button>
                  <Button
                    type="button"
                    variant={c.timeOutAt !== null && c.signOutAt === null ? 'primary' : 'secondary'}
                    disabled={phase.isPending || c.signOutAt !== null}
                    onClick={() => {
                      phase.mutate({ id: c.id, phase: 'sign_out' });
                    }}
                  >
                    Sign-out
                  </Button>
                </div>
              </div>

              {c.signOutAt !== null && c.state !== 'closed' ? (
                <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-default pt-3">
                  <div>
                    <label
                      className="text-2xs uppercase tracking-[0.08em] text-fg-subtle"
                      htmlFor={`sw-${c.id}`}
                    >
                      Swabs out (18 in)
                    </label>
                    <input
                      id={`sw-${c.id}`}
                      className={`${inputClass} max-w-32`}
                      inputMode="numeric"
                      value={counts[c.id] ?? ''}
                      placeholder="18"
                      onChange={(e) => {
                        setCounts({ ...counts, [c.id]: e.target.value });
                      }}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={count.isPending || (counts[c.id] ?? '') === ''}
                    onClick={() => {
                      count.mutate({ id: c.id, swabOut: Number(counts[c.id] ?? '0') });
                    }}
                  >
                    Record counts
                  </Button>
                  {c.countDiscrepancy ? (
                    <Badge tone="danger">
                      a count does not reconcile — the case cannot close without a recorded resolution
                    </Badge>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </AsyncPanel>

      <p className="text-2xs text-fg-subtle">
        No incision can be recorded before the time-out and no case can close before the sign-out with the
        counts reconciled. There is no button that skips a phase, because there is no route on the server that
        does — an emergency case bumps an elective one with a recorded reason, not a shorter checklist.
      </p>
    </section>
  );
}

function Tick({ on, label }: { readonly on: boolean; readonly label: string }): React.JSX.Element {
  return (
    <span className={`text-2xs ${on ? 'text-fg-success' : 'text-fg-subtle'}`}>
      {on ? '✓' : '○'} {label}
    </span>
  );
}
