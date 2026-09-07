'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { getEpisodes, getOpioids, getThresholds, secondReview } from '../api/client';
import { painKeys } from '../api/keys';
import type { OpioidRow, PainEpisodeRow, PainThresholds } from '../api/types';

/**
 * OP-016 — the pain clinic's governance board.
 *
 * ── The screen is the year, not the consultation ───────────────────────────
 *
 * Everything a prescriber needs inside a consultation is on the patient's
 * chart. What no consultation can see is the shape of the *clinic*: which
 * patients are above the review threshold across all their prescriptions, whose
 * treatment agreement lapses next month, who is close to the annual steroid
 * ceiling. Those three are the whole board, because each of them is a fact
 * about twelve months that nobody assembles by hand.
 *
 * ── The thresholds come from the server ────────────────────────────────────
 *
 * "Above 90 mg needs a second signature" is read from `GET /pain/thresholds`,
 * which returns what the trigger uses. A constant compiled beside it is how a
 * screen comes to promise something the database will not do.
 *
 * ── Nothing here computes a morphine equivalent ────────────────────────────
 *
 * `mme`, `aboveReviewThreshold` and `currentDailyMme` all arrive computed. A
 * second implementation in the client would diverge from the trigger the first
 * time a guideline was revised, in the direction nobody checks.
 */
export function PainScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = painKeys(hospitalId);
  const qc = useQueryClient();

  const canReview = granted.has('pain.opioid.second_review');
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [justification, setJustification] = useState('');

  const thresholds = useQuery({
    queryKey: keys.thresholds(),
    queryFn: ({ signal }) => getThresholds({ signal }),
    staleTime: 15 * 60_000,
  });

  const onOpioids = useQuery({
    queryKey: keys.episodes('opioid'),
    queryFn: ({ signal }) => getEpisodes({ openOnly: true, opioidOnly: true }, { signal }),
    refetchInterval: 300_000,
  });

  const awaitingReview = useQuery({
    queryKey: keys.opioids('high-dose'),
    queryFn: ({ signal }) => getOpioids({ highDoseOnly: true }, { signal }),
    refetchInterval: 300_000,
  });

  const review = useMutation({
    mutationFn: (input: { id: string; justification: string }) => secondReview(input.id, input.justification),
    onSuccess: () => {
      setReviewing(null);
      setJustification('');
      void qc.invalidateQueries({ queryKey: keys.opioidsRoot() });
      void qc.invalidateQueries({ queryKey: keys.episodesRoot() });
    },
  });

  const limits = thresholds.data;
  const episodes = onOpioids.data ?? [];
  const unreviewed = (awaitingReview.data ?? []).filter(
    (rx) => rx.aboveReviewThreshold && rx.secondReviewedAt === null,
  );
  const agreementsDue = episodes.filter(
    (e) => e.agreementMissing || (e.agreementDaysRemaining !== null && e.agreementDaysRemaining <= 30),
  );
  const nearCeiling = episodes.filter((e) => e.steroidMgRemaining <= 100);

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Pain management"
        description="The three facts about a year that no single consultation can see: who is above the review threshold, whose agreement lapses next, and who is close to the annual steroid ceiling."
      />

      {limits === undefined ? null : (
        <p className="text-xs text-fg-muted">
          {/* Read from the server, so this sentence and the refusal agree. */}
          Take-home naloxone above {limits.naloxoneMme} mg morphine equivalent a day; a second prescriber
          above {limits.secondReviewMme} mg; {limits.annualSteroidCeilingMg} mg triamcinolone-equivalent a
          year.
        </p>
      )}

      {unreviewed.length > 0 ? (
        <section
          aria-label="Prescriptions awaiting a countersignature"
          className="rounded-lg border border-danger bg-danger-subtle p-4"
        >
          <h2 className="text-sm font-semibold text-fg-danger">
            {unreviewed.length} {unreviewed.length === 1 ? 'prescription is' : 'prescriptions are'} above the
            review threshold and not countersigned
          </h2>
          <p className="mt-1 text-xs text-fg-muted">
            A second prescriber has to look at the dose and say why it is the right one. The prescription is
            already refused without it — this is the list of what is waiting.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {unreviewed.map((rx) => (
              <li key={rx.id} className="rounded-md border border-danger bg-layer-1 p-3">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <MmeChip rx={rx} limits={limits} />
                  <span className="font-medium">{rx.drugName}</span>
                  <span className="text-fg-muted">
                    {rx.dailyDose} {rx.doseUnit === 'mg' ? 'mg' : 'mcg/h'} a day · {rx.daysSupply} days
                  </span>
                  {rx.naloxonePrescribed ? (
                    <Badge tone="neutral" size="sm">
                      naloxone supplied
                    </Badge>
                  ) : null}
                </div>

                {canReview ? (
                  reviewing === rx.id ? (
                    <form
                      className="mt-3 flex flex-wrap items-end gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        review.mutate({ id: rx.id, justification });
                      }}
                    >
                      <label className="flex flex-col gap-1 text-xs">
                        <span className="font-medium">Why this dose is right for this patient</span>
                        <input
                          className="w-96 rounded border border-control bg-layer-1 px-2 py-1 text-sm"
                          value={justification}
                          onChange={(event) => setJustification(event.target.value)}
                          placeholder="Titrated over six weeks with documented function gain."
                          required
                          minLength={12}
                        />
                      </label>
                      {/* Who reviewed it is the session's. There is no field. */}
                      <Button type="submit" size="sm" disabled={review.isPending}>
                        Countersign
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setReviewing(null);
                          setJustification('');
                        }}
                      >
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <Button className="mt-2" size="sm" variant="danger" onClick={() => setReviewing(rx.id)}>
                      Review this dose
                    </Button>
                  )
                ) : (
                  <p className="mt-2 text-xs text-fg-muted">
                    Countersigning is held by a second prescriber — never the one who wrote it.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {agreementsDue.length > 0 ? (
        <section
          aria-label="Treatment agreements needing attention"
          className="rounded-lg border border-warning-border bg-warning-surface p-4"
        >
          <h2 className="text-sm font-semibold text-warning-on-surface">
            {agreementsDue.length} treatment{' '}
            {agreementsDue.length === 1 ? 'agreement needs' : 'agreements need'} attention
          </h2>
          <p className="mt-1 text-xs text-warning-on-surface">
            The day an agreement lapses, every further opioid on that episode is refused — and the patient
            finds out at the counter.
          </p>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {agreementsDue.map((episode) => (
              <li
                key={episode.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-warning-border bg-layer-1 p-3"
              >
                <span className="capitalize">{episode.type.replace(/_/g, ' ')} pain</span>
                {episode.agreementMissing ? (
                  <Badge tone="danger">no agreement in force</Badge>
                ) : (
                  <Badge tone="warning">{episode.agreementDaysRemaining} days left</Badge>
                )}
                {episode.currentDailyMme === null ? null : (
                  <span className="text-fg-muted">
                    {episode.currentDailyMme} mg morphine equivalent a day
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {nearCeiling.length > 0 && limits !== undefined ? (
        <section
          aria-label="Patients near the annual steroid ceiling"
          className="rounded-lg border border-warning-border bg-warning-surface p-4"
        >
          <h2 className="text-sm font-semibold text-warning-on-surface">
            {nearCeiling.length} {nearCeiling.length === 1 ? 'patient is' : 'patients are'} close to the
            annual steroid ceiling
          </h2>
          <p className="mt-1 text-xs text-warning-on-surface">
            The clinic books weeks ahead, and the injection that crosses the ceiling is refused. The harm from
            cumulative steroid arrives years later attached to no single injection, which is why it is counted
            at all.
          </p>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {nearCeiling.map((episode) => (
              <li
                key={episode.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-warning-border bg-layer-1 p-3"
              >
                <span>
                  {episode.steroidMgThisYear} of {limits.annualSteroidCeilingMg} mg this year
                </span>
                <Badge tone={episode.steroidMgRemaining === 0 ? 'danger' : 'warning'}>
                  {episode.steroidMgRemaining} mg left
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Episodes on opioid therapy" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Episodes on opioid therapy</h2>
        <AsyncPanel
          loading={onOpioids.isPending}
          error={onOpioids.error}
          isEmpty={episodes.length === 0}
          skeletonLabel="Loading pain episodes"
          skeletonRows={6}
          onRetry={() => void onOpioids.refetch()}
          empty={
            <EmptyState
              cause="No episode is on opioid therapy."
              nextAction="Open a pain episode and mark it as opioid therapy to bring it onto this board."
            />
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <caption className="sr-only">
                Episodes on opioid therapy. The daily morphine equivalent is summed by the server across every
                live prescription, which is the number no single consultation shows.
              </caption>
              <thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
                <tr>
                  <th scope="col" className="py-2">
                    Opened
                  </th>
                  <th scope="col">Type</th>
                  <th scope="col">Mechanism</th>
                  <th scope="col" title="Summed across every live prescription">
                    Daily MME
                  </th>
                  <th scope="col">Agreement</th>
                  <th scope="col">Steroid this year</th>
                </tr>
              </thead>
              <tbody>
                {episodes.map((episode) => (
                  <tr key={episode.id} className="border-t border-default">
                    <td className="py-2 font-mono text-xs">
                      {new Date(episode.openedAt).toLocaleDateString()}
                    </td>
                    <td className="capitalize">{episode.type.replace(/_/g, ' ')}</td>
                    <td className="capitalize">{episode.mechanism ?? '—'}</td>
                    <td>
                      <EpisodeMmeChip episode={episode} limits={limits} />
                    </td>
                    <td>
                      {episode.agreementMissing ? (
                        <Badge tone="danger">none</Badge>
                      ) : episode.agreementDaysRemaining === null ? (
                        <span className="text-fg-muted">—</span>
                      ) : (
                        <span className="text-fg-muted">{episode.agreementDaysRemaining} days</span>
                      )}
                    </td>
                    <td>{episode.steroidMgThisYear === 0 ? '—' : `${episode.steroidMgThisYear} mg`}</td>
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

/** One prescription's equivalent, against the thresholds the server reported. */
function MmeChip({
  rx,
  limits,
}: {
  readonly rx: OpioidRow;
  readonly limits: PainThresholds | undefined;
}): React.JSX.Element {
  if (rx.mme === null) return <span className="text-fg-muted">—</span>;
  const review = limits?.secondReviewMme ?? 90;
  return (
    <Badge tone={rx.mme >= review ? 'danger' : rx.aboveNaloxoneThreshold ? 'warning' : 'neutral'}>
      {rx.mme} mg MME
    </Badge>
  );
}

/**
 * The episode's total across every live prescription.
 *
 * The interesting case is the one where no single prescription crosses the line
 * and the sum does — which is exactly what a consultation cannot see, and what
 * this board exists for.
 */
function EpisodeMmeChip({
  episode,
  limits,
}: {
  readonly episode: PainEpisodeRow;
  readonly limits: PainThresholds | undefined;
}): React.JSX.Element {
  if (episode.currentDailyMme === null) return <span className="text-fg-muted">none live</span>;
  const naloxone = limits?.naloxoneMme ?? 50;
  return (
    <Badge
      tone={
        episode.aboveReviewThreshold ? 'danger' : episode.currentDailyMme >= naloxone ? 'warning' : 'neutral'
      }
    >
      {episode.currentDailyMme} mg
    </Badge>
  );
}
