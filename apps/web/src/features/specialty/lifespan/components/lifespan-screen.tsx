'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { getFluids, getGrowth, getNicu, getReviews } from '../api/client';
import { lifespanKeys } from '../api/keys';
import type { GrowthRow, MedicationReviewRow } from '../api/types';

/**
 * OP-033, IP-015 and OP-034 — the two ends of life.
 *
 * One screen because it is one problem: a body that is not a standard adult.
 *
 * ── Every weight is shown in grams ──────────────────────────────────────────
 *
 * Including on a fifteen-year-old, where it looks odd. The consistency is the
 * safety: there is nowhere in this module a weight in kilograms can be entered
 * or read, and a newborn recorded as "3" is refused rather than dosed as three
 * kilograms.
 *
 * ── And the burden is shown with its contributors ───────────────────────────
 *
 * "8" is a number somebody argues with. "8 — amitriptyline 3, oxybutynin 3,
 * furosemide 1, metoprolol 1" is a number somebody acts on.
 */
export function LifespanScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = lifespanKeys(hospitalId);
  const [openNicu, setOpenNicu] = useState<string | null>(null);

  const faltering = useQuery({
    queryKey: keys.growth('faltering'),
    queryFn: ({ signal }) => getGrowth({ falteringOnly: true }, { signal }),
    refetchInterval: 300_000,
  });

  const nicu = useQuery({
    queryKey: keys.nicu('current'),
    queryFn: ({ signal }) => getNicu({ currentOnly: true }, { signal }),
    refetchInterval: 120_000,
  });

  const burden = useQuery({
    queryKey: keys.reviews('high'),
    queryFn: ({ signal }) => getReviews({ highBurdenOnly: true }, { signal }),
    refetchInterval: 300_000,
  });

  const fluids = useQuery({
    queryKey: keys.fluids(openNicu ?? 'none'),
    queryFn: ({ signal }) => getFluids(openNicu ?? '', { signal }),
    enabled: openNicu !== null,
  });

  const small = faltering.data ?? [];
  const babies = nicu.data ?? [];
  const reviews = burden.data ?? [];

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Paediatrics, the neonatal unit and geriatrics"
        description="One problem at both ends of life: a body that is not a standard adult, and doses that do not scale to it. Every weight here is in grams, on purpose."
      />

      {small.length > 0 ? (
        <section
          aria-label="Growth faltering"
          className="rounded-lg border border-warning-border bg-warning-surface p-4"
        >
          <h2 className="text-sm font-semibold text-warning-on-surface">
            {small.length} {small.length === 1 ? 'child is' : 'children are'} below the WHO underweight
            threshold
          </h2>
          <p className="mt-1 text-xs text-warning-on-surface">
            Growth faltering is a nutrition referral and sometimes a safeguarding one, and neither happens
            from a chart nobody re-reads.
          </p>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {small.map((row) => (
              <GrowthLine key={row.id} row={row} />
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Neonatal unit" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Neonatal unit</h2>
        <AsyncPanel
          loading={nicu.isPending}
          error={nicu.error}
          isEmpty={babies.length === 0}
          skeletonLabel="Loading the neonatal unit"
          skeletonRows={4}
          onRetry={() => void nicu.refetch()}
          empty={
            <EmptyState
              cause="No babies are in the unit."
              nextAction="Admit one; the gestation and birth-weight bands are computed, and they decide most of what follows."
            />
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <caption className="sr-only">
                Babies in the neonatal unit. Corrected gestation and day of life are computed from the birth.
              </caption>
              <thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
                <tr>
                  <th scope="col" className="py-2">
                    Gestation
                  </th>
                  <th scope="col">Birth weight</th>
                  <th scope="col">Day</th>
                  <th scope="col">Corrected</th>
                  <th scope="col">Today</th>
                </tr>
              </thead>
              <tbody>
                {babies.map((baby) => (
                  <tr
                    key={baby.id}
                    className="cursor-pointer border-t border-default hover:bg-layer-3"
                    onClick={() => setOpenNicu(baby.id)}
                  >
                    <td className="py-2">
                      <BandChip band={baby.gestationBand} weeks={baby.gaWeeksAtBirth} />
                    </td>
                    <td>
                      <WeightChip band={baby.birthWeightBand} grams={baby.birthWeightG} />
                    </td>
                    <td>{baby.dayOfLife}</td>
                    <td>{baby.correctedGaWeeks} w</td>
                    <td className="font-mono text-xs">
                      {baby.latestWeightG === null ? '—' : `${String(baby.latestWeightG)} g`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AsyncPanel>
      </section>

      {openNicu === null ? null : (
        <section aria-label="Fluid balance" className="rounded-lg border border-default bg-layer-1 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">Fluids</h2>
            <button
              type="button"
              onClick={() => setOpenNicu(null)}
              className="text-sm text-fg-link hover:underline"
            >
              Close
            </button>
          </div>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {(fluids.data ?? []).map((day) => (
              <li key={day.id} className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-xs">day {day.dayOfLife}</span>
                <span>{day.weightG} g</span>
                {/* Shown beside the prescription rather than enforced. */}
                <Badge tone={day.mlPerKgPerDay === day.expectedMlPerKg ? 'neutral' : 'accent'}>
                  {day.mlPerKgPerDay} mL/kg (standard {day.expectedMlPerKg})
                </Badge>
                <span className="text-fg-muted">
                  {day.totalMlPerDay} mL total, {day.ivMlPerDay} mL intravenous at {day.mlPerHour} mL/h
                </span>
              </li>
            ))}
            {(fluids.data ?? []).length === 0 ? (
              <li className="text-xs text-fg-muted">No fluids prescribed yet.</li>
            ) : null}
          </ul>
        </section>
      )}

      <section aria-label="Medication burden" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Anticholinergic burden</h2>
        <AsyncPanel
          loading={burden.isPending}
          error={burden.error}
          isEmpty={reviews.length === 0}
          skeletonLabel="Loading medication reviews"
          skeletonRows={4}
          onRetry={() => void burden.refetch()}
          empty={
            <EmptyState
              cause="Nobody reviewed is carrying a high burden."
              nextAction="Reviews appear here at a score of three or more, which is where the drugs start causing the falls they are being taken alongside."
            />
          }
        >
          <ul className="flex flex-col gap-2 text-sm">
            {reviews.map((review) => (
              <ReviewLine key={review.id} review={review} />
            ))}
          </ul>
        </AsyncPanel>
      </section>
    </section>
  );
}

/**
 * A value out of a JSON column, narrowed before it is printed.
 *
 * The lint rule is right: an object stringified into a page reads
 * "[object Object]" to a nurse, which is worse than an empty cell.
 */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function GrowthLine({ row }: { readonly row: GrowthRow }): React.JSX.Element {
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border border-warning-border bg-layer-1 p-3">
      <Badge tone={row.nutritionBand === 'severe_underweight' ? 'danger' : 'warning'}>
        {row.nutritionBand?.replace(/_/gu, ' ')}
      </Badge>
      <span className="font-mono text-xs">{row.weightG} g</span>
      <span className="text-fg-muted">
        {Math.floor(row.ageDays / 30)} months · z {row.weightForAgeZ} · {row.weightCentile}th centile
      </span>
      {row.gainGPerDay === null ? null : (
        <span className="text-xs text-fg-muted">{row.gainGPerDay} g/day since the last</span>
      )}
    </li>
  );
}

function BandChip({
  band,
  weeks,
}: {
  readonly band: string | null;
  readonly weeks: number;
}): React.JSX.Element {
  const tone = band === 'extremely_preterm' ? 'danger' : band === 'very_preterm' ? 'warning' : 'neutral';
  return (
    <Badge tone={tone}>
      {weeks} w · {band?.replace(/_/gu, ' ') ?? '—'}
    </Badge>
  );
}

function WeightChip({
  band,
  grams,
}: {
  readonly band: string | null;
  readonly grams: number;
}): React.JSX.Element {
  const tone = band === 'elbw' ? 'danger' : band === 'vlbw' ? 'warning' : 'neutral';
  return (
    <Badge tone={tone}>
      {grams} g · {band?.toUpperCase() ?? '—'}
    </Badge>
  );
}

/**
 * The burden, with the drugs that made it.
 *
 * "8" is a number somebody argues with. "8 — amitriptyline 3, oxybutynin 3" is
 * a number somebody acts on.
 */
function ReviewLine({ review }: { readonly review: MedicationReviewRow }): React.JSX.Element {
  const contributors = review.acbDrugs.map((d) => `${text(d.drugName)} ${text(d.score)}`).join(', ');
  return (
    <li className="rounded-md border border-warning-border bg-layer-1 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={(review.acbScore ?? 0) >= 6 ? 'danger' : 'warning'}>burden {review.acbScore}</Badge>
        {review.polypharmacy ? <Badge tone="warning">{review.drugCount} drugs</Badge> : null}
        {(review.beersCount ?? 0) > 0 ? (
          <Badge tone="warning">{review.beersCount} on the Beers list</Badge>
        ) : null}
        <span className="text-xs text-fg-muted">age {review.ageYears}</span>
      </div>
      {contributors === '' ? null : <p className="mt-1 text-xs text-fg-muted">from {contributors}</p>}
      {review.beersFlags.length === 0 ? null : (
        <ul className="mt-1 flex flex-col gap-1 text-xs text-fg-muted">
          {review.beersFlags.slice(0, 3).map((flag) => (
            <li key={text(flag.drugKey)}>
              {text(flag.drugName)} — {text(flag.rationale)}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
