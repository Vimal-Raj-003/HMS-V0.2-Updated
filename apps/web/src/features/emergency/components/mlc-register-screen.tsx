'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState, Label } from '@vims/ui';
import Link from 'next/link';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { erKeys } from '../api/keys';
import { getRegister, getWorklist } from '../api/mlc-client';
import type { MlcCaseView, MlcWorklistRow } from '../api/mlc-types';

const CATEGORY_LABEL: Readonly<Record<string, string>> = {
  rta: 'Road traffic accident',
  assault: 'Assault',
  burns: 'Burns',
  poisoning: 'Poisoning',
  fall_from_height: 'Fall from height',
  industrial: 'Industrial',
  animal_attack: 'Animal attack',
  firearm: 'Firearm',
  sexual_assault: 'Sexual assault',
  self_harm: 'Self-harm',
  dowry_related: 'Dowry-related',
  custodial: 'Custodial',
  unknown_unconscious: 'Unknown / unconscious',
  brought_dead: 'Brought dead',
  drowning: 'Drowning',
  electrocution: 'Electrocution',
  snake_bite: 'Snake bite',
  other: 'Other',
};

const STATUS_TONE: Readonly<Record<string, 'warning' | 'success' | 'neutral' | 'danger'>> = {
  open: 'warning',
  report_pending: 'warning',
  report_final: 'success',
  closed: 'neutral',
  cancelled: 'danger',
};

const WORKLISTS = [
  { key: 'intimation_due', label: 'Intimation due' },
  { key: 'reports_pending', label: 'Reports pending' },
  { key: 'evidence_awaiting_police', label: 'Evidence awaiting police' },
  { key: 'court_dates', label: 'Court dates' },
] as const;

const selectClass = 'h-10 rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

function overdueTone(minutes: number | null): 'danger' | 'warning' | 'neutral' {
  if (minutes === null) return 'neutral';
  if (minutes > 60) return 'danger';
  if (minutes > 0) return 'warning';
  return 'neutral';
}

/**
 * TR-008 — the medico-legal register and its worklists.
 *
 * ── Gapless, and it shows ───────────────────────────────────────────────────
 *
 * The register is the statutory document a court asks for. Its numbers run
 * without gaps per branch per financial year, cancelled cases keep their number
 * and stay in the list, and nothing here can renumber or remove a row. What the
 * screen adds is the one thing paper cannot: the clock on each intimation.
 *
 * ── Sensitive cases are absent, not greyed out ──────────────────────────────
 *
 * A caller without `mlc.sensitive.read` does not see a row, a placeholder or a
 * count. Rendering "1 restricted case" would tell a ward clerk that somebody in
 * the department today is a sexual-assault survivor, which is the disclosure
 * the restriction exists to prevent. The server filters; this screen has no
 * "show hidden" affordance because there is nothing to show.
 */
export function MlcRegisterScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = erKeys(hospitalId);

  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [worklistKind, setWorklistKind] = useState<string>('intimation_due');

  const maySeeSensitive = granted.has('mlc.sensitive.read');

  const register = useQuery({
    queryKey: keys.mlcRegister(`${status}|${category}|${String(maySeeSensitive)}`),
    queryFn: ({ signal }) =>
      getRegister(
        {
          ...(status === '' ? {} : { status }),
          ...(category === '' ? {} : { category }),
          includeSensitive: maySeeSensitive,
        },
        { signal },
      ),
  });
  const cases: readonly MlcCaseView[] = register.data?.items ?? [];

  const worklist = useQuery({
    queryKey: keys.mlcWorklist(worklistKind),
    queryFn: ({ signal }) => getWorklist(worklistKind, { signal }),
    refetchInterval: 60_000,
  });
  const rows: readonly MlcWorklistRow[] = worklist.data?.items ?? [];

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Medico-legal register"
        description="Gapless per branch per year. A cancelled case keeps its number and stays in the list — a reused MLC number is two cases sharing one identity in a court file."
      />

      {/* ── Worklists ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Worklists</h2>
        <div className="flex flex-wrap gap-2">
          {WORKLISTS.map((w) => (
            <button
              key={w.key}
              type="button"
              aria-pressed={worklistKind === w.key}
              data-testid={`worklist-${w.key}`}
              className={`min-h-12 rounded-lg border px-4 text-sm ${
                worklistKind === w.key
                  ? 'border-accent-border bg-layer-2 text-fg-default'
                  : 'border-default text-fg-muted hover:text-fg-default'
              }`}
              onClick={() => {
                setWorklistKind(w.key);
              }}
            >
              {w.label}
            </button>
          ))}
        </div>

        <AsyncPanel
          loading={worklist.isPending}
          error={worklist.error}
          isEmpty={rows.length === 0}
          skeletonLabel="Loading the worklist"
          skeletonRows={3}
          onRetry={() => {
            void worklist.refetch();
          }}
          empty={
            <EmptyState
              cause="Nothing is outstanding on this list."
              nextAction="Cases appear here when an intimation, a report or an evidence handover goes past its target."
            />
          }
        >
          <ul className="flex flex-col gap-1" data-testid="mlc-worklist">
            {rows.map((row) => (
              <li
                key={`${row.caseId}-${row.detail}`}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-default bg-layer-1 px-3 py-2 text-sm"
              >
                <span className="min-w-0">
                  <Link
                    href={{ pathname: '/er/mlc/case', query: { id: row.caseId } }}
                    className="font-mono text-fg-link underline-offset-2 hover:underline"
                  >
                    {row.mlcNo}
                  </Link>
                  <span className="ms-2 text-fg-muted">{CATEGORY_LABEL[row.category] ?? row.category}</span>
                  <span className="ms-2 text-2xs text-fg-subtle">{row.detail}</span>
                </span>
                {row.minutesOverdue === null ? null : (
                  <Badge tone={overdueTone(row.minutesOverdue)}>
                    {row.minutesOverdue > 0
                      ? `${String(row.minutesOverdue)} min over`
                      : `${String(Math.abs(row.minutesOverdue))} min left`}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </AsyncPanel>
      </div>

      {/* ── The register ──────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="mlc-status">Status</Label>
          <select
            id="mlc-status"
            className={selectClass}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
            }}
          >
            <option value="">All</option>
            {['open', 'report_pending', 'report_final', 'closed', 'cancelled'].map((s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ')}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="mlc-category">Category</Label>
          <select
            id="mlc-category"
            className={selectClass}
            value={category}
            onChange={(event) => {
              setCategory(event.target.value);
            }}
          >
            <option value="">All</option>
            {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <AsyncPanel
        loading={register.isPending}
        error={register.error}
        isEmpty={cases.length === 0}
        skeletonLabel="Loading the register"
        skeletonRows={8}
        onRetry={() => {
          void register.refetch();
        }}
        empty={
          <EmptyState
            cause="No medico-legal cases match this filter."
            nextAction="Clear the filters, or open a case from the ER board when one arrives."
          />
        }
      >
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm" data-testid="mlc-register">
            <caption className="sr-only">Medico-legal register</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                <th scope="col" className="px-3 py-2 text-start">
                  MLC no
                </th>
                <th scope="col" className="px-3 py-2 text-start">
                  Category
                </th>
                <th scope="col" className="px-3 py-2 text-start">
                  Patient
                </th>
                <th scope="col" className="px-3 py-2 text-start">
                  Opened
                </th>
                <th scope="col" className="px-3 py-2 text-start">
                  Intimation
                </th>
                <th scope="col" className="px-3 py-2 text-end">
                  Injuries
                </th>
                <th scope="col" className="px-3 py-2 text-end">
                  Evidence
                </th>
                <th scope="col" className="px-3 py-2 text-start">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {cases.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-default last:border-0"
                  data-testid={`mlc-row-${row.mlcNo}`}
                >
                  <td className="px-3 py-2">
                    <Link
                      href={{ pathname: '/er/mlc/case', query: { id: row.id } }}
                      className="font-mono text-2xs text-fg-link underline-offset-2 hover:underline"
                    >
                      {row.mlcNo}
                    </Link>
                    {row.isSensitive ? (
                      <div className="mt-1">
                        <Badge tone="danger">restricted</Badge>
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">{CATEGORY_LABEL[row.category] ?? row.category}</td>
                  <td className="px-3 py-2">
                    {row.displayName ?? row.tempTagId ?? '—'}
                    {row.erNo === null ? null : (
                      <p className="font-mono text-2xs text-fg-subtle">{row.erNo}</p>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-2xs">{new Date(row.openedAt).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    {row.minutesToIntimation === null ? (
                      <Badge tone="danger">not sent</Badge>
                    ) : (
                      <Badge tone={row.minutesToIntimation > 60 ? 'warning' : 'success'}>
                        {`${String(row.minutesToIntimation)} min`}
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-end font-mono text-2xs">{row.injuryCount}</td>
                  <td className="px-3 py-2 text-end font-mono text-2xs">{row.evidenceCount}</td>
                  <td className="px-3 py-2">
                    <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>{row.status.replace('_', ' ')}</Badge>
                    {row.gateOverrideBy === null ? null : (
                      <div className="mt-1">
                        <Badge tone="warning">gate overridden</Badge>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      <p className="text-2xs text-fg-subtle">
        {maySeeSensitive
          ? 'You hold the restricted-case key, so sexual-assault, POCSO, dowry and custodial cases are listed above. Every read of one is audited.'
          : 'Sexual-assault, POCSO, dowry and custodial cases are not listed here and are not counted. Showing that a restricted case exists would be the disclosure the restriction prevents.'}
      </p>
    </section>
  );
}
