'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { formatDate, formatInstant, formatMoney, humanise } from '@/features/pharmacy/lib/format';
import {
  getPreauth,
  listPreauths,
  recordPreauthDecision,
  replyPreauthQuery,
  submitPreauth,
} from '../api/client';
import { rcmKeys } from '../api/keys';
import type { PreauthView } from '../api/types';

/**
 * EN-002 / RC-002 — the pre-authorisation queue.
 *
 * ── The list is sorted by the clock, not by date ────────────────────────────
 *
 * A pre-auth that misses its decision deadline stops being cashless. The family
 * then pays up front and claims it back themselves, which for most patients
 * means an admission they cannot afford. So the queue leads with what is closest
 * to breaching, and a breached row says so in words rather than turning a date
 * red and hoping somebody notices.
 *
 * ── An open payer query is shown as *our* problem ───────────────────────────
 *
 * While a query is unanswered the clock is ours, not the insurer's. A desk that
 * reads "waiting on payer" for something the payer is waiting on us for is the
 * single commonest way a cashless case lapses, so an open query is rendered as
 * an action, not a status.
 *
 * ── Submit and decision are never both available ────────────────────────────
 *
 * Two keys, two roles, a `block` rule. The desk submits; finance records what
 * came back. Rendering both would suggest one person walks the whole path, which
 * is exactly what the rule exists to prevent — an approval nobody received is
 * otherwise indistinguishable from one that arrived.
 */
export function PreauthScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = rcmKeys(hospitalId);
  const { publish } = useToast();

  const [openId, setOpenId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [approvedAmount, setApprovedAmount] = useState('');
  const [validTill, setValidTill] = useState('');
  const [payerRef, setPayerRef] = useState('');
  const [replyText, setReplyText] = useState('');

  const canSubmit = granted.has('preauth.submit');
  const canDecide = granted.has('preauth.decision.record');
  const canReply = granted.has('preauth.query.reply');

  const preauths = useQuery({
    queryKey: keys.preauths('all'),
    queryFn: ({ signal }) => listPreauths({}, { signal }),
  });

  const detail = useQuery({
    queryKey: keys.preauth(openId ?? 'none'),
    queryFn: ({ signal }) =>
      openId === null ? Promise.reject(new Error('no preauth')) : getPreauth(openId, { signal }),
    enabled: openId !== null,
  });

  const submit = useMutation({
    mutationFn: (id: string) => submitPreauth(id, { reason, decisionHours: 24 }),
    onSuccess: () => {
      void preauths.refetch();
      void detail.refetch();
      setReason('');
      publish({
        title: 'Submitted to the payer',
        description: 'The decision clock has started.',
        severity: 'success',
      });
    },
  });

  const decide = useMutation({
    mutationFn: (input: {
      readonly id: string;
      readonly status: 'approved' | 'partially_approved' | 'denied';
    }) =>
      recordPreauthDecision(input.id, {
        status: input.status,
        ...(input.status === 'denied'
          ? { denialReasonCode: 'PAYER_DENIED' }
          : {
              approvedAmount: Number(approvedAmount),
              validTill,
              ...(payerRef === '' ? {} : { payerRefNo: payerRef }),
            }),
        reason,
      }),
    onSuccess: () => {
      void preauths.refetch();
      void detail.refetch();
      setReason('');
      setApprovedAmount('');
      setValidTill('');
      setPayerRef('');
      publish({ title: 'Decision recorded', severity: 'success' });
    },
  });

  const reply = useMutation({
    mutationFn: (id: string) => replyPreauthQuery(id, { replyText }),
    onSuccess: () => {
      void detail.refetch();
      void preauths.refetch();
      setReplyText('');
      publish({
        title: 'Query answered',
        description: 'The clock is the payer’s again.',
        severity: 'success',
      });
    },
  });

  const rows = preauths.data?.items ?? [];
  const pa = detail.data ?? null;

  return (
    <section className="flex flex-col gap-4" data-testid="preauth-screen">
      <PageHeader
        eyebrow="EN-002 / RC-002 · pre-authorisation"
        title="Pre-authorisation"
        description="What each insurer has been asked for, what they have answered, and what is running out of time. A missed deadline turns a cashless admission into one the family funds themselves."
      />

      <AsyncPanel
        loading={preauths.isPending}
        error={preauths.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading pre-authorisations"
        skeletonRows={8}
        onRetry={() => {
          void preauths.refetch();
        }}
        empty={
          <EmptyState
            cause="Nothing is awaiting a payer."
            nextAction="A pre-authorisation is raised against an insurance case once a procedure is planned."
          />
        }
      >
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm" data-testid="preauth-list">
            <caption className="sr-only">Pre-authorisations, soonest deadline first</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                <th scope="col" className="px-3 py-2 text-start">
                  Reference
                </th>
                <th scope="col" className="px-3 py-2 text-start">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 text-end">
                  Asked
                </th>
                <th scope="col" className="px-3 py-2 text-end">
                  Approved
                </th>
                <th scope="col" className="px-3 py-2 text-start">
                  Clock
                </th>
                <th scope="col" className="px-3 py-2 text-start">
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row: PreauthView) => (
                <tr key={row.id} className="border-b border-default last:border-0">
                  <td className="px-3 py-2">
                    <span className="font-mono text-2xs">{row.preauthNo}</span>
                    {row.isEmergency ? (
                      <Badge tone="danger" className="ms-2">
                        emergency
                      </Badge>
                    ) : null}
                    {row.type === 'initial' ? null : (
                      <Badge tone="neutral" className="ms-2">
                        {humanise(row.type)}
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge
                      tone={
                        row.status === 'approved' || row.status === 'final_authorised'
                          ? 'success'
                          : row.status === 'denied'
                            ? 'danger'
                            : row.status === 'partially_approved'
                              ? 'warning'
                              : 'neutral'
                      }
                    >
                      {humanise(row.status)}
                    </Badge>
                    {row.openQueries > 0 ? (
                      <Badge tone="warning" className="ms-2">
                        {row.openQueries} query awaiting us
                      </Badge>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-end font-mono">{formatMoney(row.requestedAmount)}</td>
                  <td className="px-3 py-2 text-end font-mono">
                    {row.approvedAmount === null ? (
                      <span className="text-fg-muted">—</span>
                    ) : (
                      formatMoney(row.approvedAmount)
                    )}
                  </td>
                  <td className="px-3 py-2 text-2xs">
                    {row.decidedAt !== null ? (
                      <span className="text-fg-muted">decided {formatInstant(row.decidedAt)}</span>
                    ) : row.slaBreached ? (
                      <span className="font-semibold text-danger-on-surface">
                        deadline passed — cashless at risk
                      </span>
                    ) : row.decisionDueAt === null ? (
                      <span className="text-fg-muted">not submitted</span>
                    ) : (
                      <>due {formatInstant(row.decisionDueAt)}</>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      variant="ghost"
                      data-testid={`open-preauth-${row.preauthNo}`}
                      onClick={() => {
                        setOpenId(row.id === openId ? null : row.id);
                        setReason('');
                      }}
                    >
                      {row.id === openId ? 'Close' : 'Open'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      {openId === null || pa === null ? null : (
        <div
          className="flex flex-col gap-4 rounded-lg border border-strong bg-layer-1 p-4"
          data-testid="preauth-detail"
        >
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-md">{pa.preauthNo}</span>
            <Badge tone={pa.status === 'denied' ? 'danger' : 'neutral'}>{humanise(pa.status)}</Badge>
            {pa.validTill === null ? null : (
              <span className="text-2xs text-fg-subtle">valid until {formatDate(pa.validTill)}</span>
            )}
            {pa.payerRefNo === null ? null : (
              <span className="font-mono text-2xs text-fg-subtle">payer ref {pa.payerRefNo}</span>
            )}
          </div>

          {pa.queries.filter((q) => q.isOpen).length === 0 ? null : (
            <div className="rounded-md border border-warning-border bg-warning-surface p-3">
              <p className="text-sm font-semibold text-warning-on-surface">The payer is waiting on us</p>
              <p className="text-sm text-warning-on-surface">
                While a query is unanswered the decision clock is ours, not the insurer&rsquo;s. This is the
                commonest way a cashless case quietly lapses.
              </p>
            </div>
          )}

          {pa.queries.length === 0 ? null : (
            <div className="flex flex-col gap-2" data-testid="preauth-queries">
              <h3 className="text-sm font-semibold">Queries</h3>
              {pa.queries.map((q) => (
                <div key={q.id} className="rounded-md border border-default p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={q.isOpen ? 'warning' : 'neutral'}>
                      {q.isOpen ? 'awaiting our reply' : 'answered'}
                    </Badge>
                    <span className="text-2xs text-fg-subtle">
                      #{q.queryNo} · {humanise(q.category)} · raised {formatInstant(q.raisedAt)}
                    </span>
                  </div>
                  <p className="mt-1">{q.text}</p>
                  {q.replyText === null ? null : (
                    <p className="mt-1 text-fg-muted">Our reply: {q.replyText}</p>
                  )}
                  {q.isOpen && canReply ? (
                    <div className="mt-2 flex flex-wrap items-end gap-2">
                      <div className="flex min-w-72 flex-1 flex-col gap-1">
                        <Label htmlFor={`reply-${q.id}`}>Reply</Label>
                        <Input
                          id={`reply-${q.id}`}
                          data-testid="query-reply"
                          value={replyText}
                          autoComplete="off"
                          onChange={(event) => {
                            setReplyText(event.target.value);
                          }}
                        />
                      </div>
                      <Button
                        data-testid={`send-reply-${q.id}`}
                        disabled={replyText.trim() === '' || reply.isPending}
                        onClick={() => {
                          reply.mutate(q.id);
                        }}
                      >
                        Send
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-1" data-testid="preauth-history">
            <h3 className="text-sm font-semibold">Trail</h3>
            <ol className="flex flex-col gap-1 text-2xs text-fg-subtle">
              {pa.history.map((h, i) => (
                <li key={`${h.at}-${String(i)}`}>
                  <span className="font-mono">{formatInstant(h.at)}</span> — {humanise(h.toStatus)}{' '}
                  <Badge tone={h.actorType === 'payer' ? 'accent' : 'neutral'} size="sm">
                    {h.actorType}
                  </Badge>
                  {h.reason === null ? '' : ` · ${h.reason}`}
                </li>
              ))}
            </ol>
            <p className="text-2xs text-fg-subtle">
              This trail is append-only in the database. When a payer disputes what was sent and when, it is
              the hospital&rsquo;s evidence — and evidence that could have been edited is not evidence.
            </p>
          </div>

          {submit.error === null ? null : <ProblemCard error={submit.error} />}
          {decide.error === null ? null : <ProblemCard error={decide.error} />}
          {reply.error === null ? null : <ProblemCard error={reply.error} />}

          <div className="flex flex-col gap-3 border-t border-default pt-3">
            <div className="flex min-w-72 flex-col gap-1">
              <Label htmlFor="preauth-reason">Reason</Label>
              <Input
                id="preauth-reason"
                data-testid="preauth-reason"
                value={reason}
                autoComplete="off"
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            </div>

            {canSubmit && (pa.status === 'draft' || pa.status === 'ready') ? (
              <Button
                data-testid="submit-preauth"
                disabled={reason.trim() === '' || submit.isPending}
                onClick={() => {
                  submit.mutate(pa.id);
                }}
              >
                Submit to the payer
              </Button>
            ) : null}

            {canDecide && ['submitted', 'query_raised', 'query_replied'].includes(pa.status) ? (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-fg-muted">
                  Record what the payer sent back. An approval is an amount and a date — not a yes.
                </p>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex w-40 flex-col gap-1">
                    <Label htmlFor="approved-amount">Approved ₹</Label>
                    <Input
                      id="approved-amount"
                      data-testid="approved-amount"
                      value={approvedAmount}
                      autoComplete="off"
                      onChange={(event) => {
                        setApprovedAmount(event.target.value);
                      }}
                    />
                  </div>
                  <div className="flex w-40 flex-col gap-1">
                    <Label htmlFor="valid-till">Valid until</Label>
                    <Input
                      id="valid-till"
                      data-testid="valid-till"
                      value={validTill}
                      placeholder="YYYY-MM-DD"
                      autoComplete="off"
                      onChange={(event) => {
                        setValidTill(event.target.value);
                      }}
                    />
                  </div>
                  <div className="flex w-48 flex-col gap-1">
                    <Label htmlFor="payer-ref">Payer reference</Label>
                    <Input
                      id="payer-ref"
                      data-testid="payer-ref"
                      value={payerRef}
                      autoComplete="off"
                      onChange={(event) => {
                        setPayerRef(event.target.value);
                      }}
                    />
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    data-testid="record-approved"
                    disabled={
                      reason.trim() === '' ||
                      approvedAmount.trim() === '' ||
                      validTill.trim() === '' ||
                      decide.isPending
                    }
                    onClick={() => {
                      decide.mutate({ id: pa.id, status: 'approved' });
                    }}
                  >
                    Approved in full
                  </Button>
                  <Button
                    variant="secondary"
                    data-testid="record-partial"
                    disabled={
                      reason.trim() === '' ||
                      approvedAmount.trim() === '' ||
                      validTill.trim() === '' ||
                      decide.isPending
                    }
                    onClick={() => {
                      decide.mutate({ id: pa.id, status: 'partially_approved' });
                    }}
                  >
                    Partially approved
                  </Button>
                  <Button
                    variant="danger"
                    data-testid="record-denied"
                    disabled={reason.trim() === '' || decide.isPending}
                    onClick={() => {
                      decide.mutate({ id: pa.id, status: 'denied' });
                    }}
                  >
                    Denied
                  </Button>
                </div>
              </div>
            ) : null}

            {!canSubmit && !canDecide ? (
              <p className="text-sm text-fg-muted">
                Submitting needs <code>preauth.submit</code> and recording the payer&rsquo;s answer needs{' '}
                <code>preauth.decision.record</code>. They are held by different people on purpose.
              </p>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
