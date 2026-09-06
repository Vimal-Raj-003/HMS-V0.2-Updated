'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { formatInstant, formatMoney, humanise } from '@/features/pharmacy/lib/format';
import { decideVariance, listPackages, listVariances } from '../api/client';
import { rcmKeys } from '../api/keys';
import type { PackageView, VarianceRequestView } from '../api/types';

/**
 * OP-023 — packages.
 *
 * ── The screen leads with the overruns, not the catalogue ───────────────────
 *
 * A package catalogue is reference data somebody edits twice a year. What needs
 * a decision *today* is the set of charges that went past a cap and are sitting
 * off the patient's bill waiting for somebody to say who pays. §5.4 requires
 * that approval before the excess is billed, so an unattended queue here means
 * either a family is about to be surprised at discharge or the hospital is
 * quietly absorbing money it should have claimed.
 *
 * ── The three answers are shown as three buttons, not a dropdown ────────────
 *
 * "Bill the patient", "bill the insurer" and "the hospital absorbs it" are
 * materially different decisions with different consequences, and a select
 * defaulting to the first would make the most expensive one the easiest to pick
 * by accident. Each is its own control, and each needs a reason.
 */
export function PackagesScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = rcmKeys(hospitalId);
  const { publish } = useToast();

  const [tab, setTab] = useState<'variances' | 'catalogue'>('variances');
  const [openId, setOpenId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const canDecide = granted.has('pkg.variance.approve');
  const canSeeCatalogue = granted.has('pkg.list');

  const variances = useQuery({
    queryKey: keys.variances('all'),
    queryFn: ({ signal }) => listVariances({}, { signal }),
    enabled: tab === 'variances',
  });

  const packages = useQuery({
    queryKey: keys.packages('active'),
    queryFn: ({ signal }) => listPackages({ status: 'active' }, { signal }),
    enabled: tab === 'catalogue' && canSeeCatalogue,
  });

  const decide = useMutation({
    mutationFn: (input: {
      readonly id: string;
      readonly billAction: 'bill_patient' | 'bill_insurer' | 'absorb';
    }) =>
      decideVariance(input.id, {
        decision: 'approved',
        billAction: input.billAction,
        reason,
      }),
    onSuccess: () => {
      void variances.refetch();
      setOpenId(null);
      setReason('');
      publish({ title: 'Variance decided', severity: 'success' });
    },
  });

  const vRows = variances.data?.items ?? [];
  const pending = vRows.filter((v: VarianceRequestView) => v.status === 'pending');
  const pkgRows = packages.data?.items ?? [];

  return (
    <section className="flex flex-col gap-4" data-testid="packages-screen">
      <PageHeader
        eyebrow="OP-023 · packages"
        title="Packages"
        description="Fixed-price promises, and every charge that went past one. An overrun waits here for a decision — it is never billed to a family who was quoted a package price."
      />

      <nav aria-label="Package views" className="flex flex-wrap gap-1 border-b border-default">
        {(
          [
            {
              key: 'variances',
              label: `Overruns${pending.length > 0 ? ` (${String(pending.length)})` : ''}`,
            },
            { key: 'catalogue', label: 'Catalogue' },
          ] as const
        ).map((entry) => (
          <button
            key={entry.key}
            type="button"
            data-testid={`packages-tab-${entry.key}`}
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

      {tab === 'variances' ? (
        <AsyncPanel
          loading={variances.isPending}
          error={variances.error}
          isEmpty={vRows.length === 0}
          skeletonLabel="Loading package overruns"
          skeletonRows={6}
          onRetry={() => {
            void variances.refetch();
          }}
          empty={
            <EmptyState
              cause="No charge has gone past a package cap."
              nextAction="Every package in flight is being delivered inside what was quoted. Nothing needs a decision."
            />
          }
        >
          <div className="flex flex-col gap-3">
            <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
              <table className="w-full text-sm" data-testid="variance-list">
                <caption className="sr-only">Charges beyond a package cap</caption>
                <thead>
                  <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                    <th scope="col" className="px-3 py-2 text-start">
                      Why it went over
                    </th>
                    <th scope="col" className="px-3 py-2 text-end">
                      Amount
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Status
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Who pays
                    </th>
                    <th scope="col" className="px-3 py-2 text-start">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {vRows.map((row: VarianceRequestView) => (
                    <tr key={row.id} className="border-b border-default last:border-0">
                      <td className="px-3 py-2">
                        {humanise(row.reasonCode)}
                        {row.justification === null ? null : (
                          <p className="mt-1 text-2xs text-fg-muted">{row.justification}</p>
                        )}
                      </td>
                      <td className="px-3 py-2 text-end font-mono">{formatMoney(row.amount)}</td>
                      <td className="px-3 py-2">
                        <Badge tone={row.status === 'pending' ? 'warning' : 'success'}>
                          {humanise(row.status)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-2xs">
                        {row.billAction === null ? (
                          <span className="text-fg-muted">not yet decided</span>
                        ) : (
                          humanise(row.billAction)
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {row.status === 'pending' && canDecide ? (
                          <Button
                            variant="ghost"
                            data-testid={`open-variance-${row.id}`}
                            onClick={() => {
                              setOpenId(row.id === openId ? null : row.id);
                              setReason('');
                            }}
                          >
                            {row.id === openId ? 'Close' : 'Decide'}
                          </Button>
                        ) : null}
                        {row.status === 'pending' && !canDecide ? (
                          <span className="text-2xs text-fg-subtle">
                            needs <code>pkg.variance.approve</code>
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-2xs text-fg-subtle">
              A pending overrun is <strong>not on the patient&rsquo;s bill</strong>. It stays here until
              somebody decides who pays, which is what stops a family being surprised at discharge by a charge
              beyond the price they were quoted.
            </p>

            {decide.error === null ? null : <ProblemCard error={decide.error} />}

            {openId === null ? null : (
              <div
                className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
                data-testid="decide-variance"
              >
                <div className="flex min-w-72 flex-col gap-1">
                  <Label htmlFor="variance-reason">Why this decision?</Label>
                  <Input
                    id="variance-reason"
                    data-testid="variance-reason"
                    value={reason}
                    autoComplete="off"
                    onChange={(event) => {
                      setReason(event.target.value);
                    }}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    data-testid="bill-patient"
                    disabled={reason.trim() === '' || decide.isPending}
                    onClick={() => {
                      decide.mutate({ id: openId, billAction: 'bill_patient' });
                    }}
                  >
                    Bill the patient
                  </Button>
                  <Button
                    variant="secondary"
                    data-testid="bill-insurer"
                    disabled={reason.trim() === '' || decide.isPending}
                    onClick={() => {
                      decide.mutate({ id: openId, billAction: 'bill_insurer' });
                    }}
                  >
                    Bill the insurer
                  </Button>
                  <Button
                    variant="secondary"
                    data-testid="absorb"
                    disabled={reason.trim() === '' || decide.isPending}
                    onClick={() => {
                      decide.mutate({ id: openId, billAction: 'absorb' });
                    }}
                  >
                    The hospital absorbs it
                  </Button>
                </div>
                <p className="text-2xs text-fg-subtle">
                  Three separate buttons rather than a dropdown: these are materially different decisions, and
                  a default would make the most expensive one the easiest to pick by accident.
                </p>
              </div>
            )}
          </div>
        </AsyncPanel>
      ) : null}

      {tab === 'catalogue' && !canSeeCatalogue ? (
        <EmptyState
          cause="You cannot read the package catalogue."
          nextAction="pkg.list is held by the billing desk and finance."
        />
      ) : null}

      {tab === 'catalogue' && canSeeCatalogue ? (
        <AsyncPanel
          loading={packages.isPending}
          error={packages.error}
          isEmpty={pkgRows.length === 0}
          skeletonLabel="Loading packages"
          skeletonRows={6}
          onRetry={() => {
            void packages.refetch();
          }}
          empty={
            <EmptyState
              cause="No active packages."
              nextAction="A package prices nothing until a version is published with an effective date."
            />
          }
        >
          <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
            <table className="w-full text-sm" data-testid="package-list">
              <caption className="sr-only">Active packages</caption>
              <thead>
                <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  <th scope="col" className="px-3 py-2 text-start">
                    Package
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    Kind
                  </th>
                  <th scope="col" className="px-3 py-2 text-end">
                    Price
                  </th>
                  <th scope="col" className="px-3 py-2 text-end">
                    Valid for
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    Public
                  </th>
                </tr>
              </thead>
              <tbody>
                {pkgRows.map((row: PackageView) => (
                  <tr key={row.id} className="border-b border-default last:border-0">
                    <td className="px-3 py-2">
                      <span className="font-mono text-2xs text-fg-muted">{row.code}</span>
                      <span className="ms-2">{row.name}</span>
                      <span className="ms-2 text-2xs text-fg-subtle">v{row.currentVersion}</span>
                    </td>
                    <td className="px-3 py-2">{humanise(row.kind)}</td>
                    <td className="px-3 py-2 text-end font-mono">
                      {row.livePrice === null ? (
                        <span className="text-fg-muted">not priced</span>
                      ) : (
                        formatMoney(row.livePrice)
                      )}
                    </td>
                    <td className="px-3 py-2 text-end font-mono text-2xs">{row.validityDays} d</td>
                    <td className="px-3 py-2 text-2xs">
                      {row.isPublic ? <Badge tone="neutral">on the rate card</Badge> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AsyncPanel>
      ) : null}

      {vRows.length === 0 ? null : (
        <p className="text-2xs text-fg-subtle">Last read {formatInstant(new Date().toISOString())}.</p>
      )}
    </section>
  );
}
