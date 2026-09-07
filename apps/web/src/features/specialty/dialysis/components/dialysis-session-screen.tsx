'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { abortSession, getSession, getSessions, updateSession } from '../api/client';
import { dialysisKeys } from '../api/keys';
import type { DialyserUseRow, DialysisSessionDetail } from '../api/types';

/**
 * OP-012 — the chair.
 *
 * ── The fluid is the screen ─────────────────────────────────────────────────
 *
 * The goal comes from the pre-weight and the dry weight; the rate comes from
 * the goal and the hours; and when the rate is over the prescription's ceiling
 * the server has already worked out how long the session would have to run —
 * so the screen offers that duration rather than an error.
 *
 * ── The filter is not chosen, it is looked up ───────────────────────────────
 *
 * A dialyser that is not licensed for another use cannot be picked, and the
 * reason is on the row: reuse limit, a failed pressure hold, a cell volume
 * below the floor. The count is the database's, and this list is a reading of
 * it rather than a second copy.
 */
export function DialysisSessionScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = dialysisKeys(hospitalId);
  const qc = useQueryClient();

  const canAbort = granted.has('dialysis.session.abort');
  const [openId, setOpenId] = useState<string | null>(null);
  const [aborting, setAborting] = useState(false);
  const [reason, setReason] = useState('');

  const sessions = useQuery({
    queryKey: keys.sessions('live'),
    queryFn: ({ signal }) => getSessions({ liveOnly: true }, { signal }),
    refetchInterval: 30_000,
  });

  const detail = useQuery({
    queryKey: keys.session(openId ?? 'none'),
    queryFn: ({ signal }) => getSession(openId ?? '', { signal }),
    enabled: openId !== null,
    refetchInterval: 30_000,
  });

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: keys.sessionsRoot() });
    void qc.invalidateQueries({ queryKey: keys.board() });
    if (openId !== null) void qc.invalidateQueries({ queryKey: keys.session(openId) });
  };

  const advance = useMutation({
    mutationFn: (input: { id: string; body: Record<string, unknown> }) => updateSession(input.id, input.body),
    onSuccess: invalidate,
  });

  const end = useMutation({
    mutationFn: (input: { id: string; reason: string }) => abortSession(input.id, { reason: input.reason }),
    onSuccess: () => {
      setAborting(false);
      setReason('');
      invalidate();
    },
  });

  const rows = sessions.data ?? [];

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Dialysis sessions"
        description="Today's chairs, what each one is waiting for, and the fluid arithmetic that decides whether a patient crashes on the machine."
      />

      <AsyncPanel
        loading={sessions.isPending}
        error={sessions.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading sessions"
        skeletonRows={6}
        onRetry={() => void sessions.refetch()}
        empty={
          <EmptyState
            cause="Nothing is booked or running."
            nextAction="Book a patient onto a machine in their own isolation zone — the board shows which are free."
          />
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
            <caption className="sr-only">
              Live dialysis sessions. The goal and rate are computed from the pre-weight and the dry weight;
              the rate is checked against the prescription&rsquo;s own ceiling.
            </caption>
            <thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
              <tr>
                <th scope="col" className="py-2">
                  Time
                </th>
                <th scope="col">Machine</th>
                <th scope="col">Zone</th>
                <th scope="col">Fluid</th>
                <th scope="col">Rate</th>
                <th scope="col">Waiting on</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((session) => (
                <tr
                  key={session.id}
                  className="cursor-pointer border-t border-default hover:bg-layer-3"
                  onClick={() => setOpenId(session.id)}
                >
                  <td className="py-2 font-mono text-xs">
                    {new Date(session.scheduledAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="font-mono text-xs">{session.machineCode ?? '—'}</td>
                  <td>
                    <Badge tone={session.patientZone === 'general' ? 'neutral' : 'danger'}>
                      {session.patientZone === 'general' ? 'General' : session.patientZone.toUpperCase()}
                    </Badge>
                  </td>
                  <td>
                    {session.ufGoalL === null ? (
                      <span className="text-fg-muted">not set</span>
                    ) : (
                      `${session.ufGoalL} L`
                    )}
                  </td>
                  <td>
                    {session.ufRateMlKgH === null ? (
                      '—'
                    ) : (
                      <Badge tone={session.ufRateMlKgH > session.ufMaxRateMlKgH ? 'danger' : 'success'}>
                        {session.ufRateMlKgH} / {session.ufMaxRateMlKgH}
                      </Badge>
                    )}
                  </td>
                  <td className="text-xs text-fg-muted">
                    {session.blockedBy.length === 0 ? 'nothing' : session.blockedBy[0]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      {openId === null || detail.data === undefined ? null : (
        <Chair
          detail={detail.data}
          busy={advance.isPending || end.isPending}
          canAbort={canAbort}
          aborting={aborting}
          reason={reason}
          onReason={setReason}
          onStartAbort={() => {
            setAborting(true);
            setReason('');
          }}
          onCancelAbort={() => {
            setAborting(false);
            setReason('');
          }}
          onAbort={(id) => end.mutate({ id, reason })}
          onAdvance={(id, body) => advance.mutate({ id, body })}
          onClose={() => setOpenId(null)}
        />
      )}
    </section>
  );
}

function Chair({
  detail,
  busy,
  canAbort,
  aborting,
  reason,
  onReason,
  onStartAbort,
  onCancelAbort,
  onAbort,
  onAdvance,
  onClose,
}: {
  readonly detail: DialysisSessionDetail;
  readonly busy: boolean;
  readonly canAbort: boolean;
  readonly aborting: boolean;
  readonly reason: string;
  readonly onReason: (value: string) => void;
  readonly onStartAbort: () => void;
  readonly onCancelAbort: () => void;
  readonly onAbort: (id: string) => void;
  readonly onAdvance: (id: string, body: Record<string, unknown>) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { session, program, accesses, dialysers, observations } = detail;
  const [preWeight, setPreWeight] = useState('');

  return (
    <section aria-label="The chair" className="rounded-lg border border-default bg-layer-1 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">
          {session.machineCode ?? 'No machine'} · dry weight {program.dryWeightKg} kg
          {program.dryWeightStale ? (
            <span className="ml-2 text-xs font-normal text-fg-danger">
              last reviewed {program.dryWeightAgeDays} days ago
            </span>
          ) : null}
        </h2>
        <button type="button" onClick={onClose} className="text-sm text-fg-link hover:underline">
          Close
        </button>
      </div>

      {session.blockedBy.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1 rounded-md border border-danger bg-danger-subtle p-3 text-sm">
          {session.blockedBy.map((why) => (
            <li key={why} className="text-fg-danger">
              {why}
            </li>
          ))}
        </ul>
      ) : null}

      {/* The one place a number is typed. Everything downstream follows from it. */}
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onAdvance(session.id, { preWeightKg: Number(preWeight) });
          setPreWeight('');
        }}
      >
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium">Pre-dialysis weight (kg)</span>
          <input
            className="w-40 rounded border border-control bg-layer-1 px-2 py-1 text-sm"
            type="number"
            step="0.1"
            min="10"
            max="400"
            value={preWeight}
            onChange={(event) => setPreWeight(event.target.value)}
            placeholder={String(program.dryWeightKg + 2)}
            required
          />
        </label>
        <Button type="submit" size="sm" disabled={busy}>
          Set
        </Button>
        {session.suggestedUfGoalL === null ? null : (
          <span className="text-xs text-fg-muted">
            {session.suggestedUfGoalL} L over the dry weight
            {session.minutesNeededForGoal === null
              ? null
              : ` — at this goal the session needs ${session.minutesNeededForGoal} minutes to stay under ${session.ufMaxRateMlKgH} ml/kg/h`}
          </span>
        )}
      </form>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <section aria-label="The access">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Access</h3>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {accesses.map((access) => (
              <li key={access.id} className="flex flex-wrap items-center gap-2">
                <Badge tone={access.status === 'active' ? 'success' : 'warning'}>{access.status}</Badge>
                <span>
                  {access.type} · {access.site}
                </span>
                {/* Cannulating one that has not matured destroys it. */}
                {access.status === 'maturing' && access.ageDays !== null ? (
                  <span className="text-xs text-fg-muted">{access.ageDays} days old</span>
                ) : null}
              </li>
            ))}
            {accesses.length === 0 ? (
              <li className="text-xs text-fg-muted">No access recorded. One is needed before connecting.</li>
            ) : null}
          </ul>
        </section>

        <section aria-label="The dialyser">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Dialysers</h3>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {dialysers.slice(0, 6).map((use) => (
              <DialyserLine key={use.id} use={use} />
            ))}
            {dialysers.length === 0 ? (
              <li className="text-xs text-fg-muted">
                Nothing logged for this patient. The use number is the database&rsquo;s, not the
                label&rsquo;s.
              </li>
            ) : null}
          </ul>
        </section>

        <section aria-label="The chart">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Chart</h3>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {observations.slice(-6).map((obs) => (
              <li key={obs.id} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono">
                  {new Date(obs.recordedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                {obs.systolic === null ? null : (
                  <span>
                    {obs.systolic}/{obs.diastolic ?? '—'}
                  </span>
                )}
                {obs.ufRemovedL === null ? null : <span>{obs.ufRemovedL} L off</span>}
                {/* Ahead of plan on a cramping patient is the thing to notice. */}
                {obs.ufBehindL === null ? null : (
                  <Badge tone={obs.ufBehindL < -0.3 ? 'warning' : 'neutral'}>
                    {obs.ufBehindL < 0
                      ? `${String(Math.abs(obs.ufBehindL))} L ahead`
                      : `${String(obs.ufBehindL)} L behind`}
                  </Badge>
                )}
              </li>
            ))}
            {observations.length === 0 ? (
              <li className="text-xs text-fg-muted">Nothing charted yet.</li>
            ) : null}
          </ul>
        </section>
      </div>

      {session.urr === null && session.ktv === null ? null : (
        <p className="mt-4 text-sm">
          <span className="font-medium">Adequacy:</span> URR {session.urr ?? '—'} %, Kt/V {session.ktv ?? '—'}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {session.status === 'scheduled' ? (
          <Button size="sm" disabled={busy} onClick={() => onAdvance(session.id, { status: 'checked_in' })}>
            Check in
          </Button>
        ) : null}
        {session.status === 'checked_in' && session.blockedBy.length === 0 ? (
          <Button size="sm" disabled={busy} onClick={() => onAdvance(session.id, { status: 'on_machine' })}>
            Connect
          </Button>
        ) : null}
        {session.status === 'on_machine' ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => onAdvance(session.id, { status: 'completed' })}
          >
            Disconnect
          </Button>
        ) : null}
        {canAbort && (session.status === 'on_machine' || session.status === 'checked_in') ? (
          aborting ? (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                onAbort(session.id);
              }}
            >
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-medium">Why the session was stopped</span>
                <input
                  className="w-96 rounded border border-control bg-layer-1 px-2 py-1 text-sm"
                  value={reason}
                  onChange={(event) => onReason(event.target.value)}
                  placeholder="Symptomatic hypotension at ninety minutes; reinfused and disconnected."
                  required
                  minLength={4}
                />
              </label>
              <Button type="submit" size="sm" variant="danger" disabled={busy}>
                End it
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={onCancelAbort}>
                Cancel
              </Button>
            </form>
          ) : (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onStartAbort}>
              Stop early
            </Button>
          )
        ) : null}
      </div>
    </section>
  );
}

function DialyserLine({ use }: { readonly use: DialyserUseRow }): React.JSX.Element {
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-xs">{use.label}</span>
      <Badge tone={use.nextUseLicensed ? 'success' : 'warning'}>use {use.useNo}</Badge>
      {use.usesRemaining === null ? null : (
        <span className="text-xs text-fg-muted">{use.usesRemaining} left</span>
      )}
      {use.tcvPct === null ? null : <span className="text-xs text-fg-muted">{use.tcvPct} % TCV</span>}
      {use.blockedBy.length > 0 ? <span className="text-xs text-fg-muted">{use.blockedBy[0]}</span> : null}
    </li>
  );
}
