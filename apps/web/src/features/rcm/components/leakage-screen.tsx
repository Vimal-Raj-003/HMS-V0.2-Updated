'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { formatInstant, formatMoney, humanise } from '@/features/pharmacy/lib/format';
import {
  acceptLeakFinding,
  dismissLeakFinding,
  getLeakDashboard,
  listLeakFindings,
  listLeakScans,
  runLeakScan,
} from '../api/client';
import { rcmKeys } from '../api/keys';
import type { LeakFindingView, LeakScanView } from '../api/types';

type Tab = 'worklist' | 'recovered' | 'scans';

/**
 * What each reconciler is actually looking at, in the words of the person who
 * has to work the row. `orders_vs_charges` means nothing at a desk.
 */
const RECONCILER_LABELS: Readonly<Record<string, string>> = {
  orders_vs_charges: 'Delivered, not charged',
  dispense_vs_charges: 'Dispensed, not billed',
  consignment_vs_charges: 'Implant used, not billed',
  discount_without_approval: 'Discount with no approval',
};

/**
 * RC-006 — revenue leakage audit.
 *
 * ── Nothing on this screen bills anything ───────────────────────────────────
 *
 * `phase-05` §5.7: "Never auto-post — propose to a human." So "Accept" here
 * agrees a gap is real and stops there; raising the charge is a separate act on
 * the bill. One button that agreed and billed at once would be the auto-post the
 * rule forbids, wearing somebody's name — and the day it was wrong, a family
 * would be charged for a test that was cancelled.
 *
 * ── The worklist is sorted by money, not by age ─────────────────────────────
 *
 * A ₹40,000 implant and a ₹350 blood test are not the same problem, and a
 * chronological list buries the first under a week of the second. Whoever opens
 * this has limited attention; the biggest gap should be the first thing they
 * see.
 */
export function LeakageScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = rcmKeys(hospitalId);
  const { publish } = useToast();

  const [tab, setTab] = useState<Tab>('worklist');
  const [openId, setOpenId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const canDecide = granted.has('leak.finding.accept');
  const canDismiss = granted.has('leak.finding.dismiss');
  const canScan = granted.has('leak.scan.run');
  const canSeeDashboard = granted.has('leak.report.read');

  const findings = useQuery({
    queryKey: keys.leakFindings('open'),
    queryFn: ({ signal }) => listLeakFindings({ status: 'open' }, { signal }),
    enabled: tab === 'worklist',
  });
  const dashboard = useQuery({
    queryKey: keys.leakDashboard(),
    queryFn: ({ signal }) => getLeakDashboard('Reviewing what the audit recovered', { signal }),
    enabled: tab === 'recovered' && canSeeDashboard,
  });
  const scans = useQuery({
    queryKey: keys.leakScans(),
    queryFn: ({ signal }) => listLeakScans({ signal }),
    enabled: tab === 'scans',
  });

  const decide = useMutation({
    mutationFn: (input: { readonly id: string; readonly action: 'accept' | 'dismiss' }) =>
      input.action === 'accept'
        ? acceptLeakFinding(input.id, { reason })
        : dismissLeakFinding(input.id, { reason }),
    onSuccess: (_data, input) => {
      void findings.refetch();
      setOpenId(null);
      setReason('');
      publish({
        title: input.action === 'accept' ? 'Accepted — now raise the charge' : 'Dismissed',
        severity: 'success',
      });
    },
  });

  const scan = useMutation({
    mutationFn: () => runLeakScan({ trigger: 'on_demand' }),
    onSuccess: () => {
      void findings.refetch();
      void scans.refetch();
      publish({ title: 'Scan complete', severity: 'success' });
    },
  });

  const rows = findings.data?.items ?? [];
  const scanRows = scans.data?.items ?? [];
  const board = dashboard.data;
  const openGap = rows.reduce((sum, f) => sum + Number(f.gapAmount), 0);

  const tabs: ReadonlyArray<{ readonly key: Tab; readonly label: string }> = [
    { key: 'worklist', label: `Worklist${rows.length > 0 ? ` (${String(rows.length)})` : ''}` },
    { key: 'recovered', label: 'What came back' },
    { key: 'scans', label: 'Scans' },
  ];

  return (
    <section className="flex flex-col gap-4" data-testid="leakage-screen">
      <PageHeader
        eyebrow="RC-006 · revenue leakage"
        title="Revenue leakage"
        description="Things that were delivered and never charged. Every row here is a proposal — nothing on this screen bills anybody, because an audit that posted what it thought it found would eventually charge a family for a test that was cancelled."
      />

      <nav aria-label="Leakage views" className="flex flex-wrap items-center gap-1 border-b border-default">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            data-testid={`leakage-tab-${entry.key}`}
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
        {canScan ? (
          <span className="ms-auto pb-1">
            <Button
              variant="secondary"
              data-testid="run-scan"
              disabled={scan.isPending}
              onClick={() => {
                scan.mutate();
              }}
            >
              {scan.isPending ? 'Scanning…' : 'Run a scan'}
            </Button>
          </span>
        ) : null}
      </nav>

      {tab === 'worklist' ? (
        <AsyncPanel
          loading={findings.isPending}
          error={findings.error}
          isEmpty={rows.length === 0}
          skeletonLabel="Loading the leakage worklist"
          skeletonRows={6}
          onRetry={() => {
            void findings.refetch();
          }}
          empty={
            <EmptyState
              cause="Nothing delivered is currently uncharged."
              nextAction="The reconcilers compare orders, dispenses, implants and discounts against what was billed. An empty list is the right answer."
            />
          }
        >
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              <strong className="font-mono">{formatMoney(openGap.toFixed(2))}</strong> across {rows.length}{' '}
              {rows.length === 1 ? 'gap' : 'gaps'}, largest first.
            </p>

            <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
              <table className="w-full text-sm" data-testid="leak-finding-list">
                <caption className="sr-only">Suspected revenue leakage</caption>
                <thead>
                  <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                    <th scope="col" className="px-3 py-2 text-start">
                      What was missed
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Kind
                    </th>
                    <th scope="col" className="px-3 py-2 text-end">
                      Gap
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      When
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row: LeakFindingView) => (
                    <tr key={row.id} className="border-b border-default last:border-0">
                      <td className="px-3 py-2">
                        {row.description}
                        <p className="mt-1 font-mono text-2xs text-fg-subtle">{row.sourceRefType}</p>
                      </td>
                      <td className="px-3 py-2 text-2xs">
                        <Badge tone={row.severity === 'high' ? 'danger' : 'warning'}>
                          {RECONCILER_LABELS[row.reconciler] ?? humanise(row.reconciler)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-end font-mono text-base">{formatMoney(row.gapAmount)}</td>
                      <td className="px-3 py-2 text-2xs text-fg-muted">
                        {row.occurredAt === null ? '—' : formatInstant(row.occurredAt)}
                      </td>
                      <td className="px-3 py-2">
                        {canDecide || canDismiss ? (
                          <Button
                            variant="ghost"
                            data-testid={`open-finding-${row.id}`}
                            onClick={() => {
                              setOpenId(row.id === openId ? null : row.id);
                              setReason('');
                            }}
                          >
                            {row.id === openId ? 'Close' : 'Decide'}
                          </Button>
                        ) : (
                          <span className="text-2xs text-fg-subtle">
                            needs <code>leak.finding.accept</code>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {decide.error === null ? null : <ProblemCard error={decide.error} />}

            {openId === null ? null : (
              <div
                className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
                data-testid="decide-finding"
              >
                <div className="flex min-w-72 flex-col gap-1">
                  <Label htmlFor="leak-reason">Why?</Label>
                  <Input
                    id="leak-reason"
                    data-testid="leak-reason"
                    value={reason}
                    autoComplete="off"
                    onChange={(event) => {
                      setReason(event.target.value);
                    }}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  {canDecide ? (
                    <Button
                      data-testid="accept-finding"
                      disabled={reason.trim() === '' || decide.isPending}
                      onClick={() => {
                        decide.mutate({ id: openId, action: 'accept' });
                      }}
                    >
                      It is a real gap
                    </Button>
                  ) : null}
                  {canDismiss ? (
                    <Button
                      variant="secondary"
                      data-testid="dismiss-finding"
                      disabled={reason.trim() === '' || decide.isPending}
                      onClick={() => {
                        decide.mutate({ id: openId, action: 'dismiss' });
                      }}
                    >
                      It is not
                    </Button>
                  ) : null}
                </div>
                <p className="text-2xs text-fg-subtle">
                  Accepting does <strong>not</strong> bill anything. It records that somebody agreed the gap
                  is real; the charge is then raised on the bill like any other. Two steps on purpose — one
                  button that agreed and billed at once is exactly the auto-post §5.7 forbids.
                </p>
              </div>
            )}
          </div>
        </AsyncPanel>
      ) : null}

      {tab === 'recovered' && !canSeeDashboard ? (
        <EmptyState
          cause="You cannot read the recovery dashboard."
          nextAction="leak.report.read is held by finance."
        />
      ) : null}

      {tab === 'recovered' && canSeeDashboard ? (
        <AsyncPanel
          loading={dashboard.isPending}
          error={dashboard.error}
          isEmpty={board === undefined}
          skeletonLabel="Loading what came back"
          skeletonRows={4}
          onRetry={() => {
            void dashboard.refetch();
          }}
          empty={<EmptyState cause="Nothing to summarise yet." nextAction="Run a scan to start." />}
        >
          {board === undefined ? null : (
            <div className="flex flex-col gap-4">
              <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  { label: 'Open', value: board.openGap, count: board.openCount, tone: 'warning' },
                  {
                    label: 'Accepted, not yet billed',
                    value: board.acceptedGap,
                    count: board.acceptedCount,
                    tone: 'warning',
                  },
                  {
                    label: 'Recovered',
                    value: board.recoveredAmount,
                    count: board.recoveredCount,
                    tone: 'success',
                  },
                  {
                    label: 'Dismissed',
                    value: board.dismissedGap,
                    count: board.dismissedCount,
                    tone: 'neutral',
                  },
                ].map((card) => (
                  <div key={card.label} className="rounded-lg border border-strong bg-layer-1 p-3">
                    <dt className="text-2xs uppercase tracking-[0.08em] text-fg-subtle">{card.label}</dt>
                    <dd className="mt-1 font-mono text-lg">{formatMoney(card.value)}</dd>
                    <dd className="text-2xs text-fg-muted">
                      {card.count} {card.count === 1 ? 'finding' : 'findings'}
                    </dd>
                  </div>
                ))}
              </dl>

              <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
                <table className="w-full text-sm" data-testid="leak-by-reconciler">
                  <caption className="sr-only">Leakage by reconciliation</caption>
                  <thead>
                    <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                      <th scope="col" className="px-3 py-2 text-start">
                        Reconciliation
                      </th>
                      <th scope="col" className="px-3 py-2 text-end">
                        Open
                      </th>
                      <th scope="col" className="px-3 py-2 text-end">
                        Open gap
                      </th>
                      <th scope="col" className="px-3 py-2 text-end">
                        Recovered
                      </th>
                      <th scope="col" className="px-3 py-2 text-end">
                        Agreed to be real
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.byReconciler.map((r) => (
                      <tr key={r.reconciler} className="border-b border-default last:border-0">
                        <td className="px-3 py-2">
                          {RECONCILER_LABELS[r.reconciler] ?? humanise(r.reconciler)}
                        </td>
                        <td className="px-3 py-2 text-end font-mono text-2xs">{r.openCount}</td>
                        <td className="px-3 py-2 text-end font-mono">{formatMoney(r.openGap)}</td>
                        <td className="px-3 py-2 text-end font-mono">{formatMoney(r.recoveredAmount)}</td>
                        <td className="px-3 py-2 text-end font-mono text-2xs">
                          {r.acceptanceRatePct === 'n/a' ? '—' : `${r.acceptanceRatePct}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-2xs text-fg-subtle">
                The last column is the one to watch. A reconciliation that is dismissed most of the time is
                not finding leakage, it is manufacturing work — and the fix is the query, not the worklist.
              </p>
            </div>
          )}
        </AsyncPanel>
      ) : null}

      {tab === 'scans' ? (
        <AsyncPanel
          loading={scans.isPending}
          error={scans.error}
          isEmpty={scanRows.length === 0}
          skeletonLabel="Loading scans"
          skeletonRows={5}
          onRetry={() => {
            void scans.refetch();
          }}
          empty={<EmptyState cause="No scan has run yet." nextAction="Run one from the button above." />}
        >
          <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
            <table className="w-full text-sm" data-testid="leak-scan-list">
              <caption className="sr-only">Leakage scans</caption>
              <thead>
                <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  <th scope="col" className="px-3 py-2 text-start">
                    When
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    Why it ran
                  </th>
                  <th scope="col" className="px-3 py-2 text-end">
                    Rules
                  </th>
                  <th scope="col" className="px-3 py-2 text-end">
                    New
                  </th>
                  <th scope="col" className="px-3 py-2 text-end">
                    Open after
                  </th>
                  <th scope="col" className="px-3 py-2 text-end">
                    Gap
                  </th>
                </tr>
              </thead>
              <tbody>
                {scanRows.map((row: LeakScanView) => (
                  <tr key={row.id} className="border-b border-default last:border-0">
                    <td className="px-3 py-2 text-2xs text-fg-muted">{formatInstant(row.startedAt)}</td>
                    <td className="px-3 py-2">
                      <Badge tone={row.trigger === 'pre_discharge' ? 'warning' : 'neutral'}>
                        {humanise(row.trigger)}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-end font-mono text-2xs">{row.rulesRun}</td>
                    <td className="px-3 py-2 text-end font-mono text-2xs">{row.findingsNew}</td>
                    <td className="px-3 py-2 text-end font-mono text-2xs">{row.findingsTotal}</td>
                    <td className="px-3 py-2 text-end font-mono">{formatMoney(row.gapTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AsyncPanel>
      ) : null}
    </section>
  );
}
