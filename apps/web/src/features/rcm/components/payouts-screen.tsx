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
  approvePayoutStatement,
  computePayoutPeriod,
  getPayoutStatement,
  listPayoutPeriods,
  listPayoutStatements,
  payPayoutStatement,
} from '../api/client';
import { rcmKeys } from '../api/keys';
import type { PayoutPeriodView, PayoutStatementView } from '../api/types';

/**
 * NC-034 — doctor payouts.
 *
 * ── Every line says what the doctor did to earn it ──────────────────────────
 *
 * That is not presentation, it is the module's whole guarantee showing through.
 * A payout line can only point at a service the doctor **performed** — the
 * database refuses one that names them as the referrer while somebody else did
 * the work — so the detail below is also the evidence that nothing here is a
 * referral commission.
 *
 * ── The two buttons are held by two roles ───────────────────────────────────
 *
 * Finance computes and pays; the hospital admin approves. A payout statement is
 * an outbound payment authorised on a calculation nobody else has checked, so
 * the person who ran it does not also release it — and a statement with an open
 * dispute is not approvable at all.
 */
export function PayoutsScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = rcmKeys(hospitalId);
  const { publish } = useToast();

  const [periodId, setPeriodId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [paymentRef, setPaymentRef] = useState('');

  const canCompute = granted.has('payout.statement.compute');
  const canApprove = granted.has('payout.statement.approve');
  const canPay = granted.has('payout.statement.pay');

  const periods = useQuery({
    queryKey: keys.payoutPeriods(),
    queryFn: ({ signal }) => listPayoutPeriods({ signal }),
  });
  const statements = useQuery({
    queryKey: keys.payoutStatements(periodId ?? 'all'),
    queryFn: ({ signal }) => listPayoutStatements(periodId === null ? {} : { periodId }, { signal }),
  });
  const detail = useQuery({
    queryKey: keys.payoutStatement(openId ?? 'none'),
    queryFn: ({ signal }) => getPayoutStatement(openId ?? '', { signal }),
    enabled: openId !== null,
  });

  const compute = useMutation({
    mutationFn: (id: string) => computePayoutPeriod(id),
    onSuccess: () => {
      void periods.refetch();
      void statements.refetch();
      publish({ title: 'Period computed', severity: 'success' });
    },
  });

  const decide = useMutation({
    mutationFn: (input: { readonly id: string; readonly action: 'approve' | 'pay' }) =>
      input.action === 'approve'
        ? approvePayoutStatement(input.id, { reason })
        : payPayoutStatement(input.id, { paymentRef, reason }),
    onSuccess: () => {
      void statements.refetch();
      void detail.refetch();
      setReason('');
      setPaymentRef('');
      publish({ title: 'Statement updated', severity: 'success' });
    },
  });

  const periodRows = periods.data?.items ?? [];
  const rows = statements.data?.items ?? [];
  const open = detail.data;

  return (
    <section className="flex flex-col gap-4" data-testid="payouts-screen">
      <PageHeader
        eyebrow="NC-034 · doctor payouts"
        title="Doctor payouts"
        description="What each doctor earned on work they performed. A payment for a referral is not blocked here — it has no shape in this system, so the question never arises."
      />

      <AsyncPanel
        loading={periods.isPending}
        error={periods.error}
        isEmpty={periodRows.length === 0}
        skeletonLabel="Loading payout periods"
        skeletonRows={3}
        onRetry={() => {
          void periods.refetch();
        }}
        empty={
          <EmptyState
            cause="No payout period has been opened."
            nextAction="Finance opens a period, then computes it from the month's delivered services."
          />
        }
      >
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm" data-testid="payout-period-list">
            <caption className="sr-only">Payout periods</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                <th scope="col" className="px-3 py-2 text-start">
                  Period
                </th>
                <th scope="col" className="px-3 py-2 text-start">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 text-end">
                  Doctors
                </th>
                <th scope="col" className="px-3 py-2 text-end">
                  Gross
                </th>
                <th scope="col" className="px-3 py-2 text-end">
                  TDS
                </th>
                <th scope="col" className="px-3 py-2 text-end">
                  Net
                </th>
                <th scope="col" className="px-3 py-2 text-start">
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {periodRows.map((row: PayoutPeriodView) => (
                <tr key={row.id} className="border-b border-default last:border-0">
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      data-testid={`select-period-${row.id}`}
                      className={`font-mono text-2xs underline-offset-2 hover:underline ${
                        periodId === row.id ? 'text-accent-fg' : ''
                      }`}
                      onClick={() => {
                        setPeriodId(periodId === row.id ? null : row.id);
                        setOpenId(null);
                      }}
                    >
                      {row.label}
                    </button>
                    <p className="text-2xs text-fg-subtle">
                      {row.periodFrom} → {row.periodTo}
                    </p>
                  </td>
                  <td className="px-3 py-2">
                    <Badge
                      tone={row.status === 'paid' ? 'success' : row.status === 'open' ? 'neutral' : 'warning'}
                    >
                      {humanise(row.status)}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-end font-mono text-2xs">{row.statementCount}</td>
                  <td className="px-3 py-2 text-end font-mono">{formatMoney(row.grossTotal)}</td>
                  <td className="px-3 py-2 text-end font-mono text-2xs">{formatMoney(row.tdsTotal)}</td>
                  <td className="px-3 py-2 text-end font-mono">{formatMoney(row.netTotal)}</td>
                  <td className="px-3 py-2">
                    {canCompute && row.status !== 'paid' ? (
                      <Button
                        variant="ghost"
                        data-testid={`compute-period-${row.id}`}
                        disabled={compute.isPending}
                        onClick={() => {
                          compute.mutate(row.id);
                        }}
                      >
                        Compute
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      {compute.error === null ? null : <ProblemCard error={compute.error} />}

      <AsyncPanel
        loading={statements.isPending}
        error={statements.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading statements"
        skeletonRows={5}
        onRetry={() => {
          void statements.refetch();
        }}
        empty={
          <EmptyState
            cause="No statement in this period."
            nextAction="Computing a period builds one statement per doctor with a live contract."
          />
        }
      >
        <div className="flex flex-col gap-3">
          <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
            <table className="w-full text-sm" data-testid="payout-statement-list">
              <caption className="sr-only">Payout statements</caption>
              <thead>
                <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  <th scope="col" className="px-3 py-2 text-start">
                    Statement
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2 text-end">
                    Earned
                  </th>
                  <th scope="col" className="px-3 py-2 text-end">
                    TDS
                  </th>
                  <th scope="col" className="px-3 py-2 text-end">
                    Net
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row: PayoutStatementView) => (
                  <tr key={row.id} className="border-b border-default last:border-0">
                    <td className="px-3 py-2">
                      <span className="font-mono text-2xs">{row.statementNo}</span>
                      <p className="text-2xs text-fg-subtle">
                        {row.lineCount} {row.lineCount === 1 ? 'line' : 'lines'}
                      </p>
                    </td>
                    <td className="px-3 py-2">
                      <Badge
                        tone={
                          row.status === 'paid'
                            ? 'success'
                            : row.status === 'disputed'
                              ? 'danger'
                              : row.status === 'approved'
                                ? 'warning'
                                : 'neutral'
                        }
                      >
                        {humanise(row.status)}
                      </Badge>
                      {row.openDisputes > 0 ? (
                        <Badge tone="danger" className="ms-2">
                          {row.openDisputes} open
                        </Badge>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-end font-mono">{formatMoney(row.grossEarnings)}</td>
                    <td className="px-3 py-2 text-end font-mono text-2xs">{formatMoney(row.tdsAmount)}</td>
                    <td className="px-3 py-2 text-end font-mono text-base">{formatMoney(row.netPayable)}</td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        data-testid={`open-statement-${row.id}`}
                        className="text-sm text-accent-fg underline-offset-2 hover:underline"
                        onClick={() => {
                          setOpenId(row.id === openId ? null : row.id);
                          setReason('');
                          setPaymentRef('');
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

          {decide.error === null ? null : <ProblemCard error={decide.error} />}

          {open === undefined ? null : (
            <div
              className="flex flex-col gap-4 rounded-lg border border-strong bg-layer-1 p-4"
              data-testid="payout-statement-detail"
            >
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="font-mono text-sm">{open.statementNo}</span>
                <Badge tone={open.status === 'paid' ? 'success' : 'neutral'}>{humanise(open.status)}</Badge>
                {open.paymentRef === null ? null : (
                  <span className="font-mono text-2xs text-fg-muted">{open.paymentRef}</span>
                )}
              </div>

              <div>
                <h3 className="mb-2 text-sm font-medium">What was earned, and on what</h3>
                <div className="overflow-x-auto rounded-lg border border-default">
                  <table className="w-full text-sm" data-testid="payout-line-list">
                    <caption className="sr-only">Payout lines</caption>
                    <thead>
                      <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                        <th scope="col" className="px-3 py-2 text-start">
                          Service performed
                        </th>
                        <th scope="col" className="px-3 py-2 text-end">
                          Collected
                        </th>
                        <th scope="col" className="px-3 py-2 text-end">
                          Share
                        </th>
                        <th scope="col" className="px-3 py-2 text-end">
                          Earned
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {open.lines.map((l) => (
                        <tr key={l.id} className="border-b border-default last:border-0">
                          <td className="px-3 py-2">
                            {l.description}
                            <p className="mt-1 font-mono text-2xs text-fg-subtle">{humanise(l.sourceType)}</p>
                          </td>
                          <td className="px-3 py-2 text-end font-mono">{formatMoney(l.baseAmount)}</td>
                          <td className="px-3 py-2 text-end font-mono text-2xs">
                            {l.sharePct === null ? '—' : `${l.sharePct}%`}
                          </td>
                          <td className="px-3 py-2 text-end font-mono">{formatMoney(l.earnedAmount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-2xs text-fg-subtle">
                  Every line names a service this doctor <strong>performed</strong>. A line pointing at work
                  somebody else did is refused by the database, so this list is also the evidence that none of
                  it is a referral commission.
                </p>
              </div>

              {open.tds === null ? null : (
                <div className="rounded-lg border border-strong bg-layer-2 p-3">
                  <h3 className="mb-1 text-sm font-medium">Section 194J</h3>
                  <p className="font-mono text-2xs">
                    {open.tds.financialYear} · year to date {formatMoney(open.tds.grossYearToDate)} ·
                    threshold {formatMoney(open.tds.thresholdAmount)} · {open.tds.rateApplied}%{' '}
                    {open.tds.panOnRecord ? '(PAN on record)' : '(no PAN — section 206AA)'} · deducted{' '}
                    {formatMoney(open.tds.deducted)}
                  </p>
                  {Number(open.tds.grossYearToDate) < Number(open.tds.thresholdAmount) ? (
                    <p className="mt-1 text-2xs text-fg-subtle">
                      Below the annual threshold, so nothing is deducted yet.
                    </p>
                  ) : null}
                </div>
              )}

              {open.disputes.length === 0 ? null : (
                <div>
                  <h3 className="mb-1 text-sm font-medium">Disputes</h3>
                  <ul className="flex flex-col gap-2">
                    {open.disputes.map((d) => (
                      <li key={d.id} className="rounded-lg border border-default p-2 text-2xs">
                        <Badge tone={d.status === 'open' ? 'danger' : 'neutral'}>{humanise(d.status)}</Badge>
                        <span className="ms-2">{humanise(d.category)}</span>
                        {d.claimedAmount === null ? null : (
                          <span className="ms-2 font-mono">{formatMoney(d.claimedAmount)}</span>
                        )}
                        <p className="mt-1 text-fg-muted">{d.claim}</p>
                        {d.resolution === null ? null : (
                          <p className="mt-1 text-fg-subtle">
                            {formatInstant(d.resolvedAt ?? d.raisedAt)} — {d.resolution}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {open.status === 'computed' && canApprove ? (
                <div className="flex flex-col gap-2">
                  <div className="flex min-w-72 flex-col gap-1">
                    <Label htmlFor="approve-reason">Why release it?</Label>
                    <Input
                      id="approve-reason"
                      data-testid="approve-reason"
                      value={reason}
                      autoComplete="off"
                      onChange={(event) => {
                        setReason(event.target.value);
                      }}
                    />
                  </div>
                  <div>
                    <Button
                      data-testid="approve-statement"
                      disabled={reason.trim() === '' || decide.isPending}
                      onClick={() => {
                        decide.mutate({ id: open.id, action: 'approve' });
                      }}
                    >
                      Release for payment
                    </Button>
                  </div>
                  <p className="text-2xs text-fg-subtle">
                    Approving is a different pair of hands from computing, and a statement with an open
                    dispute cannot be approved at all — a paid statement is far harder to correct than a held
                    one.
                  </p>
                </div>
              ) : null}

              {open.status === 'approved' && canPay ? (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap gap-3">
                    <div className="flex min-w-60 flex-col gap-1">
                      <Label htmlFor="payment-ref">Payment reference</Label>
                      <Input
                        id="payment-ref"
                        data-testid="payment-ref"
                        value={paymentRef}
                        autoComplete="off"
                        onChange={(event) => {
                          setPaymentRef(event.target.value);
                        }}
                      />
                    </div>
                    <div className="flex min-w-60 flex-col gap-1">
                      <Label htmlFor="pay-reason">Why?</Label>
                      <Input
                        id="pay-reason"
                        data-testid="pay-reason"
                        value={reason}
                        autoComplete="off"
                        onChange={(event) => {
                          setReason(event.target.value);
                        }}
                      />
                    </div>
                  </div>
                  <div>
                    <Button
                      data-testid="pay-statement"
                      disabled={paymentRef.trim() === '' || reason.trim() === '' || decide.isPending}
                      onClick={() => {
                        decide.mutate({ id: open.id, action: 'pay' });
                      }}
                    >
                      Record the payment
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </AsyncPanel>
    </section>
  );
}
