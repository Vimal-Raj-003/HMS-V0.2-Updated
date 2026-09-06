'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label } from '@vims/ui';
import { useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { formatInstant, humanise } from '@/features/pharmacy/lib/format';
import { listMissingRates, resolveMissingRate } from '../api/client';
import { rcmKeys } from '../api/keys';
import type { MissingRateRow } from '../api/types';

/**
 * RC-003 — the missing-rate worklist.
 *
 * ── Why this screen exists at all ───────────────────────────────────────────
 *
 * `phase-05 §Constraints`: "A blocked rate (`MISSING_RATE`) stops the bill and
 * raises a task — silence here becomes revenue leakage." Every row is a service
 * that was delivered and could not be priced. Nothing was billed at zero; the
 * line was held. That distinction is the whole point, and the heading says so
 * rather than leaving it to be inferred from an empty amount column.
 *
 * ── Two ways to close a row, and they are not the same ──────────────────────
 *
 * **Priced** means somebody added the rate and the service will bill from now
 * on. **Waived** means the hospital has decided this service is genuinely free.
 * Both need a reason, because a year later the difference between "we fixed it"
 * and "we decided not to charge" is the difference between a recovered amount
 * and a policy.
 */
export function MissingRatesScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = rcmKeys(hospitalId);
  const { publish } = useToast();

  const [status, setStatus] = useState('open');
  const [openId, setOpenId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const canResolve = granted.has('tariff.missing.resolve');

  const rows = useQuery({
    queryKey: keys.missingRates(status),
    queryFn: ({ signal }) => listMissingRates({ status }, { signal }),
  });

  const close = useMutation({
    mutationFn: (input: { readonly id: string; readonly action: 'priced' | 'waived' }) =>
      resolveMissingRate(input.id, { action: input.action, reason }),
    onSuccess: () => {
      void rows.refetch();
      setOpenId(null);
      setReason('');
      publish({ title: 'Entry closed', severity: 'success' });
    },
  });

  const items = rows.data?.items ?? [];

  return (
    <section className="flex flex-col gap-4" data-testid="missing-rates-screen">
      <PageHeader
        eyebrow="RC-003 · missing rates"
        title="Missing rates"
        description="Services that were delivered and could not be priced. Every one of these held a bill line — none of them was billed at zero."
      />

      <div className="flex min-w-56 max-w-xs flex-col gap-1">
        <Label htmlFor="missing-status">Status</Label>
        <select
          id="missing-status"
          data-testid="missing-status"
          className="h-9 rounded-md border border-control bg-layer-1 px-2 text-sm"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
          }}
        >
          <option value="open">Open</option>
          <option value="priced">Priced</option>
          <option value="waived">Waived</option>
        </select>
      </div>

      <AsyncPanel
        loading={rows.isPending}
        error={rows.error}
        isEmpty={items.length === 0}
        skeletonLabel="Loading the missing-rate worklist"
        skeletonRows={6}
        onRetry={() => {
          void rows.refetch();
        }}
        empty={
          <EmptyState
            cause="Nothing is unpriced."
            nextAction="Every service billed so far resolved to a rate. This is the answer you want here."
          />
        }
      >
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm">
            <caption className="sr-only">Services that could not be priced</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                <th scope="col" className="px-3 py-2 text-start">
                  Service
                </th>
                <th scope="col" className="px-3 py-2 text-end">
                  Times held
                </th>
                <th scope="col" className="px-3 py-2 text-start">
                  First seen
                </th>
                <th scope="col" className="px-3 py-2 text-start">
                  Last seen
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
              {items.map((row: MissingRateRow) => (
                <tr key={row.id} className="border-b border-default last:border-0">
                  <td className="px-3 py-2">
                    <span className="font-mono text-2xs text-fg-muted">{row.serviceCode ?? '—'}</span>
                    <span className="ms-2">{row.serviceName ?? 'Unknown service'}</span>
                  </td>
                  <td className="px-3 py-2 text-end font-mono">{row.occurrences}</td>
                  <td className="px-3 py-2 text-2xs">{formatInstant(row.firstSeenAt)}</td>
                  <td className="px-3 py-2 text-2xs">{formatInstant(row.lastSeenAt)}</td>
                  <td className="px-3 py-2">
                    <Badge tone={row.status === 'open' ? 'warning' : 'neutral'}>{humanise(row.status)}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    {row.status === 'open' && canResolve ? (
                      <Button
                        variant="ghost"
                        data-testid={`open-missing-${row.id}`}
                        onClick={() => {
                          setOpenId(row.id === openId ? null : row.id);
                          setReason('');
                        }}
                      >
                        {row.id === openId ? 'Close' : 'Resolve'}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      {close.error === null ? null : <ProblemCard error={close.error} />}

      {openId === null ? null : (
        <div
          className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
          data-testid="resolve-missing"
        >
          <p className="text-sm text-fg-muted">
            <strong>Priced</strong> means the rate now exists and the service will bill.{' '}
            <strong>Waived</strong> means the hospital has decided it is free. A year from now the difference
            between those two is the difference between a recovered amount and a policy, so both need a
            reason.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-72 flex-1 flex-col gap-1">
              <Label htmlFor="missing-reason">Reason</Label>
              <Input
                id="missing-reason"
                data-testid="missing-reason"
                value={reason}
                autoComplete="off"
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            </div>
            <Button
              data-testid="mark-priced"
              disabled={reason.trim() === '' || close.isPending}
              onClick={() => {
                close.mutate({ id: openId, action: 'priced' });
              }}
            >
              Priced
            </Button>
            <Button
              variant="secondary"
              data-testid="mark-waived"
              disabled={reason.trim() === '' || close.isPending}
              onClick={() => {
                close.mutate({ id: openId, action: 'waived' });
              }}
            >
              Waived
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
