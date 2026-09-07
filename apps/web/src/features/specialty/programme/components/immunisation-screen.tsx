'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { decideBreach, getAefi, getBreaches, getPlanDoses, getVials } from '../api/client';
import { programmeKeys } from '../api/keys';
import type { VialRow } from '../api/types';

/**
 * OP-013 — the immunisation session board.
 *
 * ── The three things that stop a session, at the top ───────────────────────
 *
 * A batch held after a cold chain breach, a serious adverse event whose
 * statutory report has not gone, and the vials whose clock is about to run out.
 * Each is a refusal waiting to happen, and each is far cheaper to see before
 * the syringe is drawn than after.
 *
 * ── The vial clock is the working view ─────────────────────────────────────
 *
 * `usable` and `minutesLeft` come from the server, computed from the same
 * discard time the trigger refuses against. A nurse setting up a session reads
 * this list and knows which vial to finish first — which is the whole of
 * open-vial policy, expressed as a sort order.
 */
export function ImmunisationScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = programmeKeys(hospitalId);
  const qc = useQueryClient();

  const canDecide = granted.has('immunisation.breach.decide');
  const [deciding, setDeciding] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const vials = useQuery({
    queryKey: keys.vials('usable'),
    queryFn: ({ signal }) => getVials({ usableOnly: true }, { signal }),
    refetchInterval: 60_000,
  });

  const breaches = useQuery({
    queryKey: keys.breaches(),
    queryFn: ({ signal }) => getBreaches({ signal }),
    refetchInterval: 60_000,
  });

  const aefi = useQuery({
    queryKey: keys.aefi(),
    queryFn: ({ signal }) => getAefi({ signal }),
    refetchInterval: 120_000,
  });

  const overdue = useQuery({
    queryKey: keys.planDoses('overdue'),
    queryFn: ({ signal }) => getPlanDoses({ overdueOnly: true }, { signal }),
    refetchInterval: 300_000,
  });

  const decide = useMutation({
    mutationFn: (input: { id: string; action: 'released' | 'discarded'; reason: string }) =>
      decideBreach(input.id, { action: input.action, reason: input.reason }),
    onSuccess: () => {
      setDeciding(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: keys.breaches() });
      void qc.invalidateQueries({ queryKey: keys.vialsRoot() });
    },
  });

  const holds = (breaches.data ?? []).filter((b) => b.holding);
  const unreported = (aefi.data ?? []).filter((a) => a.firOverdue);
  const usableVials = vials.data ?? [];
  const recall = overdue.data ?? [];

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Immunisation"
        description="What the session can draw from, what is held, and who is overdue — the three facts that decide whether the morning runs."
      />

      {unreported.length > 0 ? (
        <section
          aria-label="Adverse events awaiting a statutory report"
          className="rounded-lg border border-danger bg-danger-subtle p-4"
        >
          <h2 className="text-sm font-semibold text-fg-danger">
            {unreported.length} serious adverse {unreported.length === 1 ? 'event has' : 'events have'} no
            first information report
          </h2>
          <p className="mt-1 text-xs text-fg-muted">
            The statutory clock is twenty-four hours from the report, and the district programme officer is
            not on this system. The event cannot be closed until it has gone.
          </p>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {unreported.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-danger bg-layer-1 p-3"
              >
                <Badge tone="danger">{event.severity}</Badge>
                <span className="font-mono text-xs">onset {new Date(event.onsetAt).toLocaleString()}</span>
                <span className="text-fg-muted">
                  {event.vaccinationRecordIds.length}{' '}
                  {event.vaccinationRecordIds.length === 1 ? 'dose' : 'doses'} implicated
                </span>
                {event.pirDueAt === null ? null : (
                  <span className="text-fg-muted">
                    preliminary report due {new Date(event.pirDueAt).toLocaleDateString()}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {holds.length > 0 ? (
        <section
          aria-label="Batches held after a cold chain breach"
          className="rounded-lg border border-warning-border bg-warning-surface p-4"
        >
          <h2 className="text-sm font-semibold text-warning-on-surface">
            {holds.length} cold chain {holds.length === 1 ? 'breach is' : 'breaches are'} holding vaccine
          </h2>
          <p className="mt-1 text-xs text-warning-on-surface">
            Every dose from these batches is refused until somebody decides whether the vaccine is still
            viable. A held batch that can still be given is a note in a book.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {holds.map((breach) => (
              <li key={breach.id} className="rounded-md border border-warning-border bg-layer-1 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone="warning">peak {breach.peakC} °C</Badge>
                  <span className="font-mono text-xs">{new Date(breach.startedAt).toLocaleString()}</span>
                  {breach.durationMin === null ? null : (
                    <span className="text-fg-muted">{breach.durationMin} min</span>
                  )}
                  <span className="text-fg-muted">
                    {breach.batchesAffected.length}{' '}
                    {breach.batchesAffected.length === 1 ? 'batch' : 'batches'}:{' '}
                    {breach.batchesAffected.join(', ')}
                  </span>
                </div>

                {canDecide ? (
                  deciding === breach.id ? (
                    <form
                      className="mt-3 flex flex-wrap items-end gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        decide.mutate({ id: breach.id, action: 'released', reason });
                      }}
                    >
                      <label className="flex flex-col gap-1 text-xs">
                        <span className="font-medium">What the data logger and the vial monitors show</span>
                        <input
                          className="w-96 rounded border border-control bg-layer-1 px-2 py-1 text-sm"
                          value={reason}
                          onChange={(event) => setReason(event.target.value)}
                          placeholder="Excursion under two hours; VVM stage 1 on inspection."
                          required
                          minLength={8}
                        />
                      </label>
                      <Button type="submit" size="sm" disabled={decide.isPending}>
                        Release the batch
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        disabled={decide.isPending || reason.length < 8}
                        onClick={() => decide.mutate({ id: breach.id, action: 'discarded', reason })}
                      >
                        Condemn it
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setDeciding(null);
                          setReason('');
                        }}
                      >
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <Button className="mt-2" size="sm" onClick={() => setDeciding(breach.id)}>
                      Decide
                    </Button>
                  )
                ) : (
                  <p className="mt-2 text-xs text-fg-muted">
                    Deciding a breach puts every dose from these batches back into arms, so it is a named
                    decision rather than a queue somebody clears.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Open vials" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">On the bench</h2>
        <AsyncPanel
          loading={vials.isPending}
          error={vials.error}
          isEmpty={usableVials.length === 0}
          skeletonLabel="Loading open vials"
          skeletonRows={4}
          onRetry={() => void vials.refetch()}
          empty={
            <EmptyState
              cause="No vial is open and usable."
              nextAction="Open one when the first patient arrives; its discard time is set from the vaccine's own policy at the puncture."
            />
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <caption className="sr-only">
                Open vials, soonest to expire first. The discard time comes from the vaccine&rsquo;s open-vial
                policy and the doses drawn are counted by the server.
              </caption>
              <thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
                <tr>
                  <th scope="col" className="py-2">
                    Batch
                  </th>
                  <th scope="col">Opened</th>
                  <th scope="col">Doses left</th>
                  <th scope="col">Time left</th>
                  <th scope="col">Use by</th>
                </tr>
              </thead>
              <tbody>
                {usableVials.map((vial) => (
                  <tr key={vial.id} className="border-t border-default">
                    <td className="py-2 font-mono text-xs">{vial.batchNo}</td>
                    <td className="font-mono text-xs">{new Date(vial.openedAt).toLocaleTimeString()}</td>
                    <td>
                      {vial.dosesLeft} of {vial.dosesTotal}
                    </td>
                    <td>
                      <ClockChip vial={vial} />
                    </td>
                    <td className="font-mono text-xs">{new Date(vial.discardDueAt).toLocaleTimeString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AsyncPanel>
      </section>

      <section aria-label="Overdue doses" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Overdue</h2>
        <AsyncPanel
          loading={overdue.isPending}
          error={overdue.error}
          isEmpty={recall.length === 0}
          skeletonLabel="Loading the recall list"
          skeletonRows={5}
          onRetry={() => void overdue.refetch()}
          empty={
            <EmptyState
              cause="Nobody on the register is overdue."
              nextAction="Doses appear here the day after they fall due, sorted by how far behind they are."
            />
          }
        >
          <ul className="flex flex-col gap-2 text-sm">
            {recall.map((dose) => (
              <li
                key={dose.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-default bg-layer-1 p-3"
              >
                <Badge tone={(dose.daysOverdue ?? 0) > 60 ? 'danger' : 'warning'}>
                  {dose.daysOverdue} days overdue
                </Badge>
                <span className="font-medium">
                  {dose.antigenCode} dose {dose.doseNo}
                </span>
                <span className="font-mono text-xs text-fg-muted">
                  due {new Date(dose.dueDate).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </AsyncPanel>
      </section>
    </section>
  );
}

/**
 * How long is left on the vial.
 *
 * The same discard time the trigger refuses against, so a nurse who sees
 * "12 min" and a dose that is refused at minute thirteen are looking at one
 * number.
 */
function ClockChip({ vial }: { readonly vial: VialRow }): React.JSX.Element {
  if (vial.minutesLeft === null) return <span className="text-fg-muted">—</span>;
  const tone = vial.minutesLeft <= 30 ? 'danger' : vial.minutesLeft <= 60 ? 'warning' : 'neutral';
  return (
    <Badge tone={tone}>
      {vial.minutesLeft < 60
        ? `${vial.minutesLeft} min`
        : `${Math.floor(vial.minutesLeft / 60)} h ${vial.minutesLeft % 60} min`}
    </Badge>
  );
}
