'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { getWound, getWounds } from '../api/client';
import { therapyKeys } from '../api/keys';
import type { WoundAssessmentRow, WoundDetail, WoundRow } from '../api/types';

/**
 * OP-017 — the wound care clinic.
 *
 * ── The stalled wounds are the screen ──────────────────────────────────────
 *
 * A wound clinic's whole job is telling apart the wounds that are healing from
 * the ones that are not, and the second group is small and invisible on a list
 * sorted by date. The four-week rule — about 40 % area reduction — is computed
 * in the database, and the wounds it flags sit at the top in their own panel.
 *
 * ── Nothing here multiplies a length by a width ────────────────────────────
 *
 * Area, reduction and trajectory all arrive computed. The trend table shows the
 * measurements the nurse took and the numbers the database made of them, side
 * by side, so it is visible which is which.
 *
 * ── A photograph says whether it can be measured ───────────────────────────
 *
 * Without a scale marker in the frame a photograph is still worth having — the
 * colour and the tissue are the point — but it cannot be the source of a size,
 * and the badge says so rather than leaving somebody to judge from the image.
 */
export function WoundScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = therapyKeys(hospitalId);

  const [openId, setOpenId] = useState<string | null>(null);

  const stalled = useQuery({
    queryKey: keys.wounds('needs-review'),
    queryFn: ({ signal }) => getWounds({ openOnly: true, needsReview: true }, { signal }),
    refetchInterval: 120_000,
  });

  const open = useQuery({
    queryKey: keys.wounds('open'),
    queryFn: ({ signal }) => getWounds({ openOnly: true }, { signal }),
    refetchInterval: 120_000,
  });

  const detail = useQuery({
    queryKey: keys.wound(openId ?? 'none'),
    queryFn: ({ signal }) => getWound(openId ?? '', { signal }),
    enabled: openId !== null,
  });

  const review = stalled.data ?? [];
  const rows = open.data ?? [];

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Wound care"
        description="Every open wound, what it measured last, and which ones the four-week rule says are not healing on the current plan."
      />

      {review.length > 0 ? (
        <section
          aria-label="Wounds that are not healing"
          className="rounded-lg border border-warning-border bg-warning-surface p-4"
        >
          <h2 className="text-sm font-semibold text-warning-on-surface">
            {review.length} {review.length === 1 ? 'wound is' : 'wounds are'} not healing on the current plan
          </h2>
          <p className="mt-1 text-xs text-warning-on-surface">
            A wound that has not reduced by about 40 % in four weeks will not close on what it is getting.
            These need a review, not another dressing change.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {review.map((wound) => (
              <li key={wound.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(wound.id)}
                  className="flex w-full flex-wrap items-center gap-3 rounded-md border border-warning-border bg-layer-1 p-3 text-left text-sm hover:bg-layer-3"
                >
                  <Badge tone={wound.latestTrajectory === 'deteriorating' ? 'danger' : 'warning'}>
                    {wound.latestTrajectory}
                  </Badge>
                  <span className="font-medium">{wound.locationText}</span>
                  <span className="text-fg-muted">{wound.aetiology.replace(/_/g, ' ')}</span>
                  <span>{wound.latestAreaCm2 ?? '—'} cm²</span>
                  <span className="text-fg-muted">
                    {wound.latestReductionPct === null
                      ? ''
                      : `${wound.latestReductionPct}% reduced in ${String(wound.weeksOpen ?? 0)} weeks`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <AsyncPanel
        loading={open.isPending}
        error={open.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading wounds"
        skeletonRows={6}
        onRetry={() => void open.refetch()}
        empty={
          <EmptyState
            cause="No wound is open."
            nextAction="Open one against a patient to start measuring it."
          />
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
            <caption className="sr-only">
              Open wounds. Area is π/4 × length × width and the reduction is against the first measurement —
              both computed by the server.
            </caption>
            <thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
              <tr>
                <th scope="col" className="py-2">
                  Site
                </th>
                <th scope="col">Aetiology</th>
                <th scope="col">Open</th>
                <th scope="col">Area</th>
                <th scope="col">Reduction</th>
                <th scope="col">Trajectory</th>
                <th scope="col">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((wound) => (
                <tr
                  key={wound.id}
                  className="cursor-pointer border-t border-default hover:bg-layer-3"
                  onClick={() => setOpenId(wound.id)}
                >
                  <td className="py-2">
                    {wound.locationText}
                    {wound.hospitalAcquired ? (
                      <Badge className="ml-2" tone="danger" size="sm">
                        hospital acquired
                      </Badge>
                    ) : null}
                  </td>
                  <td className="capitalize">{wound.aetiology.replace(/_/g, ' ')}</td>
                  <td>{wound.weeksOpen === null ? '—' : `${wound.weeksOpen} wk`}</td>
                  <td>{wound.latestAreaCm2 ?? '—'}</td>
                  <td>{wound.latestReductionPct === null ? '—' : `${wound.latestReductionPct}%`}</td>
                  <td>
                    <TrajectoryChip wound={wound} />
                  </td>
                  <td className="font-mono text-xs">
                    {wound.lastAssessedAt === null
                      ? 'never'
                      : new Date(wound.lastAssessedAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      {openId === null || detail.data === undefined ? null : (
        <WoundTrend detail={detail.data} onClose={() => setOpenId(null)} />
      )}
    </section>
  );
}

function TrajectoryChip({ wound }: { readonly wound: WoundRow }): React.JSX.Element {
  if (wound.latestTrajectory === null) {
    return <span className="text-fg-muted">first measurement</span>;
  }
  return (
    <Badge
      tone={
        wound.latestTrajectory === 'deteriorating'
          ? 'danger'
          : wound.latestTrajectory === 'stalled'
            ? 'warning'
            : 'success'
      }
    >
      {wound.latestTrajectory.replace(/_/g, ' ')}
    </Badge>
  );
}

function WoundTrend({
  detail,
  onClose,
}: {
  readonly detail: WoundDetail;
  readonly onClose: () => void;
}): React.JSX.Element {
  const rows = [...detail.assessments].reverse();

  return (
    <section aria-label="Wound trend" className="rounded-lg border border-default bg-layer-1 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">
          {detail.wound.locationText} · wound {detail.wound.woundNo}
        </h2>
        <button type="button" onClick={onClose} className="text-sm text-fg-link hover:underline">
          Close
        </button>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[44rem] text-sm">
          <caption className="sr-only">
            Measurements over time. Length and width are what was measured; area, reduction and trajectory are
            what the database made of them.
          </caption>
          <thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
            <tr>
              <th scope="col" className="py-2">
                Date
              </th>
              <th scope="col">L × W × D</th>
              <th scope="col" title="Derived">
                Area
              </th>
              <th scope="col" title="Derived">
                Reduction
              </th>
              <th scope="col" title="Derived">
                Trajectory
              </th>
              <th scope="col">Bed</th>
              <th scope="col">Pain</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className="border-t border-default">
                <td className="py-2 font-mono text-xs">{new Date(a.assessedAt).toLocaleDateString()}</td>
                <td className="font-mono text-xs">
                  {a.lengthCm ?? '—'} × {a.widthCm ?? '—'} × {a.depthCm ?? '—'}
                </td>
                <td>{a.areaCm2 ?? '—'}</td>
                <td>{a.areaReductionPct === null ? '—' : `${a.areaReductionPct}%`}</td>
                <td>{a.trajectory ?? '—'}</td>
                <td className="text-xs">{describeBed(a)}</td>
                <td>{a.painNrs ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail.photos.length === 0 ? null : (
        <>
          <h3 className="mt-4 text-sm font-semibold">Photographs</h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {detail.photos.map((photo) => (
              <li key={photo.id} className="flex flex-col gap-1 rounded-md border border-default p-2 text-xs">
                <span className="font-mono">{new Date(photo.takenAt).toLocaleDateString()}</span>
                <span className="text-fg-muted">{photo.stage.replace(/_/g, ' ')}</span>
                {/* Without a ruler in the frame this cannot be the source of a
                    size, and saying so beats leaving somebody to judge. */}
                <Badge tone={photo.measurable ? 'neutral' : 'warning'} size="sm">
                  {photo.measurable ? 'has a scale marker' : 'not measurable'}
                </Badge>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** The wound bed as a short phrase, from the percentages that total 100. */
function describeBed(assessment: WoundAssessmentRow): string {
  const entries = Object.entries(assessment.tissuePct);
  if (entries.length === 0) return '—';
  return entries.map(([tissue, pct]) => `${String(pct)}% ${tissue}`).join(', ');
}
