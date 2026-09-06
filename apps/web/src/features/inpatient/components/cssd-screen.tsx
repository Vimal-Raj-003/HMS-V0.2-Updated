'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Label } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { getCssdLoads, recallLoad, recordIndicators, releaseLoad } from '../api/client';
import { ipKeys } from '../api/keys';
import type { CssdLoadRow, RecallResult } from '../api/types';

const STATE_TONE: Readonly<Record<string, 'success' | 'danger' | 'warning' | 'info' | 'neutral'>> = {
  sterilising: 'info',
  quarantined: 'warning',
  released: 'success',
  failed: 'danger',
  recalled: 'danger',
};

const inputClass = 'h-10 w-full rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

/**
 * EN-003 — sterile supply.
 *
 * ── Three indicators, and only one of them proves anything ──────────────────
 *
 * Bowie-Dick tests the vacuum. The chemical strip says the pack was exposed to
 * steam. Only the biological indicator says the spores died, and it takes hours
 * to read — which is why a load waits in quarantine and why the release button
 * is disabled until it says pass. The server refuses regardless.
 *
 * ── The recall names patients, so it takes a reason ─────────────────────────
 *
 * A failed load produces a list of the sets issued from it and the patients
 * those sets touched. That list is what somebody needs at 6 a.m. and cannot
 * reconstruct from paper.
 */
export function CssdScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = ipKeys(hospitalId);
  const queryClient = useQueryClient();

  const [reason, setReason] = useState('');
  const [recalled, setRecalled] = useState<RecallResult | null>(null);

  const loads = useQuery({
    queryKey: keys.cssdLoads('all'),
    queryFn: ({ signal }) => getCssdLoads({}, { signal }),
    refetchInterval: 120_000,
  });

  function invalidate(): void {
    void queryClient.invalidateQueries({ queryKey: keys.cssdLoadsRoot() });
  }

  const indicator = useMutation({
    mutationFn: (input: { readonly id: string; readonly result: 'pass' | 'fail' }) =>
      recordIndicators(input.id, { biologicalIndicator: input.result }),
    onSuccess: invalidate,
  });
  const release = useMutation({ mutationFn: (id: string) => releaseLoad(id), onSuccess: invalidate });
  const recall = useMutation({
    mutationFn: (id: string) => recallLoad(id, reason.trim()),
    onSuccess: (result) => {
      setRecalled(result);
      setReason('');
      invalidate();
    },
  });

  const rows: readonly CssdLoadRow[] = loads.data?.items ?? [];
  const failed = rows.filter((l) => l.biologicalIndicator === 'fail' && l.recalledAt === null).length;

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Sterile supply"
        description="Loads through the cycle, their indicators, and the recall a failed biological indicator demands."
      />

      {failed > 0 ? (
        <Badge tone="danger">
          {`${String(failed)} load(s) failed their biological indicator and have not been recalled`}
        </Badge>
      ) : (
        <Badge tone="success">no failed load outstanding</Badge>
      )}

      {indicator.error === null ? null : <ProblemCard error={indicator.error} />}
      {release.error === null ? null : <ProblemCard error={release.error} />}
      {recall.error === null ? null : <ProblemCard error={recall.error} />}

      <AsyncPanel
        loading={loads.isPending}
        error={loads.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading the sterilisation records"
        skeletonRows={5}
        onRetry={() => {
          void loads.refetch();
        }}
        empty={
          <EmptyState
            cause="No sterilisation load has been recorded."
            nextAction="Start one when the next cycle goes into the autoclave."
          />
        }
      >
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm" data-testid="cssd-loads">
            <caption className="sr-only">Sterilisation loads</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {['Load', 'Autoclave', 'State', 'Bowie-Dick', 'Chemical', 'Biological', 'Sets', ''].map(
                  (h) => (
                    <th key={h} scope="col" className="px-3 py-2 text-start">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id} className="border-b border-default last:border-0" data-testid={`load-${l.id}`}>
                  <td className="px-3 py-2 font-mono text-2xs">{l.loadNo}</td>
                  <td className="px-3 py-2 font-mono text-2xs">{l.autoclaveId}</td>
                  <td className="px-3 py-2">
                    <Badge tone={STATE_TONE[l.state] ?? 'neutral'}>{l.state}</Badge>
                  </td>
                  <td className="px-3 py-2 text-2xs">{l.bowieDick ?? '—'}</td>
                  <td className="px-3 py-2 text-2xs">{l.chemicalIndicator ?? '—'}</td>
                  <td className="px-3 py-2">
                    <Badge
                      tone={
                        l.biologicalIndicator === 'pass'
                          ? 'success'
                          : l.biologicalIndicator === 'fail'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {l.biologicalIndicator}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-2xs">
                    {l.setsInLoad} in load, {l.setsIssued} issued
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {l.biologicalIndicator === 'pending' ? (
                        <>
                          <Button
                            type="button"
                            variant="secondary"
                            disabled={indicator.isPending}
                            onClick={() => {
                              indicator.mutate({ id: l.id, result: 'pass' });
                            }}
                          >
                            BI pass
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            disabled={indicator.isPending}
                            onClick={() => {
                              indicator.mutate({ id: l.id, result: 'fail' });
                            }}
                          >
                            BI fail
                          </Button>
                        </>
                      ) : null}
                      {l.biologicalIndicator === 'pass' && l.releasedAt === null ? (
                        <Button
                          type="button"
                          disabled={release.isPending}
                          onClick={() => {
                            release.mutate(l.id);
                          }}
                        >
                          Release
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      {/* ── The recall ─────────────────────────────────────────────────────── */}
      {rows.some((l) => l.biologicalIndicator === 'fail' && l.recalledAt === null) ? (
        <div className="rounded-lg border border-danger bg-danger-subtle p-4">
          <h2 className="text-sm font-semibold text-fg-danger">Recall a failed load</h2>
          <p className="mt-1 text-2xs text-fg-muted">
            Every set issued from the load, and every patient those sets touched. Running it is recorded with
            your name and your reason.
          </p>
          <div className="mt-2">
            <Label htmlFor="cssd-reason">Why you are recalling it</Label>
            <input
              id="cssd-reason"
              className={inputClass}
              value={reason}
              placeholder="Biological indicator failed at the 24-hour re-read"
              onChange={(e) => {
                setReason(e.target.value);
              }}
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {rows
              .filter((l) => l.biologicalIndicator === 'fail' && l.recalledAt === null)
              .map((l) => (
                <Button
                  key={l.id}
                  type="button"
                  disabled={recall.isPending || reason.trim().length < 12}
                  onClick={() => {
                    recall.mutate(l.id);
                  }}
                >
                  {`Recall ${l.loadNo}`}
                </Button>
              ))}
          </div>
        </div>
      ) : null}

      {recalled === null ? null : (
        <div className="rounded-lg border border-strong bg-layer-1 p-4">
          <h2 className="text-sm font-semibold text-fg-default">{`${recalled.loadNo} — recalled`}</h2>
          <p className="mt-1 text-sm">
            {`${String(recalled.setsRecalled)} set(s), ${String(recalled.casesAffected)} case(s), `}
            <span className="font-semibold text-fg-danger">
              {`${String(recalled.patientsAffected)} patient(s) to review`}
            </span>
          </p>
          <div className="mt-3 overflow-x-auto rounded-md border border-default">
            <table className="w-full text-sm" data-testid="cssd-recall">
              <caption className="sr-only">Recalled sets and the cases they touched</caption>
              <thead>
                <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  {['Set', 'Issued', 'Case', 'Procedure', 'Returned'].map((h) => (
                    <th key={h} scope="col" className="px-3 py-2 text-start">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recalled.rows.map((r) => (
                  <tr key={r.issueId} className="border-b border-default last:border-0">
                    <td className="px-3 py-2 font-mono text-2xs">{r.setCode}</td>
                    <td className="px-3 py-2 font-mono text-2xs">
                      {r.issuedAt.slice(0, 16).replace('T', ' ')}
                    </td>
                    <td className="px-3 py-2 font-mono text-2xs">{r.caseNo ?? '—'}</td>
                    <td className="px-3 py-2 text-2xs">{r.procedure ?? '—'}</td>
                    <td className="px-3 py-2 text-2xs">
                      {r.returnedAt === null ? (
                        <Badge tone="warning">still out</Badge>
                      ) : (
                        r.returnedAt.slice(0, 10)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
