'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { getAdmissions } from '../api/client';
import { ipKeys } from '../api/keys';
import type { AdmissionView } from '../api/types';

const STATUS_TONE: Readonly<Record<string, 'success' | 'danger' | 'warning' | 'info' | 'neutral'>> = {
  requested: 'warning',
  admitted: 'success',
  on_leave: 'info',
  discharge_initiated: 'info',
  discharged: 'neutral',
  cancelled: 'neutral',
  closed_other: 'neutral',
};

const selectClass = 'h-10 rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

/**
 * IP-001 — who is in.
 *
 * ── The entitlement flag is at admission, not at settlement ─────────────────
 *
 * In India a proportionate deduction applies to the *whole* bill when a patient
 * occupies a class above their cover, not just to the room line. Discovering
 * that at discharge is a conversation with a family who thought they were
 * insured; showing it on the list from day one is a conversation with the
 * insurance desk while it can still be changed.
 *
 * ── An incomplete registration is shown, never enforced ─────────────────────
 *
 * An ER fast-track patient is admitted and treated before the desk catches up.
 * The badge is a prompt to the desk, not a gate on care — there is no pay-first
 * or paperwork-first anywhere in this system.
 */
export function AdmissionsScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = ipKeys(hospitalId);

  const [status, setStatus] = useState('admitted');
  const [dueOnly, setDueOnly] = useState(false);

  const admissions = useQuery({
    queryKey: keys.admissions(`${status}|${String(dueOnly)}`),
    queryFn: ({ signal }) =>
      getAdmissions({ ...(status === '' ? {} : { status }), dueForDischarge: dueOnly }, { signal }),
  });

  const rows: readonly AdmissionView[] = admissions.data?.items ?? [];
  const overEntitled = rows.filter((a) => a.aboveEntitlement).length;
  const unregistered = rows.filter((a) => !a.registrationComplete).length;

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Admissions"
        description="Who is in, who is waiting for a bed, and who is expected out — with the class mismatches flagged while they can still be changed."
      />

      <div className="flex flex-wrap items-center gap-3">
        {overEntitled > 0 ? (
          <Badge tone="warning">
            {`${String(overEntitled)} in a class above their cover — a proportionate deduction applies to the whole bill`}
          </Badge>
        ) : null}
        {unregistered > 0 ? (
          <Badge tone="info">{`${String(unregistered)} registration(s) still to complete`}</Badge>
        ) : null}
        <div className="flex flex-col gap-1">
          <label className="text-2xs uppercase tracking-[0.08em] text-fg-subtle" htmlFor="adm-status">
            Status
          </label>
          <select
            id="adm-status"
            className={selectClass}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
            }}
          >
            <option value="">All</option>
            {['requested', 'admitted', 'on_leave', 'discharge_initiated', 'discharged'].map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/gu, ' ')}
              </option>
            ))}
          </select>
        </div>
        <label className="flex min-h-12 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={dueOnly}
            onChange={(e) => {
              setDueOnly(e.target.checked);
            }}
          />
          Only those expected out today or overdue
        </label>
      </div>

      <AsyncPanel
        loading={admissions.isPending}
        error={admissions.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading the admitted list"
        skeletonRows={8}
        onRetry={() => {
          void admissions.refetch();
        }}
        empty={
          <EmptyState
            cause="Nobody matches this filter."
            nextAction="Clear it, or admit a patient from the emergency floor or the clinic."
          />
        }
      >
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm" data-testid="admissions">
            <caption className="sr-only">Admissions</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {['IP number', 'Kind', 'State', 'Bed', 'Class', 'Stay', 'Expected out', 'Deposit'].map(
                  (h) => (
                    <th key={h} scope="col" className="px-3 py-2 text-start">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="border-b border-default last:border-0" data-testid={`adm-${a.id}`}>
                  <td className="px-3 py-2">
                    <span className="font-mono text-2xs">{a.ipNo}</span>
                    {a.registrationComplete ? null : (
                      <div className="mt-1">
                        <Badge tone="info">registration incomplete</Badge>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-2xs">{a.kind.replace(/_/gu, ' ')}</td>
                  <td className="px-3 py-2">
                    <Badge tone={STATUS_TONE[a.status] ?? 'neutral'}>{a.status.replace(/_/gu, ' ')}</Badge>
                  </td>
                  <td className="px-3 py-2 font-mono text-2xs">
                    {a.bedCode ?? '—'}
                    {a.wardName === null ? null : <div className="text-fg-subtle">{a.wardName}</div>}
                  </td>
                  <td className="px-3 py-2">
                    {a.classCode === null ? (
                      <span className="text-2xs text-fg-subtle">—</span>
                    ) : a.aboveEntitlement ? (
                      <Badge tone="warning">{`${a.classCode} · above cover`}</Badge>
                    ) : (
                      <span className="font-mono text-2xs">{a.classCode}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-2xs">
                    {a.lengthOfStayHours === null ? '—' : describeStay(a.lengthOfStayHours)}
                  </td>
                  <td className="px-3 py-2 font-mono text-2xs">
                    {a.expectedDischargeAt === null ? (
                      <span className="text-fg-subtle">not set</span>
                    ) : (
                      a.expectedDischargeAt.slice(0, 10)
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-2xs">
                    {a.depositSuggested !== null && a.depositTaken < a.depositSuggested ? (
                      <Badge tone="warning">{`₹${a.depositTaken.toFixed(0)} of ₹${a.depositSuggested.toFixed(0)}`}</Badge>
                    ) : (
                      `₹${a.depositTaken.toFixed(0)}`
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      <p className="text-2xs text-fg-subtle">
        A short deposit and an incomplete registration are both shown and neither is a barrier. There is no
        pay-first gate anywhere in this system, and an emergency patient is treated before the paperwork
        catches up.
      </p>
    </section>
  );
}

function describeStay(hours: number): string {
  if (hours < 48) return `${String(hours)} h`;
  return `${String(Math.round(hours / 24))} d`;
}
