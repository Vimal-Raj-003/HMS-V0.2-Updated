'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { cleaningAction, getCleaning } from '../api/client';
import { ipKeys } from '../api/keys';
import type { CleaningTaskView } from '../api/types';

const STATE_TONE: Readonly<Record<string, 'success' | 'danger' | 'warning' | 'info' | 'neutral'>> = {
  requested: 'danger',
  accepted: 'warning',
  in_progress: 'info',
  done: 'success',
  inspected: 'success',
  failed: 'danger',
};

const inputClass = 'h-10 w-full rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

/**
 * NC-018 — the queue between a discharge and the next admission.
 *
 * ── Overdue is stated in minutes, not shown as a colour ─────────────────────
 *
 * "Due 14:25" makes the reader do arithmetic against a clock they are not
 * looking at. "12 min over" does not, and the person reading this on a phone in
 * a corridor is the one who has to decide which bed to do next.
 *
 * ── There is no "mark clean" shortcut here ──────────────────────────────────
 *
 * Accept, start, complete — three taps, because the timestamps are what the SLA
 * is measured on and a single button would collapse them into one. Returning a
 * bed without a clean is possible and lives on the bed board behind its own
 * key, where it is an audited exception rather than a faster path.
 */
export function HousekeepingScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = ipKeys(hospitalId);
  const queryClient = useQueryClient();

  const [breachedOnly, setBreachedOnly] = useState(false);
  const [failReasons, setFailReasons] = useState<Readonly<Record<string, string>>>({});

  const tasks = useQuery({
    queryKey: keys.cleaning(breachedOnly ? 'breached' : 'open'),
    queryFn: ({ signal }) => getCleaning({ openOnly: true, breachedOnly }, { signal }),
    // A bed goes past its window while the tab sits open. That is the thing
    // this list exists to notice, so it notices on its own.
    refetchInterval: 30_000,
  });

  const act = useMutation({
    mutationFn: (input: { readonly id: string; readonly action: string; readonly failReason?: string }) =>
      cleaningAction(input.id, {
        action: input.action,
        ...(input.failReason === undefined ? {} : { failReason: input.failReason }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.cleaningRoot() });
      void queryClient.invalidateQueries({ queryKey: keys.boardRoot() });
      void queryClient.invalidateQueries({ queryKey: keys.census() });
    },
  });

  const rows: readonly CleaningTaskView[] = [...(tasks.data?.items ?? [])].sort(
    (a, b) => a.minutesRemaining - b.minutesRemaining,
  );
  const breached = rows.filter((t) => t.breached).length;

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Bed turnover"
        description="Beds waiting on a clean, closest to breaching first. Every one of them is a bed somebody is waiting for."
      />

      <div className="flex flex-wrap items-center gap-3">
        {breached > 0 ? (
          <Badge tone="danger">{`${String(breached)} past their window`}</Badge>
        ) : (
          <Badge tone="success">every bed inside its window</Badge>
        )}
        <label className="flex min-h-12 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={breachedOnly}
            onChange={(e) => {
              setBreachedOnly(e.target.checked);
            }}
          />
          Only the overdue ones
        </label>
      </div>

      {act.error === null ? null : <ProblemCard error={act.error} />}

      <AsyncPanel
        loading={tasks.isPending}
        error={tasks.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading the cleaning worklist"
        skeletonRows={6}
        onRetry={() => {
          void tasks.refetch();
        }}
        empty={
          <EmptyState
            cause={breachedOnly ? 'Nothing is overdue.' : 'No bed is waiting on a clean.'}
            nextAction={
              breachedOnly
                ? 'Clear the filter to see the rest.'
                : 'Beds appear here the moment they are vacated.'
            }
          />
        }
      >
        <ul className="flex flex-col gap-2" data-testid="cleaning-worklist">
          {rows.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-strong bg-layer-1 p-4"
              data-testid={`clean-${t.id}`}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-fg-default">{t.bedCode}</span>
                  <span className="text-2xs text-fg-muted">{t.wardName}</span>
                  <Badge tone={STATE_TONE[t.state] ?? 'neutral'}>{t.state.replace('_', ' ')}</Badge>
                  <Badge tone="neutral">{t.kind}</Badge>
                </div>
                <p className="mt-1 text-2xs">
                  {t.breached ? (
                    <span className="font-semibold text-fg-danger">
                      {`${String(Math.abs(t.minutesRemaining))} min over the ${String(t.slaMinutes)} minute window`}
                    </span>
                  ) : (
                    <span className="text-fg-subtle">
                      {`${String(t.minutesRemaining)} min left of ${String(t.slaMinutes)}`}
                    </span>
                  )}
                </p>
                {t.failReason === null ? null : (
                  <p className="mt-1 text-2xs text-fg-danger">Failed inspection: {t.failReason}</p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {t.state === 'requested' || t.state === 'failed' ? (
                  <Button
                    type="button"
                    disabled={act.isPending}
                    onClick={() => {
                      act.mutate({ id: t.id, action: 'accept' });
                    }}
                  >
                    Accept
                  </Button>
                ) : null}
                {t.state === 'accepted' ? (
                  <Button
                    type="button"
                    disabled={act.isPending}
                    onClick={() => {
                      act.mutate({ id: t.id, action: 'start' });
                    }}
                  >
                    Start
                  </Button>
                ) : null}
                {t.state === 'in_progress' ? (
                  <Button
                    type="button"
                    disabled={act.isPending}
                    onClick={() => {
                      act.mutate({ id: t.id, action: 'complete' });
                    }}
                  >
                    Done
                  </Button>
                ) : null}
                {t.state === 'done' ? (
                  <>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={act.isPending}
                      onClick={() => {
                        act.mutate({ id: t.id, action: 'inspect' });
                      }}
                    >
                      Pass
                    </Button>
                    <input
                      aria-label="What was wrong"
                      className={`${inputClass} max-w-64`}
                      value={failReasons[t.id] ?? ''}
                      placeholder="What was wrong"
                      onChange={(e) => {
                        setFailReasons({ ...failReasons, [t.id]: e.target.value });
                      }}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={act.isPending || (failReasons[t.id] ?? '').trim().length < 4}
                      onClick={() => {
                        act.mutate({
                          id: t.id,
                          action: 'fail',
                          failReason: (failReasons[t.id] ?? '').trim(),
                        });
                      }}
                    >
                      Fail
                    </Button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </AsyncPanel>

      <p className="text-2xs text-fg-subtle">
        A bed cannot go back on the board without a completed clean. Returning one without it is possible from
        the bed board, behind its own key, and the reason is kept on the bed — an audited exception is better
        than a fake clean, which is what a rule with no exception produces.
      </p>
    </section>
  );
}
