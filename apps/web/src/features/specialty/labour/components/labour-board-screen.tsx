'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { decide, getActivations, getEpisode, getEpisodes, getNewborns } from '../api/client';
import { labourKeys } from '../api/keys';
import type { LabourEpisodeDetail, LabourEpisodeRow, NewbornRow, PphActivationRow } from '../api/types';

/** The five things the action line names. Not free text, on purpose. */
const DECISIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'augment', label: 'Augment' },
  { value: 'assist', label: 'Assisted delivery' },
  { value: 'caesarean', label: 'Caesarean' },
  { value: 'refer', label: 'Refer' },
  { value: 'continue_expectantly', label: 'Continue, because…' },
];

/**
 * IP-011 — the labour board.
 *
 * ── Three things sit above everything else ─────────────────────────────────
 *
 * A chart stopped at the action line, a haemorrhage protocol running, and a
 * wristband pair that did not match. Each is a person who needs somebody now,
 * and each is invisible on a board sorted by bed number.
 *
 * ── And the second-stage clock counts down rather than up ──────────────────
 *
 * "Ninety minutes" tells a midwife nothing. "Thirty minutes left of two hours"
 * tells her whether to call somebody, and it is the same subtraction the
 * database does before it raises the alert.
 */
export function LabourBoardScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = labourKeys(hospitalId);
  const qc = useQueryClient();

  const canDecide = granted.has('obs.partograph.decide');
  const [openId, setOpenId] = useState<string | null>(null);
  const [decision, setDecision] = useState('augment');
  const [note, setNote] = useState('');

  const episodes = useQuery({
    queryKey: keys.episodes('open'),
    queryFn: ({ signal }) => getEpisodes({ openOnly: true }, { signal }),
    refetchInterval: 20_000,
  });

  const activations = useQuery({
    queryKey: keys.activations(),
    queryFn: ({ signal }) => getActivations({ signal }),
    refetchInterval: 20_000,
  });

  const newborns = useQuery({
    queryKey: keys.newborns('report-due'),
    queryFn: ({ signal }) => getNewborns({ reportDueOnly: true }, { signal }),
    refetchInterval: 300_000,
  });

  const detail = useQuery({
    queryKey: keys.episode(openId ?? 'none'),
    queryFn: ({ signal }) => getEpisode(openId ?? '', { signal }),
    enabled: openId !== null,
    refetchInterval: 20_000,
  });

  const record = useMutation({
    mutationFn: (input: { alertId: string; decision: string; note: string }) =>
      decide(
        input.alertId,
        input.note.trim() === ''
          ? { decision: input.decision }
          : { decision: input.decision, decisionNote: input.note },
      ),
    onSuccess: () => {
      setNote('');
      void qc.invalidateQueries({ queryKey: keys.episodesRoot() });
      if (openId !== null) void qc.invalidateQueries({ queryKey: keys.episode(openId) });
    },
  });

  const rows = episodes.data ?? [];
  const blocked = rows.filter((e) => e.chartBlocked);
  const bleeding = (activations.data ?? []).filter((a) => a.deactivatedAt === null);
  const unmatched = (newborns.data ?? []).filter((n) => n.blockedBy.length > 0);
  const reportsDue = (newborns.data ?? []).filter((n) => !n.reportSubmitted && (n.reportDaysLeft ?? 99) <= 7);

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Labour room"
        description="Who is in labour, where they are against the line, and the three things that need somebody now — a stopped chart, a haemorrhage, and a wristband that did not match."
      />

      {bleeding.length > 0 ? (
        <section
          aria-label="Haemorrhage protocols running"
          className="rounded-lg border border-danger bg-danger-subtle p-4"
        >
          <h2 className="text-sm font-semibold text-fg-danger">
            {bleeding.length} postpartum haemorrhage {bleeding.length === 1 ? 'protocol is' : 'protocols are'}{' '}
            running
          </h2>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {bleeding.map((activation) => (
              <BleedLine key={activation.id} activation={activation} />
            ))}
          </ul>
        </section>
      ) : null}

      {unmatched.length > 0 ? (
        <section
          aria-label="Wristband mismatches"
          className="rounded-lg border border-danger bg-danger-subtle p-4"
        >
          <h2 className="text-sm font-semibold text-fg-danger">
            {unmatched.length} {unmatched.length === 1 ? 'baby has' : 'babies have'} an unresolved wristband
            check
          </h2>
          <p className="mt-1 text-xs text-fg-muted">
            The other explanation for two bands that disagree is that two babies have been exchanged. None of
            these can be moved until a scan matches, and there is no way to override that.
          </p>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {unmatched.map((baby) => (
              <li
                key={baby.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-danger bg-layer-1 p-3"
              >
                <span className="font-mono text-xs">{baby.wristbandPairCode}</span>
                <span className="text-fg-muted">{baby.blockedBy.join('; ')}</span>
                {baby.lastCheckAt === null ? null : (
                  <span className="font-mono text-xs text-fg-muted">
                    last scan {new Date(baby.lastCheckAt).toLocaleTimeString()}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {blocked.length > 0 ? (
        <section
          aria-label="Charts stopped at the action line"
          className="rounded-lg border border-warning-border bg-warning-surface p-4"
        >
          <h2 className="text-sm font-semibold text-warning-on-surface">
            {blocked.length} {blocked.length === 1 ? 'chart is' : 'charts are'} stopped at the action line
          </h2>
          <p className="mt-1 text-xs text-warning-on-surface">
            The point of the line is that one of five things now happens. Observations of mother and baby keep
            going on; it is the chart that has stopped.
          </p>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {blocked.map((episode) => (
              <li
                key={episode.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-warning-border bg-layer-1 p-3"
              >
                <Badge tone="warning">{episode.hoursBehind} h behind</Badge>
                <span>
                  {episode.latestCm} cm, expected {episode.expectedCm}
                </span>
                {episode.blockedSince === null ? null : (
                  <span className="font-mono text-xs text-fg-muted">
                    since {new Date(episode.blockedSince).toLocaleTimeString()}
                  </span>
                )}
                <Button size="sm" onClick={() => setOpenId(episode.id)}>
                  Open the chart
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {reportsDue.length > 0 ? (
        <p className="rounded-md border border-warning-border bg-warning-surface p-3 text-xs text-warning-on-surface">
          {reportsDue.length} birth {reportsDue.length === 1 ? 'report is' : 'reports are'} within a week of
          the twenty-one-day deadline. After it the family needs a magistrate, and they find out when the
          child is five and needs a school place.
        </p>
      ) : null}

      <AsyncPanel
        loading={episodes.isPending}
        error={episodes.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading the labour board"
        skeletonRows={5}
        onRetry={() => void episodes.refetch()}
        empty={
          <EmptyState
            cause="Nobody is in labour."
            nextAction="Admit a woman in labour; the chart's two lines are drawn from the moment the active phase begins."
          />
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
            <caption className="sr-only">
              Labours in progress. The expected dilatation is the alert line at this moment, and the
              second-stage clock counts down from full dilatation.
            </caption>
            <thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
              <tr>
                <th scope="col" className="py-2">
                  Parity
                </th>
                <th scope="col">Dilatation</th>
                <th scope="col">Against the line</th>
                <th scope="col">Second stage</th>
                <th scope="col">Alerts</th>
                <th scope="col">Babies</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((episode) => (
                <tr
                  key={episode.id}
                  className="cursor-pointer border-t border-default hover:bg-layer-3"
                  onClick={() => setOpenId(episode.id)}
                >
                  <td className="py-2">
                    {episode.parity === 0 ? 'First baby' : `Para ${String(episode.parity)}`}
                    {episode.epidural ? <span className="ml-1 text-fg-muted">· epidural</span> : null}
                  </td>
                  <td>{episode.latestCm === null ? '—' : `${String(episode.latestCm)} cm`}</td>
                  <td>
                    <LineChip episode={episode} />
                  </td>
                  <td>
                    <SecondStageChip episode={episode} />
                  </td>
                  <td>
                    {episode.openAlerts === 0 ? (
                      <span className="text-fg-muted">—</span>
                    ) : (
                      <Badge tone="warning">{episode.openAlerts}</Badge>
                    )}
                  </td>
                  <td>{episode.babies}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      {openId === null || detail.data === undefined ? null : (
        <Chart
          detail={detail.data}
          canDecide={canDecide}
          busy={record.isPending}
          decision={decision}
          note={note}
          onDecision={setDecision}
          onNote={setNote}
          onRecord={(alertId) => record.mutate({ alertId, decision, note })}
          onClose={() => setOpenId(null)}
        />
      )}
    </section>
  );
}

function LineChip({ episode }: { readonly episode: LabourEpisodeRow }): React.JSX.Element {
  if (episode.hoursBehind === null) return <span className="text-fg-muted">—</span>;
  const tone = episode.chartBlocked ? 'danger' : episode.hoursBehind > 0 ? 'warning' : 'success';
  return (
    <Badge tone={tone}>
      {episode.hoursBehind === 0 ? 'on the line' : `${String(episode.hoursBehind)} h behind`}
    </Badge>
  );
}

/**
 * Counting down rather than up. "Ninety minutes" tells a midwife nothing;
 * "thirty left of two hours" tells her whether to call somebody.
 */
function SecondStageChip({ episode }: { readonly episode: LabourEpisodeRow }): React.JSX.Element {
  if (episode.secondStageMinutesLeft === null || episode.secondStageLimitMin === null) {
    return <span className="text-fg-muted">—</span>;
  }
  const left = episode.secondStageMinutesLeft;
  const tone = left < 0 ? 'danger' : left < 30 ? 'warning' : 'neutral';
  return (
    <Badge tone={tone}>
      {left < 0
        ? `${String(Math.abs(left))} min over ${String(episode.secondStageLimitMin)}`
        : `${String(left)} min left of ${String(episode.secondStageLimitMin)}`}
    </Badge>
  );
}

function BleedLine({ activation }: { readonly activation: PphActivationRow }): React.JSX.Element {
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border border-danger bg-layer-1 p-3">
      <Badge tone="danger">{activation.eblAtTrigger ?? '—'} mL</Badge>
      <span className="font-mono text-xs">since {new Date(activation.activatedAt).toLocaleTimeString()}</span>
      {/* Within three hours it reduces death from bleeding. After, it does not. */}
      {activation.txaAt !== null ? (
        <Badge tone={activation.txaWithin3h === true ? 'success' : 'warning'}>
          tranexamic acid {activation.txaWithin3h === true ? 'in window' : 'outside three hours'}
        </Badge>
      ) : activation.txaMinutesLeft !== null ? (
        <Badge tone={activation.txaMinutesLeft < 30 ? 'danger' : 'warning'}>
          {activation.txaMinutesLeft} min left to give tranexamic acid
        </Badge>
      ) : null}
      <span className="text-xs text-fg-muted">{activation.steps.length} steps recorded</span>
    </li>
  );
}

function Chart({
  detail,
  canDecide,
  busy,
  decision,
  note,
  onDecision,
  onNote,
  onRecord,
  onClose,
}: {
  readonly detail: LabourEpisodeDetail;
  readonly canDecide: boolean;
  readonly busy: boolean;
  readonly decision: string;
  readonly note: string;
  readonly onDecision: (value: string) => void;
  readonly onNote: (value: string) => void;
  readonly onRecord: (alertId: string) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { episode, entries, alerts, deliveries, newborns } = detail;
  const dilatations = entries.filter((e) => e.param === 'dilatation');
  const open = alerts.filter((a) => a.decision === null);

  return (
    <section aria-label="The chart" className="rounded-lg border border-default bg-layer-1 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">
          {episode.parity === 0 ? 'First baby' : `Para ${String(episode.parity)}`} · {episode.latestCm ?? '—'}{' '}
          cm
          {episode.expectedCm === null ? null : (
            <span className="ml-2 text-xs font-normal text-fg-muted">
              the line expects {episode.expectedCm}
            </span>
          )}
        </h2>
        <button type="button" onClick={onClose} className="text-sm text-fg-link hover:underline">
          Close
        </button>
      </div>

      {open.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2">
          {open.map((alert) => (
            <li
              key={alert.id}
              className={[
                'rounded-md border p-3 text-sm',
                alert.blocking
                  ? 'border-danger bg-danger-subtle'
                  : 'border-warning-border bg-warning-surface',
              ].join(' ')}
            >
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone={alert.blocking ? 'danger' : 'warning'}>{alert.kind.replace(/_/gu, ' ')}</Badge>
                <span className="font-mono text-xs">{new Date(alert.raisedAt).toLocaleTimeString()}</span>
                {alert.blocking ? (
                  <span className="text-xs text-fg-danger">the chart will not advance</span>
                ) : null}
              </div>

              {canDecide && alert.blocking ? (
                <form
                  className="mt-2 flex flex-wrap items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    onRecord(alert.id);
                  }}
                >
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="font-medium">Decision</span>
                    <select
                      className="rounded border border-control bg-layer-1 px-2 py-1 text-sm"
                      value={decision}
                      onChange={(event) => onDecision(event.target.value)}
                    >
                      {DECISIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="font-medium">
                      {decision === 'continue_expectantly' ? 'Why (required)' : 'Note'}
                    </span>
                    <input
                      className="w-96 rounded border border-control bg-layer-1 px-2 py-1 text-sm"
                      value={note}
                      onChange={(event) => onNote(event.target.value)}
                      placeholder="Oxytocin at 2 mU/min; reassess in two hours."
                      required={decision === 'continue_expectantly'}
                      minLength={decision === 'continue_expectantly' ? 8 : 0}
                    />
                  </label>
                  <Button type="submit" size="sm" disabled={busy}>
                    Record it
                  </Button>
                </form>
              ) : alert.blocking ? (
                <p className="mt-2 text-xs text-fg-muted">
                  The decision at the line is a doctor&rsquo;s — augment, assist, deliver, refer, or continue
                  with a reason.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section aria-label="Dilatation">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Dilatation</h3>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {dilatations.slice(-8).map((entry) => (
              <li key={entry.id} className="flex items-center gap-3">
                <span className="font-mono text-xs">
                  {new Date(entry.recordedAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span>{entry.dilatationCm} cm</span>
              </li>
            ))}
            {dilatations.length === 0 ? <li className="text-xs text-fg-muted">Nothing plotted.</li> : null}
          </ul>
        </section>

        <section aria-label="Babies">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Babies</h3>
          <ul className="mt-2 flex flex-col gap-2 text-sm">
            {newborns.map((baby) => (
              <BabyLine key={baby.id} baby={baby} />
            ))}
            {deliveries.length > 0 && newborns.length === 0 ? (
              <li className="text-xs text-fg-muted">A delivery is recorded with no baby against it.</li>
            ) : null}
            {deliveries.length === 0 ? <li className="text-xs text-fg-muted">Not yet delivered.</li> : null}
          </ul>
        </section>
      </div>

      {deliveries.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-1 text-xs text-fg-muted">
          {deliveries.map((delivery) => (
            <li key={delivery.id} className="flex flex-wrap items-center gap-3">
              <span className="font-medium">Baby {delivery.babySeq}</span>
              <span>{delivery.mode.replace(/_/gu, ' ')}</span>
              {/* The single most effective thing anybody does about the leading
                  cause of maternal death, and it is a one-minute window. */}
              {delivery.uterotonicDelaySec === null ? (
                <Badge tone="warning">no uterotonic recorded</Badge>
              ) : (
                <Badge tone={delivery.uterotonicWithin1Min === true ? 'success' : 'warning'}>
                  uterotonic at {delivery.uterotonicDelaySec} s
                </Badge>
              )}
              {delivery.eblMl === null ? null : (
                <Badge tone={delivery.eblMl >= delivery.pphThresholdMl ? 'danger' : 'neutral'}>
                  {delivery.eblMl} mL of {delivery.pphThresholdMl}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function BabyLine({ baby }: { readonly baby: NewbornRow }): React.JSX.Element {
  return (
    <li className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-xs">{baby.wristbandPairCode}</span>
      <Badge tone={baby.status === 'live' ? 'success' : 'neutral'}>{baby.status.replace(/_/gu, ' ')}</Badge>
      {baby.birthWeightG === null ? null : <span>{baby.birthWeightG} g</span>}
      {baby.apgar1 === null ? null : (
        <span className="text-xs text-fg-muted">
          APGAR {baby.apgar1}/{baby.apgar5}
          {baby.apgar10 === null ? '' : `/${String(baby.apgar10)}`}
        </span>
      )}
      {baby.blockedBy.length > 0 ? <Badge tone="danger">{baby.blockedBy[0]}</Badge> : null}
    </li>
  );
}
