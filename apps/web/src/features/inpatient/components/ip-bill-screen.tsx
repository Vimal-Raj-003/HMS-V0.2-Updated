'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Label } from '@vims/ui';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { clearDischarge, getClearance, getRunningBill, overrideClearance, runCharges } from '../api/client';
import { ipKeys } from '../api/keys';

/**
 * IP-005 — the running bill and the door.
 *
 * ── The superseded lines are shown, not hidden ──────────────────────────────
 *
 * When a back-dated transfer corrects a night, the wrong charge is superseded
 * rather than deleted, and this screen will show it on request. "What did you
 * charge me on Tuesday" has to have an answer even when the answer was wrong,
 * and a family disputing a bill is entitled to see the correction as a
 * correction rather than as an absence.
 *
 * ── Running the job twice is a supported thing to do ────────────────────────
 *
 * The button has no confirmation and no cooldown, because the job is idempotent
 * against a unique index: a retry, a double-click and two overlapping workers
 * all produce the same bill. The counts after a run say `posted` and `skipped`,
 * and on a correct second run they swap — which is the fastest way to see the
 * property holding without reading the bill.
 */
export function IpBillScreen(): React.JSX.Element {
  const params = useSearchParams();
  const admissionId = params.get('id') ?? '';
  const { hospitalId } = useSession();
  const keys = ipKeys(hospitalId);
  const queryClient = useQueryClient();

  const [showSuperseded, setShowSuperseded] = useState(false);
  const [acknowledgement, setAcknowledgement] = useState('');
  const [overrideReason, setOverrideReason] = useState('');

  const bill = useQuery({
    queryKey: [...keys.runningBill(admissionId), showSuperseded],
    queryFn: ({ signal }) => getRunningBill(admissionId, showSuperseded, { signal }),
    enabled: admissionId !== '',
  });

  const clearance = useQuery({
    queryKey: keys.clearance(admissionId),
    queryFn: ({ signal }) => getClearance(admissionId, { signal }),
    enabled: admissionId !== '',
  });

  function invalidate(): void {
    void queryClient.invalidateQueries({ queryKey: keys.billRoot() });
    void queryClient.invalidateQueries({ queryKey: keys.clearance(admissionId) });
  }

  const post = useMutation({
    mutationFn: () => runCharges({ admissionId, trigger: 'manual' }),
    onSuccess: invalidate,
  });
  const clear = useMutation({ mutationFn: () => clearDischarge(admissionId), onSuccess: invalidate });
  const override = useMutation({
    mutationFn: () => overrideClearance(admissionId, acknowledgement.trim(), overrideReason.trim()),
    onSuccess: () => {
      setAcknowledgement('');
      setOverrideReason('');
      invalidate();
    },
  });

  if (admissionId === '') {
    return (
      <section className="flex flex-col gap-6">
        // The header renders above the empty state rather than only alongside // data. These screens are in
        the registry, so they are reachable from the // navigation and the palette — and arriving from either
        produced an // untitled page that named neither the screen nor the hospital. Every // other screen
        draws its header first; these three did not, and a // 110-screen render sweep is what noticed.
        <PageHeader
          title="Inpatient bill"
          description="Room and per-day charges as they stand, derived from the occupancy timeline."
        />
        <EmptyState
          cause="No admission was named in the address."
          nextAction="Open one from the admitted list."
        />
      </section>
    );
  }

  const b = bill.data;
  const c = clearance.data;

  return (
    <section className="flex flex-col gap-6">
      <AsyncPanel
        loading={bill.isPending}
        error={bill.error}
        isEmpty={false}
        skeletonLabel="Loading the bill"
        skeletonRows={8}
        onRetry={() => {
          void bill.refetch();
        }}
        empty={null}
      >
        {b === undefined ? null : (
          <>
            <PageHeader
              title={`Bill — ${b.ipNo}`}
              description="Room and per-day charges as they stand, derived from the occupancy timeline."
            />

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Figure label="Room and per-day" value={b.roomTotal} />
              <Figure label="GST" value={b.gstTotal} />
              <Figure label="Total" value={b.grandTotal} emphasis />
              <Figure
                label={b.outstanding > 0 ? 'Outstanding' : 'In credit'}
                value={Math.abs(b.outstanding)}
                tone={b.outstanding > 0 ? 'danger' : 'success'}
              />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                disabled={post.isPending}
                onClick={() => {
                  post.mutate();
                }}
              >
                {post.isPending ? 'Posting…' : 'Post charges'}
              </Button>
              {post.data === undefined ? null : (
                <span className="text-2xs text-fg-subtle">
                  {`last run posted ${String(post.data.chargesPosted)}, skipped ${String(post.data.chargesSkipped)}, superseded ${String(post.data.chargesSuperseded)} — running it again changes nothing`}
                </span>
              )}
              <label className="flex min-h-12 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={showSuperseded}
                  onChange={(e) => {
                    setShowSuperseded(e.target.checked);
                  }}
                />
                Show corrected lines
              </label>
            </div>
            {post.error === null ? null : <ProblemCard error={post.error} />}

            <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
              <table className="w-full text-sm" data-testid="ip-bill">
                <caption className="sr-only">Inpatient charges</caption>
                <thead>
                  <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                    {['Date', 'Charge', 'Class', 'Units', 'Rate', 'Amount', 'GST', 'Basis'].map((h) => (
                      <th key={h} scope="col" className="px-3 py-2 text-start">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...b.charges, ...b.superseded].map((line) => (
                    <tr
                      key={line.id}
                      className={
                        line.supersededAt === null
                          ? 'border-b border-default last:border-0'
                          : 'border-b border-default text-fg-subtle line-through last:border-0'
                      }
                    >
                      <td className="px-3 py-2 font-mono text-2xs">{line.chargeDate}</td>
                      <td className="px-3 py-2 text-2xs">{line.chargeCode}</td>
                      <td className="px-3 py-2 font-mono text-2xs">{line.classCode ?? '—'}</td>
                      <td className="px-3 py-2 font-mono text-2xs">{line.units}</td>
                      <td className="px-3 py-2 font-mono text-2xs">{line.unitRate.toFixed(2)}</td>
                      <td className="px-3 py-2 font-mono text-2xs">{line.amount.toFixed(2)}</td>
                      <td className="px-3 py-2">
                        {line.isExempt ? (
                          <span className="text-2xs text-fg-subtle">exempt</span>
                        ) : (
                          <span className="font-mono text-2xs">{line.gstAmount.toFixed(2)}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-2xs text-fg-muted">
                        {line.supersededAt !== null
                          ? 'corrected by a later run'
                          : (line.exemptReason ?? `${line.policy.replace(/_/gu, ' ')}`)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </AsyncPanel>

      {/* ── The door ───────────────────────────────────────────────────────── */}
      {c === undefined ? null : (
        <div className="rounded-lg border border-strong bg-layer-1 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-fg-default">Discharge clearance</h2>
            <Badge tone={c.state === 'cleared' ? 'success' : c.state === 'blocked' ? 'danger' : 'warning'}>
              {c.state}
            </Badge>
          </div>

          <ul className="mt-3 flex flex-col gap-1">
            {c.checks.map((check) => (
              <li key={check.key} className="flex items-baseline gap-2 text-sm">
                <span className={check.state === 'blocked' ? 'text-fg-danger' : 'text-fg-success'}>
                  {check.state === 'blocked' ? '✗' : '✓'}
                </span>
                <span className="font-medium">{check.label}</span>
                <span className="text-2xs text-fg-muted">{check.detail ?? 'nothing outstanding'}</span>
              </li>
            ))}
          </ul>

          {clear.error === null ? null : <ProblemCard error={clear.error} />}
          {override.error === null ? null : <ProblemCard error={override.error} />}

          {c.overriddenAt === null ? (
            <>
              <div className="mt-3">
                <Button
                  type="button"
                  disabled={clear.isPending || c.state === 'cleared'}
                  onClick={() => {
                    clear.mutate();
                  }}
                >
                  {c.state === 'cleared' ? 'Cleared' : 'Clear for discharge'}
                </Button>
                <span className="ml-3 text-2xs text-fg-subtle">
                  Every check is recomputed before anything clears — clearing against a snapshot from a minute
                  ago is how somebody leaves over a test billed while they were putting their shoes on.
                </span>
              </div>

              {c.state === 'blocked' ? (
                <div className="mt-4 rounded-md border border-danger bg-danger-subtle p-3">
                  <p className="text-sm font-semibold text-fg-danger">Let them leave anyway</p>
                  <p className="mt-1 text-2xs text-fg-muted">
                    A patient who insists on leaving is leaving. The question is whether the hospital wrote
                    down that it knew.
                  </p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <div>
                      <Label htmlFor="ack">What the family were told</Label>
                      <input
                        id="ack"
                        className="h-10 w-full rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default"
                        value={acknowledgement}
                        placeholder="Family informed of the outstanding amount and the settlement route"
                        onChange={(e) => {
                          setAcknowledgement(e.target.value);
                        }}
                      />
                    </div>
                    <div>
                      <Label htmlFor="orsn">Your grounds</Label>
                      <input
                        id="orsn"
                        className="h-10 w-full rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default"
                        value={overrideReason}
                        placeholder="Transferring to a hospital nearer home; corporate desk to settle"
                        onChange={(e) => {
                          setOverrideReason(e.target.value);
                        }}
                      />
                    </div>
                  </div>
                  <div className="mt-2">
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={
                        override.isPending ||
                        acknowledgement.trim().length < 12 ||
                        overrideReason.trim().length < 12
                      }
                      onClick={() => {
                        override.mutate();
                      }}
                    >
                      Override the gate
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <p className="mt-3 rounded-md border border-warning bg-warning-subtle p-3 text-sm">
              Overridden. {c.overrideReason}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Figure({
  label,
  value,
  tone,
  emphasis,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone?: 'danger' | 'success';
  readonly emphasis?: boolean;
}): React.JSX.Element {
  const cls =
    tone === 'danger'
      ? 'text-fg-danger'
      : tone === 'success'
        ? 'text-fg-success'
        : emphasis === true
          ? 'text-fg-default'
          : 'text-fg-default';
  return (
    <div className="rounded-lg border border-strong bg-layer-1 p-4">
      <p className="text-2xs uppercase tracking-[0.08em] text-fg-subtle">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${cls}`}>{`₹${value.toFixed(2)}`}</p>
    </div>
  );
}
