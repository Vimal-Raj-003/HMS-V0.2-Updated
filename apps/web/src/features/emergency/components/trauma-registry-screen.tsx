'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { getBoard } from '../api/client';
import { erKeys } from '../api/keys';
import {
  addInjury,
  amendScore,
  computeScores,
  listInjuries,
  listScores,
  lockScore,
  removeInjury,
} from '../api/trauma-client';
import type { TraumaInjuryView, TraumaScoreView } from '../api/trauma-types';
import type { ErVisitView } from '../api/types';

const AIS_REGIONS = [
  { value: 'head_neck', label: 'Head / neck' },
  { value: 'face', label: 'Face' },
  { value: 'chest', label: 'Chest' },
  { value: 'abdomen', label: 'Abdomen' },
  { value: 'extremity', label: 'Extremity / pelvis' },
  { value: 'external', label: 'External' },
] as const;

/** AIS severity, in the words the scale itself uses. */
const AIS_SEVERITY = [
  { score: 1, label: 'Minor' },
  { score: 2, label: 'Moderate' },
  { score: 3, label: 'Serious' },
  { score: 4, label: 'Severe' },
  { score: 5, label: 'Critical' },
  { score: 6, label: 'Unsurvivable' },
] as const;

const BAND_TONE: Readonly<Record<string, 'success' | 'warning' | 'danger'>> = {
  minor: 'success',
  moderate: 'warning',
  severe: 'danger',
  profound: 'danger',
};

const STATUS_TONE: Readonly<Record<string, 'success' | 'warning' | 'neutral'>> = {
  locked: 'success',
  provisional: 'warning',
  amended: 'neutral',
};

const selectClass = 'h-10 rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

/**
 * TR-001 — the trauma registry.
 *
 * ── Nothing on this screen types a score ────────────────────────────────────
 *
 * You code injuries by AIS region and severity, and the server computes ISS,
 * NISS, RTS, shock index, MGAP and TRISS from them plus the *arrival*
 * physiology. There is no ISS field, because an ISS somebody typed is a number
 * that agrees with nothing.
 *
 * ── Arrival physiology, not current ─────────────────────────────────────────
 *
 * TRISS is a survival probability computed from how the patient was when they
 * came through the door. Recomputing it two hours into a resuscitation produces
 * a number saying they were always going to survive, because by then you have
 * resuscitated them. The server reads the *first* triage record for that reason,
 * and each version below shows the values it used.
 *
 * ── Locking, and the one way back ───────────────────────────────────────────
 *
 * A locked score cannot be edited, unlocked or deleted — the database refuses
 * all three. A correction is a new version carrying a reason, and the superseded
 * version stays visible. "Was the score changed after the death?" has to be
 * answerable either way.
 */
export function TraumaRegistryScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = erKeys(hospitalId);
  const { publish } = useToast();

  const [visitId, setVisitId] = useState<string | null>(null);
  const [region, setRegion] = useState<string>('chest');
  const [severity, setSeverity] = useState('3');
  const [description, setDescription] = useState('');
  const [mechanism, setMechanism] = useState<'blunt' | 'penetrating'>('blunt');
  const [amending, setAmending] = useState<string | null>(null);
  const [amendReason, setAmendReason] = useState('');

  const canCode = granted.has('trauma.injury.record');
  const canCompute = granted.has('trauma.score.compute');
  const canLock = granted.has('trauma.score.lock');
  const canAmend = granted.has('trauma.score.amend');

  const board = useQuery({
    queryKey: keys.board('registry'),
    queryFn: ({ signal }) => getBoard({}, { signal }),
  });
  const visits: readonly ErVisitView[] = board.data?.visits ?? [];

  const injuries = useQuery({
    queryKey: keys.injuries(visitId ?? 'none'),
    queryFn: ({ signal }) => listInjuries(visitId ?? '', { signal }),
    enabled: visitId !== null,
  });
  const coded: readonly TraumaInjuryView[] = injuries.data?.items ?? [];

  const scores = useQuery({
    queryKey: keys.scores(visitId ?? 'none'),
    queryFn: ({ signal }) => listScores(visitId ?? '', { signal }),
    enabled: visitId !== null,
  });
  const versions: readonly TraumaScoreView[] = scores.data?.items ?? [];

  const code = useMutation({
    mutationFn: () =>
      addInjury(visitId ?? '', {
        region,
        aisSeverity: Number(severity),
        description: description.trim(),
      }),
    onSuccess: () => {
      setDescription('');
      void injuries.refetch();
    },
  });

  const uncode = useMutation({
    mutationFn: (injuryId: string) => removeInjury(visitId ?? '', injuryId),
    onSuccess: () => {
      void injuries.refetch();
    },
  });

  const compute = useMutation({
    mutationFn: () => computeScores({ erVisitId: visitId ?? '', mechanism }),
    onSuccess: (score) => {
      void scores.refetch();
      publish({
        title: `ISS ${String(score.iss ?? 0)} · NISS ${String(score.niss ?? 0)}`,
        description:
          score.trissDisplay === null
            ? 'TRISS needs an arrival RTS and an age.'
            : `TRISS ${score.trissDisplay} on ${score.trissCoefficientSet ?? 'MTOS'}`,
        severity: 'success',
      });
    },
  });

  const lock = useMutation({
    mutationFn: (scoreId: string) => lockScore(scoreId),
    onSuccess: () => {
      void scores.refetch();
      publish({
        title: 'Score signed off',
        description: 'It is immutable from now on. A correction becomes a new version.',
        severity: 'success',
      });
    },
  });

  const amend = useMutation({
    mutationFn: (supersedesId: string) =>
      amendScore({ erVisitId: visitId ?? '', supersedesId, mechanism }, amendReason.trim()),
    onSuccess: () => {
      setAmending(null);
      setAmendReason('');
      void scores.refetch();
      publish({ title: 'Amendment recorded', severity: 'success' });
    },
  });

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Trauma registry"
        description="Code the injuries; the scores follow. ISS, NISS, RTS, shock index, MGAP and TRISS are computed, never typed."
      />

      <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
        {/* ── Who to code ───────────────────────────────────────────────── */}
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Recent visits</h2>
          <AsyncPanel
            loading={board.isPending}
            error={board.error}
            isEmpty={visits.length === 0}
            skeletonLabel="Loading visits"
            skeletonRows={5}
            onRetry={() => {
              void board.refetch();
            }}
            empty={
              <EmptyState
                cause="No ER visits to code."
                nextAction="Visits appear here as they are registered at the door."
              />
            }
          >
            <ul className="flex flex-col gap-1" data-testid="registry-visits">
              {visits.map((visit) => (
                <li key={visit.id}>
                  <button
                    type="button"
                    aria-pressed={visitId === visit.id}
                    className={`min-h-12 w-full rounded-lg border px-3 py-2 text-start text-sm ${
                      visitId === visit.id
                        ? 'border-accent-border bg-layer-2 text-fg-default'
                        : 'border-default text-fg-muted hover:text-fg-default'
                    }`}
                    onClick={() => {
                      setVisitId(visit.id);
                    }}
                  >
                    <span className="block truncate">
                      {visit.displayName ?? visit.tempIdentity ?? visit.erNo}
                    </span>
                    <span className="block truncate font-mono text-2xs text-fg-subtle">{visit.erNo}</span>
                  </button>
                </li>
              ))}
            </ul>
          </AsyncPanel>
        </div>

        {/* ── Coding and scores ─────────────────────────────────────────── */}
        <div className="flex flex-col gap-5">
          {visitId === null ? (
            <EmptyState
              cause="No visit is selected."
              nextAction="Choose a patient on the left to code their injuries and compute the scores."
            />
          ) : (
            <>
              <div className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
                <h2 className="text-sm font-medium">Coded injuries</h2>
                {uncode.error === null ? null : <ProblemCard error={uncode.error} />}
                {code.error === null ? null : <ProblemCard error={code.error} />}

                <AsyncPanel
                  loading={injuries.isPending}
                  error={injuries.error}
                  isEmpty={coded.length === 0}
                  skeletonLabel="Loading coded injuries"
                  skeletonRows={3}
                  onRetry={() => {
                    void injuries.refetch();
                  }}
                  empty={
                    <EmptyState
                      cause="Nothing has been coded for this visit."
                      nextAction="ISS is the sum of squares of the worst injury in each of the three worst regions, so add the injuries below before computing."
                    />
                  }
                >
                  <ul className="flex flex-col gap-1" data-testid="coded-injuries">
                    {coded.map((injury) => (
                      <li
                        key={injury.id}
                        className="flex items-center justify-between gap-3 rounded-md border border-default px-3 py-2 text-sm"
                      >
                        <span className="min-w-0">
                          <Badge tone={injury.aisSeverity >= 4 ? 'danger' : 'neutral'}>
                            {`AIS ${String(injury.aisSeverity)}`}
                          </Badge>{' '}
                          <span className="capitalize">{injury.region.replace('_', ' / ')}</span> —{' '}
                          {injury.description}
                        </span>
                        {canCode ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={uncode.isPending}
                            onClick={() => {
                              uncode.mutate(injury.id);
                            }}
                          >
                            Remove
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </AsyncPanel>

                {canCode ? (
                  <form
                    className="flex flex-wrap items-end gap-3"
                    data-testid="code-injury"
                    onSubmit={(event) => {
                      event.preventDefault();
                      code.mutate();
                    }}
                  >
                    <div className="flex min-w-40 flex-col gap-1">
                      <Label htmlFor="region">Region</Label>
                      <select
                        id="region"
                        className={selectClass}
                        value={region}
                        onChange={(event) => {
                          setRegion(event.target.value);
                        }}
                      >
                        {AIS_REGIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex min-w-36 flex-col gap-1">
                      <Label htmlFor="severity">AIS severity</Label>
                      <select
                        id="severity"
                        className={selectClass}
                        value={severity}
                        onChange={(event) => {
                          setSeverity(event.target.value);
                        }}
                      >
                        {AIS_SEVERITY.map((option) => (
                          <option key={option.score} value={String(option.score)}>
                            {`${String(option.score)} · ${option.label}`}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex min-w-72 flex-1 flex-col gap-1">
                      <Label htmlFor="injury-description">Description</Label>
                      <Input
                        id="injury-description"
                        value={description}
                        autoComplete="off"
                        placeholder="Grade III splenic laceration"
                        onChange={(event) => {
                          setDescription(event.target.value);
                        }}
                      />
                    </div>
                    <Button type="submit" disabled={description.trim().length < 2 || code.isPending}>
                      Add
                    </Button>
                  </form>
                ) : null}
              </div>

              {/* ── Compute ─────────────────────────────────────────────── */}
              {canCompute ? (
                <div className="flex flex-wrap items-end gap-3 rounded-lg border border-strong bg-layer-1 p-4">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="mechanism">Mechanism</Label>
                    <select
                      id="mechanism"
                      className={selectClass}
                      value={mechanism}
                      onChange={(event) => {
                        setMechanism(event.target.value === 'penetrating' ? 'penetrating' : 'blunt');
                      }}
                    >
                      <option value="blunt">Blunt</option>
                      <option value="penetrating">Penetrating</option>
                    </select>
                  </div>
                  <Button
                    type="button"
                    data-testid="compute-scores"
                    disabled={compute.isPending}
                    onClick={() => {
                      compute.mutate();
                    }}
                  >
                    {compute.isPending ? 'Computing…' : 'Compute scores'}
                  </Button>
                  <p className="max-w-prose text-2xs text-fg-subtle">
                    Uses the arrival GCS, systolic pressure and respiratory rate from the first triage record
                    — not the current ones. TRISS on current numbers two hours into a resuscitation says the
                    patient was always going to survive.
                  </p>
                </div>
              ) : null}
              {compute.error === null ? null : <ProblemCard error={compute.error} />}
              {lock.error === null ? null : <ProblemCard error={lock.error} />}
              {amend.error === null ? null : <ProblemCard error={amend.error} />}

              {/* ── The versions ────────────────────────────────────────── */}
              <div className="flex flex-col gap-2">
                <h2 className="text-sm font-medium">Scores</h2>
                <AsyncPanel
                  loading={scores.isPending}
                  error={scores.error}
                  isEmpty={versions.length === 0}
                  skeletonLabel="Loading scores"
                  skeletonRows={2}
                  onRetry={() => {
                    void scores.refetch();
                  }}
                  empty={
                    <EmptyState
                      cause="This visit has not been scored."
                      nextAction="Code the injuries above, then compute. Nothing is typed — the scores follow from the coding."
                    />
                  }
                >
                  <ul className="flex flex-col gap-3" data-testid="trauma-scores">
                    {versions.map((score) => (
                      <li key={score.id} className="rounded-lg border border-strong bg-layer-1 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <p className="flex flex-wrap items-center gap-2 text-sm">
                            <Badge tone="neutral">{`v${String(score.versionNo)}`}</Badge>
                            <Badge tone={STATUS_TONE[score.status] ?? 'neutral'}>{score.status}</Badge>
                            {score.issBand === null ? null : (
                              <Badge tone={BAND_TONE[score.issBand] ?? 'neutral'}>{score.issBand}</Badge>
                            )}
                            <span className="text-2xs text-fg-subtle">
                              {new Date(score.computedAt).toLocaleString()}
                            </span>
                          </p>
                          <span className="flex gap-2">
                            {canLock && score.status === 'provisional' ? (
                              <Button
                                type="button"
                                size="sm"
                                disabled={lock.isPending}
                                onClick={() => {
                                  lock.mutate(score.id);
                                }}
                              >
                                Sign off
                              </Button>
                            ) : null}
                            {canAmend && score.status === 'locked' ? (
                              <Button
                                type="button"
                                size="sm"
                                onClick={() => {
                                  setAmending(amending === score.id ? null : score.id);
                                }}
                              >
                                Amend
                              </Button>
                            ) : null}
                          </span>
                        </div>

                        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-5">
                          {(
                            [
                              ['ISS', score.iss],
                              ['NISS', score.niss],
                              ['RTS', score.rts],
                              ['Shock index', score.shockIndex],
                              ['MGAP', score.mgap],
                              ['GAP', score.gap],
                              ['TRISS', score.trissDisplay],
                              ['Arrival GCS', score.arrivalGcs],
                              ['Arrival SBP', score.arrivalSbp],
                              ['Arrival RR', score.arrivalRr],
                            ] as const
                          ).map(([label, value]) => (
                            <div key={label} className="flex justify-between gap-2">
                              <dt className="text-fg-subtle">{label}</dt>
                              <dd className="font-mono">{value ?? '—'}</dd>
                            </div>
                          ))}
                        </dl>

                        {score.trissCoefficientSet === null ? null : (
                          <p className="mt-2 text-2xs text-fg-subtle">
                            TRISS on {score.trissCoefficientSet}. MTOS was derived from North American
                            registries in the 1980s and is the wrong curve for most Indian trauma populations
                            — it is what the literature compares against until this hospital has a validated
                            local set.
                          </p>
                        )}
                        {score.amendReason === null ? null : (
                          <p className="mt-2 text-sm">Amendment: {score.amendReason}</p>
                        )}

                        {amending === score.id ? (
                          <form
                            className="mt-3 flex flex-wrap items-end gap-3 rounded-md border border-dashed border-strong p-3"
                            onSubmit={(event) => {
                              event.preventDefault();
                              amend.mutate(score.id);
                            }}
                          >
                            <div className="flex min-w-80 flex-1 flex-col gap-1">
                              <Label htmlFor={`amend-${score.id}`}>What was wrong with this version?</Label>
                              <Input
                                id={`amend-${score.id}`}
                                value={amendReason}
                                autoComplete="off"
                                placeholder="Splenic laceration recoded AIS 4 after the formal CT report"
                                onChange={(event) => {
                                  setAmendReason(event.target.value);
                                }}
                              />
                              <p className="text-2xs text-fg-subtle">
                                {`This version stays and is marked superseded. The correction becomes v${String(
                                  score.versionNo + 1,
                                )}.`}
                              </p>
                            </div>
                            <Button type="submit" disabled={amendReason.trim().length < 8 || amend.isPending}>
                              Record the amendment
                            </Button>
                          </form>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </AsyncPanel>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
