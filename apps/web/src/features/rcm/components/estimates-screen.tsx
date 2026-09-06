'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { formatInstant, formatMoney, humanise } from '@/features/pharmacy/lib/format';
import { getEstimate, getVarianceSummary, listEstimateVariance, listEstimates } from '../api/client';
import { rcmKeys } from '../api/keys';
import type {
  EstimateDetailView,
  EstimateVarianceSummaryRow,
  EstimateVarianceView,
  EstimateView,
} from '../api/types';

type Tab = 'quotes' | 'variance' | 'learning';

/**
 * How a line's firmness is shown.
 *
 * A total made of firm lines and a total made of indicative ones are different
 * promises even when the number is the same, and the family cannot tell them
 * apart from the total alone. Colouring the difference is what lets the desk
 * say "the surgery is fixed, the ICU days are not" without reading out the
 * whole sheet.
 */
const CONFIDENCE_TONE: Readonly<Record<string, 'success' | 'neutral' | 'warning' | 'danger'>> = {
  firm: 'success',
  capped: 'neutral',
  indicative: 'warning',
  contingent: 'danger',
};

const CONFIDENCE_MEANING: Readonly<Record<string, string>> = {
  firm: 'priced from the published tariff',
  capped: 'cannot exceed this',
  indicative: 'a typical quantity — this is where quotes move',
  contingent: 'only if it happens',
};

/**
 * RC-008 — cost estimator.
 *
 * ── The variance tab exists to be uncomfortable ─────────────────────────────
 *
 * A hospital does not find out its quotes run light by reading its quotes. It
 * finds out by comparing them with the bills they became, and the comparison is
 * only useful if somebody looks at it. So estimate-versus-actual is a tab beside
 * the quotes rather than a monthly export, and the learning view leads with the
 * procedures whose mean variance is worst.
 *
 * ── The family's number is the one shown large ──────────────────────────────
 *
 * A gross of ₹2,40,000 against an insurer paying ₹1,90,000 is not what a family
 * needs to know. `patientShare` is what they will be asked for, so it is the
 * column the eye lands on and the gross is secondary.
 */
export function EstimatesScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = rcmKeys(hospitalId);

  const [tab, setTab] = useState<Tab>('quotes');
  const [openId, setOpenId] = useState<string | null>(null);

  const canSeeVariance = granted.has('est.variance.read');

  const estimates = useQuery({
    queryKey: keys.estimates('all'),
    queryFn: ({ signal }) => listEstimates({}, { signal }),
    enabled: tab === 'quotes',
  });
  const detail = useQuery({
    queryKey: keys.estimate(openId ?? 'none'),
    queryFn: ({ signal }) => getEstimate(openId ?? '', { signal }),
    enabled: openId !== null,
  });
  const variance = useQuery({
    queryKey: keys.estimateVariance(),
    queryFn: ({ signal }) => listEstimateVariance({ signal }),
    enabled: tab === 'variance' && canSeeVariance,
  });
  const learning = useQuery({
    queryKey: keys.estimateVarianceSummary(),
    queryFn: ({ signal }) => getVarianceSummary({ signal }),
    enabled: tab === 'learning' && canSeeVariance,
  });

  const rows = estimates.data?.items ?? [];
  const varianceRows = variance.data?.items ?? [];
  const learningRows = learning.data?.items ?? [];
  const open: EstimateDetailView | undefined = detail.data;

  const tabs: ReadonlyArray<{ readonly key: Tab; readonly label: string }> = [
    { key: 'quotes', label: 'Quotes' },
    { key: 'variance', label: 'Estimate vs actual' },
    { key: 'learning', label: 'What it has taught us' },
  ];

  return (
    <section className="flex flex-col gap-4" data-testid="estimates-screen">
      <PageHeader
        eyebrow="RC-008 · cost estimator"
        title="Cost estimates"
        description="What a family was quoted, when, and what the bill turned out to be. An issued estimate is fixed — it is revised by superseding it, so both numbers survive the conversation at discharge."
      />

      <nav aria-label="Estimator views" className="flex flex-wrap gap-1 border-b border-default">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            data-testid={`estimates-tab-${entry.key}`}
            aria-current={tab === entry.key ? 'page' : undefined}
            onClick={() => {
              setTab(entry.key);
            }}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === entry.key
                ? 'border-accent-border text-fg-default'
                : 'border-transparent text-fg-muted hover:text-fg-default'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {tab === 'quotes' ? (
        <AsyncPanel
          loading={estimates.isPending}
          error={estimates.error}
          isEmpty={rows.length === 0}
          skeletonLabel="Loading estimates"
          skeletonRows={6}
          onRetry={() => {
            void estimates.refetch();
          }}
          empty={
            <EmptyState
              cause="No estimate has been prepared."
              nextAction="An estimate can be built from a standing line set for the procedure, or line by line."
            />
          }
        >
          <div className="flex flex-col gap-3">
            <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
              <table className="w-full text-sm" data-testid="estimate-list">
                <caption className="sr-only">Cost estimates</caption>
                <thead>
                  <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                    <th scope="col" className="px-3 py-2 text-start">
                      Estimate
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Status
                    </th>
                    <th scope="col" className="px-3 py-2 text-end">
                      The family pays
                    </th>
                    <th scope="col" className="px-3 py-2 text-end">
                      Total
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Valid
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row: EstimateView) => (
                    <tr key={row.id} className="border-b border-default last:border-0">
                      <td className="px-3 py-2">
                        <span className="font-mono text-2xs">{row.estimateNo}</span>
                        <p className="mt-1 text-2xs text-fg-muted">{row.title}</p>
                        {row.enquirerName === null ? null : (
                          <p className="text-2xs text-fg-subtle">for {row.enquirerName}</p>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <Badge
                          tone={
                            row.status === 'converted'
                              ? 'success'
                              : row.status === 'declined'
                                ? 'danger'
                                : row.status === 'draft' || row.status === 'superseded'
                                  ? 'neutral'
                                  : 'warning'
                          }
                        >
                          {humanise(row.status)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-end font-mono text-base">
                        {formatMoney(row.patientShare)}
                      </td>
                      <td className="px-3 py-2 text-end font-mono text-2xs text-fg-muted">
                        {formatMoney(row.totalPayable)}
                      </td>
                      <td className="px-3 py-2 text-2xs">
                        {row.validTill === null ? (
                          <span className="text-fg-muted">not issued</span>
                        ) : row.daysLeft !== null && row.daysLeft < 0 ? (
                          <Badge tone="neutral">lapsed</Badge>
                        ) : (
                          <span className="text-fg-muted">
                            {row.validTill}
                            {row.daysLeft === null ? '' : ` · ${String(row.daysLeft)}d`}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          data-testid={`open-estimate-${row.id}`}
                          className="text-sm text-accent-fg underline-offset-2 hover:underline"
                          onClick={() => {
                            setOpenId(row.id === openId ? null : row.id);
                          }}
                        >
                          {row.id === openId ? 'Close' : 'Open'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {open === undefined ? null : (
              <div
                className="flex flex-col gap-4 rounded-lg border border-strong bg-layer-1 p-4"
                data-testid="estimate-detail"
              >
                <div className="flex flex-wrap items-baseline gap-3">
                  <span className="font-mono text-sm">{open.estimateNo}</span>
                  <Badge tone={open.status === 'converted' ? 'success' : 'neutral'}>
                    {humanise(open.status)}
                  </Badge>
                  <span className="text-2xs text-fg-muted">
                    {open.losDays} day stay{open.validTill === null ? '' : ` · valid to ${open.validTill}`}
                  </span>
                  {open.supersedesId === null ? null : <Badge tone="warning">revises an earlier quote</Badge>}
                </div>

                <div>
                  <h3 className="mb-2 text-sm font-medium">What it is made of</h3>
                  <div className="overflow-x-auto rounded-lg border border-default">
                    <table className="w-full text-sm">
                      <caption className="sr-only">Estimate lines</caption>
                      <thead>
                        <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                          <th scope="col" className="px-3 py-2 text-start">
                            Line
                          </th>
                          <th scope="col" className="px-3 py-2 text-end">
                            Qty
                          </th>
                          <th scope="col" className="px-3 py-2 text-end">
                            Rate
                          </th>
                          <th scope="col" className="px-3 py-2 text-end">
                            Amount
                          </th>
                          <th scope="col" className="px-3 py-2 text-start">
                            How firm
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {open.lines.map((l) => (
                          <tr key={l.id} className="border-b border-default last:border-0">
                            <td className="px-3 py-2">{l.description}</td>
                            <td className="px-3 py-2 text-end font-mono text-2xs">{l.quantity}</td>
                            <td className="px-3 py-2 text-end font-mono text-2xs">
                              {formatMoney(l.unitRate)}
                            </td>
                            <td className="px-3 py-2 text-end font-mono">{formatMoney(l.amount)}</td>
                            <td className="px-3 py-2 text-2xs">
                              <Badge tone={CONFIDENCE_TONE[l.confidence] ?? 'neutral'}>
                                {humanise(l.confidence)}
                              </Badge>
                              <span className="ms-2 text-fg-subtle">
                                {CONFIDENCE_MEANING[l.confidence] ?? ''}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {open.softLineCount === 0 ? null : (
                    <p className="mt-2 text-2xs text-fg-subtle">
                      {open.softLineCount} of these {open.softLineCount === 1 ? 'line is' : 'lines are'} not
                      firm. Those are the ones to talk through — a total made of firm lines and a total made
                      of indicative ones are different promises even when the number is the same.
                    </p>
                  )}
                </div>

                {open.scenarios.length <= 1 ? null : (
                  <div>
                    <h3 className="mb-2 text-sm font-medium">If the room class changed</h3>
                    <div className="overflow-x-auto rounded-lg border border-default">
                      <table className="w-full text-sm" data-testid="estimate-scenarios">
                        <caption className="sr-only">Room-class scenarios</caption>
                        <tbody>
                          {open.scenarios.map((s) => (
                            <tr key={s.id} className="border-b border-default last:border-0">
                              <td className="px-3 py-2">
                                {s.label}
                                {s.isChosen ? (
                                  <Badge tone="neutral" className="ms-2">
                                    as quoted
                                  </Badge>
                                ) : null}
                              </td>
                              <td className="px-3 py-2 text-end font-mono">{formatMoney(s.totalPayable)}</td>
                              <td className="px-3 py-2 text-end font-mono text-2xs text-fg-muted">
                                {s.deltaVsChosen === '0.00' ? '—' : formatMoney(s.deltaVsChosen)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {open.variance === null ? null : (
                  <div className="rounded-lg border border-strong bg-layer-2 p-3">
                    <h3 className="mb-1 text-sm font-medium">Against the bill it became</h3>
                    <p className="font-mono text-sm">
                      quoted {formatMoney(open.variance.estimatedTotal)} · billed{' '}
                      {formatMoney(open.variance.actualTotal)} ·{' '}
                      <span
                        className={
                          Number(open.variance.variancePct) > 10 ? 'text-danger-fg' : 'text-fg-default'
                        }
                      >
                        {open.variance.variancePct}%
                      </span>
                    </p>
                    {open.variance.explanation === null ? null : (
                      <p className="mt-1 text-2xs text-fg-muted">{open.variance.explanation}</p>
                    )}
                  </div>
                )}

                <div>
                  <h3 className="mb-1 text-sm font-medium">What the family was told, and when</h3>
                  <ul className="flex flex-col gap-1 text-2xs">
                    {open.events.map((e) => (
                      <li key={e.id} className="font-mono text-fg-muted">
                        {formatInstant(e.at)} — {humanise(e.kind)}
                        {e.channel === null ? '' : ` · ${e.channel}`}
                        {e.note === null ? '' : ` · ${e.note}`}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-2xs text-fg-subtle">
                    Append-only in the database. &ldquo;Nobody explained the cost to us&rdquo; is answered by
                    this list or by nothing.
                  </p>
                </div>
              </div>
            )}
          </div>
        </AsyncPanel>
      ) : null}

      {(tab === 'variance' || tab === 'learning') && !canSeeVariance ? (
        <EmptyState
          cause="You cannot read estimate-versus-actual."
          nextAction="est.variance.read is held by finance and quality — measuring the estimator is deliberately not the job of the desk writing the quotes."
        />
      ) : null}

      {tab === 'variance' && canSeeVariance ? (
        <AsyncPanel
          loading={variance.isPending}
          error={variance.error}
          isEmpty={varianceRows.length === 0}
          skeletonLabel="Loading estimate versus actual"
          skeletonRows={6}
          onRetry={() => {
            void variance.refetch();
          }}
          empty={
            <EmptyState
              cause="No estimate has been reconciled against a bill yet."
              nextAction="An estimate that became an admission is scored once its bill is known."
            />
          }
        >
          <div className="flex flex-col gap-3">
            <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
              <table className="w-full text-sm" data-testid="variance-list">
                <caption className="sr-only">Estimate versus actual</caption>
                <thead>
                  <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                    <th scope="col" className="px-3 py-2 text-start">
                      Estimate
                    </th>
                    <th scope="col" className="px-3 py-2 text-end">
                      Quoted
                    </th>
                    <th scope="col" className="px-3 py-2 text-end">
                      Billed
                    </th>
                    <th scope="col" className="px-3 py-2 text-end">
                      Out by
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Stay
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Why
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {varianceRows.map((row: EstimateVarianceView) => {
                    const pct = Number(row.variancePct);
                    return (
                      <tr key={row.id} className="border-b border-default last:border-0">
                        <td className="px-3 py-2">
                          <span className="font-mono text-2xs">{row.estimateNo ?? '—'}</span>
                          {row.procedureCode === null ? null : (
                            <Badge tone="neutral" className="ms-2">
                              {row.procedureCode}
                            </Badge>
                          )}
                        </td>
                        <td className="px-3 py-2 text-end font-mono">{formatMoney(row.estimatedTotal)}</td>
                        <td className="px-3 py-2 text-end font-mono">{formatMoney(row.actualTotal)}</td>
                        <td className="px-3 py-2 text-end">
                          <Badge tone={pct > 10 ? 'danger' : pct > 0 ? 'warning' : 'success'}>
                            {pct > 0 ? '+' : ''}
                            {row.variancePct}%
                          </Badge>
                        </td>
                        <td className="px-3 py-2 font-mono text-2xs text-fg-muted">
                          {row.estimatedLos} → {row.actualLos ?? '?'}
                        </td>
                        <td className="px-3 py-2 text-2xs text-fg-muted">{row.explanation ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-2xs text-fg-subtle">
              A bill more than 10% above its estimate raises an alert rather than waiting for a monthly
              report. On a ₹2,40,000 quote that is ₹24,000 — for many families a month&rsquo;s income, and the
              point of noticing is to tell them before discharge rather than at it.
            </p>
          </div>
        </AsyncPanel>
      ) : null}

      {tab === 'learning' && canSeeVariance ? (
        <AsyncPanel
          loading={learning.isPending}
          error={learning.error}
          isEmpty={learningRows.length === 0}
          skeletonLabel="Loading what the samples show"
          skeletonRows={4}
          onRetry={() => {
            void learning.refetch();
          }}
          empty={
            <EmptyState
              cause="Not enough reconciled estimates to say anything yet."
              nextAction="Each estimate scored against its bill adds a sample."
            />
          }
        >
          <div className="flex flex-col gap-3">
            <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
              <table className="w-full text-sm" data-testid="variance-summary">
                <caption className="sr-only">Variance by procedure</caption>
                <thead>
                  <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                    <th scope="col" className="px-3 py-2 text-start">
                      Procedure
                    </th>
                    <th scope="col" className="px-3 py-2 text-end">
                      Samples
                    </th>
                    <th scope="col" className="px-3 py-2 text-end">
                      Mean
                    </th>
                    <th scope="col" className="px-3 py-2 text-end">
                      Median
                    </th>
                    <th scope="col" className="px-3 py-2 text-end">
                      p90
                    </th>
                    <th scope="col" className="px-3 py-2 text-end">
                      Overran
                    </th>
                    <th scope="col" className="px-3 py-2 text-end">
                      Worst
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {learningRows.map((row: EstimateVarianceSummaryRow) => (
                    <tr key={row.procedureCode} className="border-b border-default last:border-0">
                      <td className="px-3 py-2 font-mono text-2xs">{row.procedureCode}</td>
                      <td className="px-3 py-2 text-end font-mono text-2xs">{row.sampleCount}</td>
                      <td className="px-3 py-2 text-end font-mono">
                        <span className={Number(row.meanVariancePct) > 10 ? 'text-danger-fg' : ''}>
                          {row.meanVariancePct}%
                        </span>
                      </td>
                      <td className="px-3 py-2 text-end font-mono text-2xs">{row.medianVariancePct}%</td>
                      <td className="px-3 py-2 text-end font-mono text-2xs">{row.p90VariancePct}%</td>
                      <td className="px-3 py-2 text-end font-mono text-2xs">{row.overrunRatePct}%</td>
                      <td className="px-3 py-2 text-end font-mono text-2xs">{row.worstVariancePct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-2xs text-fg-subtle">
              Sorted worst first. A procedure whose mean runs positive is one whose standing line set is
              wrong, not a run of unlucky admissions — the fix is the template, not the conversation.
            </p>
          </div>
        </AsyncPanel>
      ) : null}
    </section>
  );
}
