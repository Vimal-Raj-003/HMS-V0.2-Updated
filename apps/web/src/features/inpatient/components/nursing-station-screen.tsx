'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState } from '@vims/ui';
import Link from 'next/link';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { acknowledgeEscalation, getCensus, getEscalations, getWard } from '../api/client';
import { ipKeys } from '../api/keys';
import type { EscalationRow, WardPatientRow } from '../api/types';

const NEWS2_TONE: Readonly<Record<string, 'danger' | 'warning' | 'info' | 'success'>> = {
  high: 'danger',
  medium: 'warning',
  low_medium: 'warning',
  low: 'success',
};

const RISK_TONE: Readonly<Record<string, 'danger' | 'warning' | 'success' | 'neutral'>> = {
  very_high: 'danger',
  high: 'danger',
  moderate: 'warning',
  low: 'success',
};

const selectClass = 'h-10 rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

/**
 * IP-003 — the ward screen.
 *
 * ── Sorted by who is deteriorating, not by bed number ───────────────────────
 *
 * An open escalation first, then the highest NEWS2, then overdue doses. A ward
 * list in bed order is a list where the sick patient is wherever the sick
 * patient happens to sleep, and the nurse reading it at the start of a shift is
 * looking for exactly the opposite.
 *
 * ── Overdue is minutes, everywhere ──────────────────────────────────────────
 *
 * "Vitals 4 h ago" and "3 doses 40 min late" are things somebody can act on.
 * "Last vitals 06:00" makes them do arithmetic against a clock they are not
 * looking at, at the moment they are least able to.
 */
export function NursingStationScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = ipKeys(hospitalId);
  const queryClient = useQueryClient();
  const [wardId, setWardId] = useState('');

  const census = useQuery({ queryKey: keys.census(), queryFn: ({ signal }) => getCensus({ signal }) });

  const ward = useQuery({
    queryKey: keys.ward(wardId === '' ? 'all' : wardId),
    queryFn: ({ signal }) => getWard(wardId === '' ? {} : { wardId }, { signal }),
    // A patient deteriorates while the tab sits open. That is the thing this
    // screen exists to notice, so it notices on its own.
    refetchInterval: 30_000,
  });

  const escalations = useQuery({
    queryKey: keys.escalations(wardId === '' ? 'all' : wardId),
    queryFn: ({ signal }) =>
      getEscalations({ ...(wardId === '' ? {} : { wardId }), openOnly: true }, { signal }),
    refetchInterval: 30_000,
  });

  const ack = useMutation({
    mutationFn: (id: string) => acknowledgeEscalation(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.escalationsRoot() });
      void queryClient.invalidateQueries({ queryKey: keys.wardRoot() });
    },
  });

  const rows: readonly WardPatientRow[] = ward.data?.items ?? [];
  const open: readonly EscalationRow[] = escalations.data?.items ?? [];
  const overdueEscalations = open.filter((e) => e.overdue).length;

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Nursing station"
        description="Every patient on the ward, ordered by who needs looking at — not by bed number."
      />

      <div className="flex flex-wrap items-center gap-3">
        {open.length > 0 ? (
          <Badge tone="danger">
            {`${String(open.length)} escalation(s) running${overdueEscalations > 0 ? `, ${String(overdueEscalations)} past their rung` : ''}`}
          </Badge>
        ) : (
          <Badge tone="success">no escalation running</Badge>
        )}
        <div className="flex flex-col gap-1">
          <label className="text-2xs uppercase tracking-[0.08em] text-fg-subtle" htmlFor="ns-ward">
            Ward
          </label>
          <select
            id="ns-ward"
            className={selectClass}
            value={wardId}
            onChange={(e) => {
              setWardId(e.target.value);
            }}
          >
            <option value="">Every ward</option>
            {(census.data ?? []).map((w) => (
              <option key={w.wardId} value={w.wardId}>
                {w.wardName}
              </option>
            ))}
          </select>
        </div>
        <Link href="/ip/mar" className="text-sm text-fg-link underline-offset-2 hover:underline">
          Go to the drug round →
        </Link>
      </div>

      {ack.error === null ? null : <ProblemCard error={ack.error} />}

      {/* ── Escalations, above the ward list ──────────────────────────────── */}
      {open.length === 0 ? null : (
        <div className="rounded-lg border border-danger bg-danger-subtle p-4">
          <h2 className="text-sm font-semibold text-fg-danger">Deteriorating</h2>
          <p className="mt-1 text-2xs text-fg-muted">
            The ladder climbs on the server, on its own clock. Closing this tab does not stop it.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {open.map((e) => (
              <li
                key={e.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-default bg-layer-1 p-3"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-2xs">{e.bedCode ?? e.ipNo}</span>
                    <Badge tone={NEWS2_TONE[e.band] ?? 'warning'}>{`NEWS2 ${String(e.score)}`}</Badge>
                    <Badge tone="danger">{e.rung.replace(/_/gu, ' ')}</Badge>
                    {e.overdue ? <Badge tone="danger">rung overdue</Badge> : null}
                  </div>
                  <p className="mt-1 text-2xs text-fg-muted">
                    {`Unanswered for ${String(e.minutesUnanswered)} min`}
                    {e.acknowledgedAt === null ? '' : ' · acknowledged'}
                  </p>
                </div>
                {e.acknowledgedAt === null ? (
                  <Button
                    type="button"
                    disabled={ack.isPending}
                    onClick={() => {
                      ack.mutate(e.id);
                    }}
                  >
                    Acknowledge
                  </Button>
                ) : (
                  <span className="text-2xs text-fg-subtle">answered — close it with what you did</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <AsyncPanel
        loading={ward.isPending}
        error={ward.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading the ward"
        skeletonRows={10}
        onRetry={() => {
          void ward.refetch();
        }}
        empty={
          <EmptyState
            cause="No patient is admitted on this ward."
            nextAction="Admit somebody from the emergency floor or the clinic."
          />
        }
      >
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm" data-testid="nursing-station">
            <caption className="sr-only">Ward patients</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {['Bed', 'NEWS2', 'Vitals', 'Doses', 'Assessments', 'Risks', 'Devices', 'Isolation'].map(
                  (h) => (
                    <th key={h} scope="col" className="px-3 py-2 text-start">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.admissionId}
                  className="border-b border-default last:border-0"
                  data-testid={`ward-${r.admissionId}`}
                >
                  <td className="px-3 py-2">
                    <span className="font-mono text-2xs font-semibold">{r.bedCode ?? '—'}</span>
                    <div className="font-mono text-2xs text-fg-subtle">{r.ipNo}</div>
                  </td>
                  <td className="px-3 py-2">
                    {r.news2Score === null ? (
                      <span className="text-2xs text-fg-subtle">not scored</span>
                    ) : (
                      <Badge tone={NEWS2_TONE[r.news2Band ?? ''] ?? 'neutral'}>{r.news2Score}</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-2xs">
                    {r.vitalsOverdueMinutes === null ? (
                      <span className="text-fg-subtle">none recorded</span>
                    ) : (
                      describeAgo(r.vitalsOverdueMinutes)
                    )}
                  </td>
                  <td className="px-3 py-2 text-2xs">
                    {r.dosesOverdue > 0 ? (
                      <Badge tone="danger">{`${String(r.dosesOverdue)} late`}</Badge>
                    ) : r.dosesDue > 0 ? (
                      <span>{`${String(r.dosesDue)} due`}</span>
                    ) : (
                      <span className="text-fg-subtle">none due</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-2xs">
                    {r.assessmentsOverdue > 0 ? (
                      <Badge tone="warning">{`${String(r.assessmentsOverdue)} overdue`}</Badge>
                    ) : (
                      <span className="text-fg-subtle">up to date</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {r.fallsBand === null ? null : (
                        <Badge tone={RISK_TONE[r.fallsBand] ?? 'neutral'}>{`falls ${r.fallsBand}`}</Badge>
                      )}
                      {r.pressureBand === null ? null : (
                        <Badge tone={RISK_TONE[r.pressureBand] ?? 'neutral'}>
                          {`pressure ${r.pressureBand}`}
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-2xs text-fg-muted">
                    {r.devices.length === 0 ? '—' : r.devices.map((d) => d.replace(/_/gu, ' ')).join(', ')}
                  </td>
                  <td className="px-3 py-2">
                    {r.isolation.length === 0 ? (
                      <span className="text-2xs text-fg-subtle">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {r.isolation.map((i) => (
                          <Badge key={i} tone="warning">
                            {i}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>
    </section>
  );
}

function describeAgo(minutes: number): string {
  if (minutes < 90) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)} h ago`;
  return `${String(Math.round(hours / 24))} d ago`;
}
