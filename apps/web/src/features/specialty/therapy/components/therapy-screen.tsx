'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { getEpisode, getEpisodes } from '../api/client';
import { therapyKeys } from '../api/keys';
import type { EpisodeRow, GoalRow } from '../api/types';

const DISCIPLINES = [
  { key: '', label: 'All' },
  { key: 'physio', label: 'Physio & rehab' },
  { key: 'wound', label: 'Wound care' },
  { key: 'nutrition', label: 'Dietetics' },
  { key: 'speech', label: 'Speech & swallow' },
] as const;

/**
 * OP-015 — the therapy floor, shared by four disciplines.
 *
 * ── The two numbers a therapist needs before booking ───────────────────────
 *
 * How many sessions are left, and what is blocking a discharge. Both come from
 * the API rather than being counted here, and both are the same facts the
 * database refuses on — so the chip that says "no sessions left" and the
 * refusal that would follow are one statement, not two implementations that
 * will eventually disagree.
 *
 * ── The goals are the outcome ──────────────────────────────────────────────
 *
 * A discharge is refused while any goal is open, and the list says so on the
 * row rather than after the click. A department's whole account of itself is
 * the resolved goals, and an episode discharged with three open ones is three
 * outcomes that silently never existed.
 */
export function TherapyScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = therapyKeys(hospitalId);

  const [discipline, setDiscipline] = useState<string>('');
  const [openId, setOpenId] = useState<string | null>(null);

  const episodes = useQuery({
    queryKey: keys.episodes(discipline === '' ? 'open' : `open:${discipline}`),
    queryFn: ({ signal }) =>
      getEpisodes(discipline === '' ? { openOnly: true } : { openOnly: true, discipline }, { signal }),
    refetchInterval: 120_000,
  });

  const detail = useQuery({
    queryKey: keys.episode(openId ?? 'none'),
    queryFn: ({ signal }) => getEpisode(openId ?? '', { signal }),
    enabled: openId !== null,
  });

  const rows = episodes.data ?? [];

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Therapy"
        description="Courses of treatment across physiotherapy, wound care, dietetics and speech — one episode, one plan, and the sessions delivered against it."
      />

      <nav aria-label="Discipline" className="flex flex-wrap gap-2">
        {DISCIPLINES.map((d) => (
          <button
            key={d.key === '' ? 'all' : d.key}
            type="button"
            onClick={() => setDiscipline(d.key)}
            aria-pressed={discipline === d.key}
            className="rounded-full border border-default px-3 py-1 text-sm hover:bg-layer-3 aria-pressed:border-accent-border aria-pressed:bg-accent-surface aria-pressed:text-accent-on-surface"
          >
            {d.label}
          </button>
        ))}
      </nav>

      <AsyncPanel
        loading={episodes.isPending}
        error={episodes.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading therapy episodes"
        skeletonRows={6}
        onRetry={() => void episodes.refetch()}
        empty={
          <EmptyState
            cause="No course of therapy is open in this discipline."
            nextAction="Open one from a referral, or from a patient who referred themselves."
          />
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[54rem] text-sm">
            <caption className="sr-only">
              Open therapy episodes. Sessions remaining and what blocks a discharge are counted by the server,
              so they match the rules that would refuse the next action.
            </caption>
            <thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
              <tr>
                <th scope="col" className="py-2">
                  Opened
                </th>
                <th scope="col">Discipline</th>
                <th scope="col">Diagnosis</th>
                <th scope="col">Sessions</th>
                <th scope="col">Goals</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((episode) => (
                <tr
                  key={episode.id}
                  className="cursor-pointer border-t border-default hover:bg-layer-3"
                  onClick={() => setOpenId(episode.id)}
                >
                  <td className="py-2 font-mono text-xs">
                    {new Date(episode.openedAt).toLocaleDateString()}
                  </td>
                  <td className="capitalize">{episode.discipline}</td>
                  <td className="font-mono text-xs">{episode.diagnosisIcd10 ?? '—'}</td>
                  <td>
                    <SessionChip episode={episode} />
                  </td>
                  <td>
                    {episode.goalsTotal === 0 ? (
                      <span className="text-fg-muted">none set</span>
                    ) : (
                      <span>
                        {episode.goalsTotal - episode.goalsOpen} of {episode.goalsTotal} resolved
                      </span>
                    )}
                  </td>
                  <td>
                    <Badge tone={episode.status === 'active' ? 'accent' : 'neutral'}>{episode.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      {openId === null || detail.data === undefined ? null : (
        <EpisodePanel
          episode={detail.data.episode}
          goals={detail.data.goals}
          sessions={detail.data.sessions.length}
          onClose={() => setOpenId(null)}
        />
      )}
    </section>
  );
}

/**
 * How many sessions are left, and whether the next one will be refused.
 *
 * Counted by the server against attendances, so a cancelled slot does not eat
 * somebody's package and the chip agrees with what the database will do.
 */
function SessionChip({ episode }: { readonly episode: EpisodeRow }): React.JSX.Element {
  if (episode.sessionsAuthorised === null) {
    return <span className="text-fg-muted">{episode.sessionsDelivered} delivered · open-ended</span>;
  }
  return (
    <Badge tone={episode.authorisationExhausted ? 'warning' : 'neutral'}>
      {episode.sessionsDelivered} of {episode.sessionsAuthorised}
      {episode.authorisationExhausted ? ' · needs extending' : ''}
    </Badge>
  );
}

function EpisodePanel({
  episode,
  goals,
  sessions,
  onClose,
}: {
  readonly episode: EpisodeRow;
  readonly goals: readonly GoalRow[];
  readonly sessions: number;
  readonly onClose: () => void;
}): React.JSX.Element {
  const precautions = Object.entries(episode.precautions);

  return (
    <section aria-label="Episode" className="rounded-lg border border-default bg-layer-1 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold capitalize">
          {episode.discipline} · opened {new Date(episode.openedAt).toLocaleDateString()}
        </h2>
        <button type="button" onClick={onClose} className="text-sm text-fg-link hover:underline">
          Close
        </button>
      </div>

      {precautions.length > 0 ? (
        <ul
          aria-label="Precautions"
          className="mt-3 flex flex-wrap gap-2 rounded-md border border-warning-border bg-warning-surface p-2 text-xs text-warning-on-surface"
        >
          {/* Carried on the episode, not the plan: a precaution outlives the plan
              it was written under, and the therapist reading it at session nine
              was not there at session one. */}
          {precautions.map(([key, value]) => (
            <li key={key}>
              <span className="font-medium">{key}:</span> {String(value)}
            </li>
          ))}
        </ul>
      ) : null}

      {episode.dischargeBlockedBy === null ? null : (
        <p className="mt-3 text-sm text-fg-muted">Cannot be discharged yet — {episode.dischargeBlockedBy}.</p>
      )}

      <dl className="mt-3 flex flex-wrap gap-6 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-wide text-fg-muted">Sessions</dt>
          <dd>{sessions} booked</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-fg-muted">Remaining</dt>
          <dd>{episode.sessionsRemaining ?? 'open-ended'}</dd>
        </div>
      </dl>

      <h3 className="mt-4 text-sm font-semibold">Goals</h3>
      {goals.length === 0 ? (
        <p className="mt-1 text-sm text-fg-muted">
          No goals set. A course with no measurable goal has nothing to report at discharge.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {goals.map((goal) => (
            <li key={goal.id} className="rounded-md border border-default p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{goal.description}</span>
                <Badge
                  tone={goal.status === 'met' ? 'success' : goal.status === 'active' ? 'neutral' : 'warning'}
                >
                  {goal.status.replace(/_/g, ' ')}
                </Badge>
              </div>
              {/* The three fields that make a goal reportable. */}
              <p className="mt-1 text-xs text-fg-muted">
                {goal.metric}: {goal.baseline} → {goal.target}
                {goal.targetDate === null ? '' : ` by ${new Date(goal.targetDate).toLocaleDateString()}`}
              </p>
              {goal.outcomeNote === null ? null : <p className="mt-1 text-xs">{goal.outcomeNote}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
