'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { getHcEpisode, getHcEpisodes, updateStation } from '../api/client';
import { programmeKeys } from '../api/keys';
import type { HcEpisodeDetail, HcStationRow } from '../api/types';

/**
 * OP-014 — the health check floor.
 *
 * ── The board shows what is ready, not what is refused ─────────────────────
 *
 * `ready` and `blockedBy` come from the server, computed from the same
 * dependencies the trigger enforces. A station that cannot start yet is shown
 * greyed with what it is waiting for, so nobody calls a patient to a room that
 * will send them back — which is the whole of routing-slip management in a
 * building where forty people are walking at once.
 *
 * ── Skipping asks for the reason before it will let you ────────────────────
 *
 * Not after. The reason appears on the report, and the person who has it is the
 * one standing in front of the patient who just declined the ultrasound.
 */
export function HealthCheckScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = programmeKeys(hospitalId);
  const qc = useQueryClient();

  const [openId, setOpenId] = useState<string | null>(null);
  const [skipping, setSkipping] = useState<string | null>(null);
  const [skipReason, setSkipReason] = useState('');

  const episodes = useQuery({
    queryKey: keys.hcEpisodes('in-progress'),
    queryFn: ({ signal }) => getHcEpisodes({ inProgressOnly: true }, { signal }),
    refetchInterval: 30_000,
  });

  const detail = useQuery({
    queryKey: keys.hcEpisode(openId ?? 'none'),
    queryFn: ({ signal }) => getHcEpisode(openId ?? '', { signal }),
    enabled: openId !== null,
    refetchInterval: 30_000,
  });

  const advance = useMutation({
    mutationFn: (input: { id: string; status: string; skipReason?: string }) =>
      updateStation(
        input.id,
        input.skipReason === undefined
          ? { status: input.status }
          : { status: input.status, skipReason: input.skipReason },
      ),
    onSuccess: () => {
      setSkipping(null);
      setSkipReason('');
      void qc.invalidateQueries({ queryKey: keys.hcEpisodesRoot() });
      if (openId !== null) void qc.invalidateQueries({ queryKey: keys.hcEpisode(openId) });
    },
  });

  const rows = episodes.data ?? [];

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Health check-ups"
        description="Who is in the building, which station each of them can go to next, and what still stands between a check and its report."
      />

      <AsyncPanel
        loading={episodes.isPending}
        error={episodes.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading health checks"
        skeletonRows={6}
        onRetry={() => void episodes.refetch()}
        empty={
          <EmptyState
            cause="Nobody is walking a routing slip."
            nextAction="Check a booking in; the slip is raised from the package's station sequence at the door."
          />
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-sm">
            <caption className="sr-only">
              Health checks in progress. Stations resolved counts those done, skipped or judged not
              applicable; a report cannot be signed until that is all of them.
            </caption>
            <thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
              <tr>
                <th scope="col" className="py-2">
                  Slip
                </th>
                <th scope="col">Checked in</th>
                <th scope="col">Progress</th>
                <th scope="col">Report blocked by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((episode) => (
                <tr
                  key={episode.id}
                  className="cursor-pointer border-t border-default hover:bg-layer-3"
                  onClick={() => setOpenId(episode.id)}
                >
                  <td className="py-2 font-mono text-xs">{episode.routingSlipNo}</td>
                  <td className="font-mono text-xs">{new Date(episode.checkedInAt).toLocaleTimeString()}</td>
                  <td>
                    <Badge tone={episode.stationsResolved === episode.stationsTotal ? 'success' : 'neutral'}>
                      {episode.stationsResolved} of {episode.stationsTotal}
                    </Badge>
                  </td>
                  <td className="text-fg-muted">
                    {episode.reportBlockedBy.length === 0 ? 'nothing' : episode.reportBlockedBy.join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      {openId === null || detail.data === undefined ? null : (
        <RoutingSlip
          detail={detail.data}
          busy={advance.isPending}
          skipping={skipping}
          skipReason={skipReason}
          onSkipReason={setSkipReason}
          onStartSkip={(id) => {
            setSkipping(id);
            setSkipReason('');
          }}
          onCancelSkip={() => {
            setSkipping(null);
            setSkipReason('');
          }}
          onAdvance={(id, status, reason) => {
            advance.mutate(reason === undefined ? { id, status } : { id, status, skipReason: reason });
          }}
          onClose={() => setOpenId(null)}
        />
      )}
    </section>
  );
}

function RoutingSlip({
  detail,
  busy,
  skipping,
  skipReason,
  onSkipReason,
  onStartSkip,
  onCancelSkip,
  onAdvance,
  onClose,
}: {
  readonly detail: HcEpisodeDetail;
  readonly busy: boolean;
  readonly skipping: string | null;
  readonly skipReason: string;
  readonly onSkipReason: (value: string) => void;
  readonly onStartSkip: (id: string) => void;
  readonly onCancelSkip: () => void;
  readonly onAdvance: (id: string, status: string, reason?: string) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  return (
    <section aria-label="Routing slip" className="rounded-lg border border-default bg-layer-1 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">
          Slip {detail.episode.routingSlipNo} · {detail.episode.stationsResolved} of{' '}
          {detail.episode.stationsTotal} resolved
        </h2>
        <button type="button" onClick={onClose} className="text-sm text-fg-link hover:underline">
          Close
        </button>
      </div>

      <ol className="mt-3 flex flex-col gap-2">
        {detail.stations.map((station) => (
          <li
            key={station.id}
            className={[
              'rounded-md border p-3 text-sm',
              station.ready || station.status === 'done'
                ? 'border-default'
                : 'border-default bg-layer-3 text-fg-muted',
            ].join(' ')}
          >
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-xs">{station.seq}</span>
              <span className="font-medium capitalize">{station.station.replace(/_/g, ' ')}</span>
              <StatusChip station={station} />
              {station.waitMin === null ? null : (
                <span className="text-xs text-fg-muted">waited {station.waitMin} min</span>
              )}
              {/* What it is waiting for, in the words the refusal would use. */}
              {station.blockedBy.length > 0 ? (
                <span className="text-xs text-fg-muted">waiting on {station.blockedBy.join(', ')}</span>
              ) : null}
              {station.skipReason === null ? null : <span className="text-xs">{station.skipReason}</span>}
            </div>

            {station.ready && station.status !== 'done' && station.status !== 'skipped' ? (
              skipping === station.id ? (
                <form
                  className="mt-2 flex flex-wrap items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    onAdvance(station.id, 'skipped', skipReason);
                  }}
                >
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="font-medium">Why this station was not done</span>
                    <input
                      className="w-96 rounded border border-control bg-layer-1 px-2 py-1 text-sm"
                      value={skipReason}
                      onChange={(event) => onSkipReason(event.target.value)}
                      placeholder="Patient declined; advised to arrange it with their GP."
                      required
                      minLength={4}
                    />
                  </label>
                  {/* It goes on the report — which is what makes a skipped
                      station different from a scan nobody did. */}
                  <Button type="submit" size="sm" disabled={busy}>
                    Skip, with this on the report
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={onCancelSkip}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  {station.status === 'pending' ? (
                    <Button size="sm" disabled={busy} onClick={() => onAdvance(station.id, 'called')}>
                      Call
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => onAdvance(station.id, 'done')}
                  >
                    Done
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => onStartSkip(station.id)}>
                    Skip
                  </Button>
                </div>
              )
            ) : null}
          </li>
        ))}
      </ol>

      {detail.episode.reportBlockedBy.length > 0 ? (
        <p className="mt-3 text-xs text-fg-muted">
          A report cannot be signed while {detail.episode.reportBlockedBy.join(', ')}{' '}
          {detail.episode.reportBlockedBy.length === 1 ? 'is' : 'are'} outstanding. Finish each one, or skip
          it with a reason that goes on the report.
        </p>
      ) : null}
    </section>
  );
}

function StatusChip({ station }: { readonly station: HcStationRow }): React.JSX.Element {
  const tone =
    station.status === 'done'
      ? 'success'
      : station.status === 'skipped' || station.status === 'not_applicable'
        ? 'warning'
        : station.status === 'in_progress'
          ? 'accent'
          : 'neutral';
  return <Badge tone={tone}>{station.status.replace(/_/g, ' ')}</Badge>;
}
