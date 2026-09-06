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
  appealSchemeShortfall,
  approveSchemeWriteOff,
  listCashAttempts,
  listSchemeCases,
  listSchemeClaims,
  listSchemeShortfalls,
  listSchemes,
} from '../api/client';
import { rcmKeys } from '../api/keys';
import type {
  SchemeCaseView,
  SchemeCashAttemptView,
  SchemeClaimView,
  SchemeShortfallView,
  SchemeView,
} from '../api/types';

type Tab = 'claims' | 'cases' | 'shortfalls' | 'refusals' | 'schemes';

/**
 * `humanise` title-cases a snake_case key, which turns `ip_deposit` into
 * "Ip deposit". These are the counters a cashier knows by name, so they are
 * named rather than derived.
 */
const COLLECTION_POINTS: Readonly<Record<string, string>> = {
  cash_counter: 'Cash counter',
  pharmacy: 'Pharmacy',
  advance: 'Advance',
  ip_deposit: 'IP deposit',
  api: 'API',
  other: 'Other',
};

/**
 * RC-007 — government schemes.
 *
 * ── Claims lead, because claims are what runs out of time ───────────────────
 *
 * A scheme claim has a window: thirty days from discharge for PMJAY, forty-five
 * for CGHS. Miss it and the authority pays nothing and the entire episode
 * becomes the hospital's own cost. So the first column after the claim number is
 * the days left in that window, and a claim past it is shown as overdue rather
 * than as a slightly older row.
 *
 * ── The refusal log is a tab, not a hidden report ───────────────────────────
 *
 * "We do not take cash from scheme patients" is a policy. "We were asked eleven
 * times and refused eleven times, here they are" is a control, and it is what an
 * NHA audit asks to see. Giving it a tab next to the claims makes it something
 * the desk looks at rather than something a developer queries.
 *
 * A run of refusals at one counter is also a training signal: the block is
 * working, but somebody keeps trying, and the family in front of them is being
 * asked for money they do not owe.
 */
export function SchemesScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = rcmKeys(hospitalId);
  const { publish } = useToast();

  const [tab, setTab] = useState<Tab>('claims');
  const [openShortfall, setOpenShortfall] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const canAppeal = granted.has('scheme.shortfall.appeal');
  const canWriteOff = granted.has('scheme.shortfall.writeoff.approve');
  const canSeeRefusals = granted.has('scheme.cash.attempt.read');

  const claims = useQuery({
    queryKey: keys.schemeClaims('all'),
    queryFn: ({ signal }) => listSchemeClaims({}, { signal }),
    enabled: tab === 'claims',
  });
  const cases = useQuery({
    queryKey: keys.schemeCases('all'),
    queryFn: ({ signal }) => listSchemeCases({}, { signal }),
    enabled: tab === 'cases',
  });
  const shortfalls = useQuery({
    queryKey: keys.schemeShortfalls('all'),
    queryFn: ({ signal }) => listSchemeShortfalls({}, { signal }),
    enabled: tab === 'shortfalls',
  });
  const refusals = useQuery({
    queryKey: keys.cashAttempts(),
    queryFn: ({ signal }) => listCashAttempts({ signal }),
    enabled: tab === 'refusals' && canSeeRefusals,
  });
  const schemes = useQuery({
    queryKey: keys.schemes(),
    queryFn: ({ signal }) => listSchemes({ signal }),
    enabled: tab === 'schemes',
  });

  const appeal = useMutation({
    mutationFn: (input: { readonly id: string; readonly action: 'appeal' | 'request_writeoff' }) =>
      appealSchemeShortfall(input.id, { action: input.action, reason }),
    onSuccess: () => {
      void shortfalls.refetch();
      setOpenShortfall(null);
      setReason('');
      publish({ title: 'Shortfall updated', severity: 'success' });
    },
  });

  const writeOff = useMutation({
    mutationFn: (id: string) => approveSchemeWriteOff(id, { reason }),
    onSuccess: () => {
      void shortfalls.refetch();
      setOpenShortfall(null);
      setReason('');
      publish({ title: 'Write-off approved', severity: 'success' });
    },
  });

  const claimRows = claims.data?.items ?? [];
  const caseRows = cases.data?.items ?? [];
  const shortfallRows = shortfalls.data?.items ?? [];
  const refusalRows = refusals.data?.items ?? [];
  const schemeRows = schemes.data?.items ?? [];

  const openShortfalls = shortfallRows.filter((s) => s.status === 'open' || s.status === 'appealed');
  const overdue = claimRows.filter(
    (c) => c.daysLeftInWindow !== null && c.daysLeftInWindow < 0 && c.status !== 'paid',
  );

  const tabs: ReadonlyArray<{ readonly key: Tab; readonly label: string }> = [
    { key: 'claims', label: `Claims${overdue.length > 0 ? ` (${String(overdue.length)} overdue)` : ''}` },
    { key: 'cases', label: 'Cases' },
    {
      key: 'shortfalls',
      label: `Shortfalls${openShortfalls.length > 0 ? ` (${String(openShortfalls.length)})` : ''}`,
    },
    { key: 'refusals', label: 'Cash refused' },
    { key: 'schemes', label: 'Schemes' },
  ];

  return (
    <section className="flex flex-col gap-4" data-testid="schemes-screen">
      <PageHeader
        eyebrow="RC-007 · government schemes"
        title="Government schemes"
        description="PMJAY, CGHS, ECHS, ESIC and state schemes. While a scheme case is open the patient tenders no cash — at any counter, enforced by the database rather than by the cashier remembering."
      />

      <nav aria-label="Scheme views" className="flex flex-wrap gap-1 border-b border-default">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            data-testid={`schemes-tab-${entry.key}`}
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

      {tab === 'claims' ? (
        <AsyncPanel
          loading={claims.isPending}
          error={claims.error}
          isEmpty={claimRows.length === 0}
          skeletonLabel="Loading scheme claims"
          skeletonRows={6}
          onRetry={() => {
            void claims.refetch();
          }}
          empty={
            <EmptyState
              cause="No scheme claim has been assembled."
              nextAction="A claim is built from a scheme case once the patient is discharged."
            />
          }
        >
          <div className="flex flex-col gap-3">
            <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
              <table className="w-full text-sm" data-testid="scheme-claim-list">
                <caption className="sr-only">Scheme claims</caption>
                <thead>
                  <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                    <th scope="col" className="px-3 py-2 text-start">
                      Claim
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Status
                    </th>
                    <th scope="col" className="px-3 py-2 text-end">
                      Claimed
                    </th>
                    <th scope="col" className="px-3 py-2 text-end">
                      Approved
                    </th>
                    <th scope="col" className="px-3 py-2 text-end">
                      Shortfall
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Window
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {claimRows.map((row: SchemeClaimView) => {
                    const days = row.daysLeftInWindow;
                    const settled = row.status === 'paid' || row.status === 'closed';
                    return (
                      <tr key={row.id} className="border-b border-default last:border-0">
                        <td className="px-3 py-2">
                          <span className="font-mono text-2xs">{row.claimNo}</span>
                          {row.schemeCode === null ? null : (
                            <Badge tone="neutral" className="ms-2">
                              {row.schemeCode}
                            </Badge>
                          )}
                          {row.utr === null ? null : (
                            <p className="mt-1 font-mono text-2xs text-fg-muted">UTR {row.utr}</p>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <Badge
                            tone={
                              row.status === 'paid'
                                ? 'success'
                                : row.status === 'rejected'
                                  ? 'danger'
                                  : row.status === 'draft' || row.status === 'closed'
                                    ? 'neutral'
                                    : 'warning'
                            }
                          >
                            {humanise(row.status)}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-end font-mono">{formatMoney(row.claimedAmount)}</td>
                        <td className="px-3 py-2 text-end font-mono">{formatMoney(row.approvedAmount)}</td>
                        <td className="px-3 py-2 text-end font-mono">
                          {row.shortfallAmount === '0.00' ? (
                            <span className="text-fg-muted">—</span>
                          ) : (
                            formatMoney(row.shortfallAmount)
                          )}
                        </td>
                        <td className="px-3 py-2 text-2xs">
                          {days === null ? (
                            <span className="text-fg-muted">opens at discharge</span>
                          ) : settled ? (
                            <span className="text-fg-muted">closed {row.windowClosesOn}</span>
                          ) : days < 0 ? (
                            <Badge tone="danger">{`${String(-days)} days past the window`}</Badge>
                          ) : days <= 7 ? (
                            <Badge tone="warning">{`${String(days)} days left`}</Badge>
                          ) : (
                            <span className="text-fg-muted">{`${String(days)} days left`}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-2xs text-fg-subtle">
              Past its window a claim pays nothing — the whole episode becomes the hospital&rsquo;s cost, so
              the days remaining matter more than the age of the row.
            </p>
          </div>
        </AsyncPanel>
      ) : null}

      {tab === 'cases' ? (
        <AsyncPanel
          loading={cases.isPending}
          error={cases.error}
          isEmpty={caseRows.length === 0}
          skeletonLabel="Loading scheme cases"
          skeletonRows={6}
          onRetry={() => {
            void cases.refetch();
          }}
          empty={
            <EmptyState
              cause="No scheme case is open."
              nextAction="A case opens once a verified card is attached to an episode. From that moment the patient tenders no cash."
            />
          }
        >
          <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
            <table className="w-full text-sm" data-testid="scheme-case-list">
              <caption className="sr-only">Scheme cases</caption>
              <thead>
                <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  <th scope="col" className="px-3 py-2 text-start">
                    Case
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2 text-end">
                    Packages
                  </th>
                  <th scope="col" className="px-3 py-2 text-end">
                    Settled
                  </th>
                  <th scope="col" className="px-3 py-2 text-end">
                    Shortfall
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    Cash
                  </th>
                </tr>
              </thead>
              <tbody>
                {caseRows.map((row: SchemeCaseView) => {
                  const live = row.status !== 'closed' && row.status !== 'rejected';
                  return (
                    <tr key={row.id} className="border-b border-default last:border-0">
                      <td className="px-3 py-2">
                        <span className="font-mono text-2xs">{row.caseNo}</span>
                        <Badge tone="neutral" className="ms-2">
                          {row.schemeCode}
                        </Badge>
                        {row.authorityCaseNo === null ? null : (
                          <p className="mt-1 font-mono text-2xs text-fg-muted">{row.authorityCaseNo}</p>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={row.status === 'settled' ? 'success' : live ? 'warning' : 'neutral'}>
                          {humanise(row.status)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-end font-mono">{formatMoney(row.packageAmount)}</td>
                      <td className="px-3 py-2 text-end font-mono">{formatMoney(row.settledAmount)}</td>
                      <td className="px-3 py-2 text-end font-mono">
                        {row.shortfallAmount === '0.00' ? (
                          <span className="text-fg-muted">—</span>
                        ) : (
                          formatMoney(row.shortfallAmount)
                        )}
                      </td>
                      <td className="px-3 py-2 text-2xs">
                        {live ? (
                          <Badge tone="danger">blocked</Badge>
                        ) : (
                          <span className="text-fg-muted">block lifted</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </AsyncPanel>
      ) : null}

      {tab === 'shortfalls' ? (
        <AsyncPanel
          loading={shortfalls.isPending}
          error={shortfalls.error}
          isEmpty={shortfallRows.length === 0}
          skeletonLabel="Loading shortfalls"
          skeletonRows={6}
          onRetry={() => {
            void shortfalls.refetch();
          }}
          empty={
            <EmptyState
              cause="No scheme has short-paid a claim."
              nextAction="Every settled claim paid what it asked for."
            />
          }
        >
          <div className="flex flex-col gap-3">
            <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
              <table className="w-full text-sm" data-testid="shortfall-list">
                <caption className="sr-only">Scheme shortfalls</caption>
                <thead>
                  <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                    <th scope="col" className="px-3 py-2 text-start">
                      Claim
                    </th>
                    <th scope="col" className="px-3 py-2 text-end">
                      Not paid
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Why
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Status
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shortfallRows.map((row: SchemeShortfallView) => (
                    <tr key={row.id} className="border-b border-default last:border-0">
                      <td className="px-3 py-2 font-mono text-2xs">{row.claimNo ?? '—'}</td>
                      <td className="px-3 py-2 text-end font-mono">{formatMoney(row.amount)}</td>
                      <td className="px-3 py-2">
                        {humanise(row.category)}
                        <p className="mt-1 font-mono text-2xs text-fg-muted">{row.reasonCode}</p>
                      </td>
                      <td className="px-3 py-2">
                        <Badge
                          tone={
                            row.status === 'recovered'
                              ? 'success'
                              : row.status === 'written_off'
                                ? 'neutral'
                                : 'warning'
                          }
                        >
                          {humanise(row.status)}
                        </Badge>
                        {row.appealRef === null ? null : (
                          <p className="mt-1 font-mono text-2xs text-fg-muted">{row.appealRef}</p>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {row.status === 'open' || row.status === 'appealed' ? (
                          <Button
                            variant="ghost"
                            data-testid={`open-shortfall-${row.id}`}
                            onClick={() => {
                              setOpenShortfall(row.id === openShortfall ? null : row.id);
                              setReason('');
                            }}
                          >
                            {row.id === openShortfall ? 'Close' : 'Work it'}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {appeal.error === null ? null : <ProblemCard error={appeal.error} />}
            {writeOff.error === null ? null : <ProblemCard error={writeOff.error} />}

            {openShortfall === null ? null : (
              <div
                className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
                data-testid="work-shortfall"
              >
                <div className="flex min-w-72 flex-col gap-1">
                  <Label htmlFor="shortfall-reason">Why?</Label>
                  <Input
                    id="shortfall-reason"
                    data-testid="shortfall-reason"
                    value={reason}
                    autoComplete="off"
                    onChange={(event) => {
                      setReason(event.target.value);
                    }}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    data-testid="appeal-shortfall"
                    disabled={reason.trim() === '' || appeal.isPending || !canAppeal}
                    onClick={() => {
                      appeal.mutate({ id: openShortfall, action: 'appeal' });
                    }}
                  >
                    Appeal it
                  </Button>
                  <Button
                    variant="secondary"
                    data-testid="request-writeoff"
                    disabled={reason.trim() === '' || appeal.isPending || !canAppeal}
                    onClick={() => {
                      appeal.mutate({ id: openShortfall, action: 'request_writeoff' });
                    }}
                  >
                    Ask to write it off
                  </Button>
                  {canWriteOff ? (
                    <Button
                      variant="secondary"
                      data-testid="approve-writeoff"
                      disabled={reason.trim() === '' || writeOff.isPending}
                      onClick={() => {
                        writeOff.mutate(openShortfall);
                      }}
                    >
                      Approve the write-off
                    </Button>
                  ) : null}
                </div>
                <p className="text-2xs text-fg-subtle">
                  Asking for a write-off and approving one are two permissions. The person who worked the
                  claim has every reason to make an awkward deduction disappear quietly, so the database
                  refuses an approval from the same hands that requested it.
                </p>
              </div>
            )}
          </div>
        </AsyncPanel>
      ) : null}

      {tab === 'refusals' && !canSeeRefusals ? (
        <EmptyState
          cause="You cannot read the cash-refusal log."
          nextAction="scheme.cash.attempt.read is held by the scheme desk, finance and quality."
        />
      ) : null}

      {tab === 'refusals' && canSeeRefusals ? (
        <AsyncPanel
          loading={refusals.isPending}
          error={refusals.error}
          isEmpty={refusalRows.length === 0}
          skeletonLabel="Loading refused tenders"
          skeletonRows={6}
          onRetry={() => {
            void refusals.refetch();
          }}
          empty={
            <EmptyState
              cause="No counter has tried to take cash from a scheme patient."
              nextAction="Nothing to show is the right answer here. Every row that appears is a family who was asked for money they do not owe."
            />
          }
        >
          <div className="flex flex-col gap-3">
            <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
              <table className="w-full text-sm" data-testid="cash-attempt-list">
                <caption className="sr-only">Cash tenders refused</caption>
                <thead>
                  <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                    <th scope="col" className="px-3 py-2 text-start">
                      When
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Counter
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Tender
                    </th>
                    <th scope="col" className="px-3 py-2 text-end">
                      Amount
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Scheme
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {refusalRows.map((row: SchemeCashAttemptView) => (
                    <tr key={row.id} className="border-b border-default last:border-0">
                      <td className="px-3 py-2 text-2xs text-fg-muted">{formatInstant(row.attemptedAt)}</td>
                      <td className="px-3 py-2">
                        {COLLECTION_POINTS[row.collectionPoint] ?? humanise(row.collectionPoint)}
                      </td>
                      <td className="px-3 py-2">{humanise(row.mode)}</td>
                      <td className="px-3 py-2 text-end font-mono">{formatMoney(row.amount)}</td>
                      <td className="px-3 py-2">
                        <Badge tone="danger">{row.schemeCode}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-2xs text-fg-subtle">
              This log is append-only in the database. An NHA audit does not ask whether you take cash from
              Ayushman patients — it asks you to show what happened when somebody tried, and a log that could
              have been tidied up answers nothing.
            </p>
          </div>
        </AsyncPanel>
      ) : null}

      {tab === 'schemes' ? (
        <AsyncPanel
          loading={schemes.isPending}
          error={schemes.error}
          isEmpty={schemeRows.length === 0}
          skeletonLabel="Loading schemes"
          skeletonRows={4}
          onRetry={() => {
            void schemes.refetch();
          }}
          empty={
            <EmptyState
              cause="This hospital is not empanelled for any scheme."
              nextAction="Finance configures the scheme master and its rate list."
            />
          }
        >
          <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
            <table className="w-full text-sm" data-testid="scheme-list">
              <caption className="sr-only">Empanelled schemes</caption>
              <thead>
                <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  <th scope="col" className="px-3 py-2 text-start">
                    Scheme
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    Cash rule
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    Claim format
                  </th>
                  <th scope="col" className="px-3 py-2 text-end">
                    Window
                  </th>
                  <th scope="col" className="px-3 py-2 text-end">
                    Packages
                  </th>
                </tr>
              </thead>
              <tbody>
                {schemeRows.map((row: SchemeView) => (
                  <tr key={row.id} className="border-b border-default last:border-0">
                    <td className="px-3 py-2">
                      <span className="font-mono text-2xs text-fg-muted">{row.code}</span>
                      <span className="ms-2">{row.name}</span>
                      {row.empanelmentNo === null ? null : (
                        <p className="mt-1 font-mono text-2xs text-fg-subtle">{row.empanelmentNo}</p>
                      )}
                    </td>
                    <td className="px-3 py-2 text-2xs">
                      {row.cashBlockScope === 'always' ? (
                        <Badge tone="danger">no cash, ever</Badge>
                      ) : row.cashBlockScope === 'active_case' ? (
                        <Badge tone="warning">no cash while a case is open</Badge>
                      ) : (
                        <Badge tone="neutral">advisory only</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-2xs">{row.claimFormat}</td>
                    <td className="px-3 py-2 text-end font-mono text-2xs">{row.claimWindowDays} d</td>
                    <td className="px-3 py-2 text-end font-mono text-2xs">{row.packageCount}</td>
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
