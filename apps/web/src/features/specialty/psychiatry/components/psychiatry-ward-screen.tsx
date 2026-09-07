'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { closeRestraint, getEpisodes, getRestraints, observeRestraint } from '../api/client';
import { psychiatryKeys } from '../api/keys';
import type { PsyEpisodeRow } from '../api/types';

/**
 * OP-032 — the ward.
 *
 * ── Authorities that are running out come first ────────────────────────────
 *
 * Everything else on this board is clinical. That one is a person who will be
 * detained without authority at a particular hour on a particular day, and the
 * alternatives — discharge, an independent admission, an application to the
 * Review Board — all take time somebody has to be given.
 *
 * ── Then open restraints, with what each one still needs ───────────────────
 *
 * A restraint cannot be closed without observations and without the nominated
 * representative having been told. Both of those are somebody's next five
 * minutes, and both are invisible unless a screen says so.
 */
export function PsychiatryWardScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = psychiatryKeys(hospitalId);
  const qc = useQueryClient();

  const canRecord = granted.has('psy.restraint.record');
  const [observing, setObserving] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const episodes = useQuery({
    queryKey: keys.episodes('active'),
    queryFn: ({ signal }) => getEpisodes({ activeOnly: true }, { signal }),
    refetchInterval: 60_000,
  });

  const restraints = useQuery({
    queryKey: keys.restraints('open'),
    queryFn: ({ signal }) => getRestraints({ openOnly: true }, { signal }),
    refetchInterval: 30_000,
  });

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: keys.restraintsRoot() });
    void qc.invalidateQueries({ queryKey: keys.episodesRoot() });
  };

  const observe = useMutation({
    mutationFn: (input: { id: string; state: string }) => observeRestraint(input.id, input.state),
    onSuccess: () => {
      setObserving(null);
      setNote('');
      invalidate();
    },
  });

  const close = useMutation({
    mutationFn: (id: string) => closeRestraint(id),
    onSuccess: invalidate,
  });

  const rows = episodes.data ?? [];
  const open = restraints.data ?? [];
  const expiring = rows.filter((e) => e.hoursLeftOfAuthority !== null && e.hoursLeftOfAuthority <= 72);
  const boardDue = rows.filter((e) => e.mhrbIntimationDueAt !== null && !e.mhrbIntimated);
  const flagged = rows.filter((e) => e.suicidalityFlagged);

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Mental health ward"
        description="Whose authority to detain is running out, which restraints are still open, and what each of them still needs before it can be closed."
      />

      {expiring.length > 0 ? (
        <section
          aria-label="Authorities running out"
          className="rounded-lg border border-danger bg-danger-subtle p-4"
        >
          <h2 className="text-sm font-semibold text-fg-danger">
            {expiring.length} statutory {expiring.length === 1 ? 'authority is' : 'authorities are'} running
            out
          </h2>
          <p className="mt-1 text-xs text-fg-muted">
            Past it the choices are discharge, an independent admission the person consents to, or the Review
            Board&rsquo;s authority under §90 — and the third is a different admission with a Board reference,
            not a longer version of this one. Holding somebody past their authority is unlawful detention.
          </p>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {expiring.map((episode) => (
              <li
                key={episode.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-danger bg-layer-1 p-3"
              >
                <AuthorityChip episode={episode} />
                <span className="font-mono text-xs">{episode.admissionType?.replace(/_/gu, ' ')}</span>
                {episode.authorityExpiresAt === null ? null : (
                  <span className="text-fg-muted">
                    until {new Date(episode.authorityExpiresAt).toLocaleString()}
                  </span>
                )}
                <CapacityChip episode={episode} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {boardDue.length > 0 ? (
        <p className="rounded-md border border-warning-border bg-warning-surface p-3 text-xs text-warning-on-surface">
          {boardDue.length} supported {boardDue.length === 1 ? 'admission has' : 'admissions have'} not been
          intimated to the Mental Health Review Board. The Act allows seven days, and the person who files it
          is medical records rather than the psychiatrist who admitted.
        </p>
      ) : null}

      {flagged.length > 0 ? (
        <p className="rounded-md border border-danger bg-danger-subtle p-3 text-xs text-fg-danger">
          {flagged.length} {flagged.length === 1 ? 'patient has' : 'patients have'} a positive suicidality
          item on their most recent scale.
        </p>
      ) : null}

      <section aria-label="Open restraints" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Restraints in progress</h2>
        <AsyncPanel
          loading={restraints.isPending}
          error={restraints.error}
          isEmpty={open.length === 0}
          skeletonLabel="Loading restraints"
          skeletonRows={3}
          onRetry={() => void restraints.refetch()}
          empty={
            <EmptyState
              cause="Nobody is restrained."
              nextAction="§97 permits restraint only to prevent imminent harm, and every one is ordered, observed quarter-hourly, and reported to the Board monthly."
            />
          }
        >
          <ul className="flex flex-col gap-2 text-sm">
            {open.map((restraint) => (
              <li key={restraint.id} className="rounded-md border border-danger bg-layer-1 p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone="danger">{restraint.kind}</Badge>
                  <span className="font-mono text-xs">
                    since {new Date(restraint.startedAt).toLocaleTimeString()}
                  </span>
                  <span className="text-fg-muted">{restraint.observations} observations</span>
                </div>
                <p className="mt-1 text-xs text-fg-muted">{restraint.reason}</p>

                {/* What it still needs. Each is somebody's next five minutes. */}
                {restraint.blockedBy.length > 0 ? (
                  <p className="mt-1 text-xs text-fg-danger">
                    cannot be closed until {restraint.blockedBy.join(', ')}
                  </p>
                ) : null}

                {canRecord ? (
                  observing === restraint.id ? (
                    <form
                      className="mt-2 flex flex-wrap items-end gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        observe.mutate({ id: restraint.id, state: note });
                      }}
                    >
                      <label className="flex flex-col gap-1 text-xs">
                        <span className="font-medium">Observation</span>
                        <input
                          className="w-[30rem] rounded border border-control bg-layer-1 px-2 py-1 text-sm"
                          value={note}
                          onChange={(event) => setNote(event.target.value)}
                          placeholder="Settling; airway clear, limbs perfused, fluids offered."
                          required
                        />
                      </label>
                      <Button type="submit" size="sm" disabled={observe.isPending}>
                        Record
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setObserving(null);
                          setNote('');
                        }}
                      >
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() => {
                          setObserving(restraint.id);
                          setNote('');
                        }}
                      >
                        Observe
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={close.isPending || restraint.observations === 0}
                        onClick={() => close.mutate(restraint.id)}
                      >
                        End it
                      </Button>
                    </div>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        </AsyncPanel>
      </section>

      <section aria-label="Episodes" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">On the ward</h2>
        <AsyncPanel
          loading={episodes.isPending}
          error={episodes.error}
          isEmpty={rows.length === 0}
          skeletonLabel="Loading episodes"
          skeletonRows={5}
          onRetry={() => void episodes.refetch()}
          empty={
            <EmptyState
              cause="No episodes are open."
              nextAction="Open one to record scales, assess capacity, and admit under the Act."
            />
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <caption className="sr-only">
                Open mental health episodes. Capacity is presumed until assessed, and each assessment expires.
              </caption>
              <thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
                <tr>
                  <th scope="col" className="py-2">
                    Diagnosis
                  </th>
                  <th scope="col">Risk</th>
                  <th scope="col">Capacity</th>
                  <th scope="col">Admission</th>
                  <th scope="col">Last scale</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((episode) => (
                  <tr key={episode.id} className="border-t border-default">
                    <td className="py-2 font-mono text-xs">{episode.primaryDxIcd10 ?? '—'}</td>
                    <td>
                      <Badge tone={episode.riskLevel === 'high' ? 'danger' : 'neutral'}>
                        {episode.riskLevel}
                      </Badge>
                    </td>
                    <td>
                      <CapacityChip episode={episode} />
                    </td>
                    <td>
                      {episode.admissionType === null ? (
                        <span className="text-fg-muted">—</span>
                      ) : (
                        <AuthorityChip episode={episode} />
                      )}
                    </td>
                    <td className="text-xs">
                      {episode.lastScale === null ? (
                        <span className="text-fg-muted">—</span>
                      ) : (
                        <>
                          {episode.lastScale} {episode.lastScaleTotal}
                          {episode.suicidalityFlagged ? <Badge tone="danger">item 9</Badge> : null}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AsyncPanel>
      </section>
    </section>
  );
}

/**
 * Capacity, and whether the finding still stands.
 *
 * "Presumed" is not the same as "assessed and intact", and the difference is
 * the whole of the Act's first principle — so the chip says which.
 */
function CapacityChip({ episode }: { readonly episode: PsyEpisodeRow }): React.JSX.Element {
  if (!episode.capacityKnown) return <Badge tone="neutral">presumed</Badge>;
  if (!episode.capacityCurrent) {
    return <Badge tone="warning">assessment expired</Badge>;
  }
  return (
    <Badge tone={episode.hasCapacity === true ? 'success' : 'warning'}>
      {episode.hasCapacity === true ? 'has capacity' : 'lacks capacity'}
    </Badge>
  );
}

function AuthorityChip({ episode }: { readonly episode: PsyEpisodeRow }): React.JSX.Element {
  const hours = episode.hoursLeftOfAuthority;
  if (hours === null) return <Badge tone="neutral">no clock</Badge>;
  const tone = hours < 0 ? 'danger' : hours <= 24 ? 'danger' : hours <= 72 ? 'warning' : 'neutral';
  return (
    <Badge tone={tone}>
      {hours < 0 ? `${String(Math.abs(hours))} h past authority` : `${String(hours)} h left`}
    </Badge>
  );
}
