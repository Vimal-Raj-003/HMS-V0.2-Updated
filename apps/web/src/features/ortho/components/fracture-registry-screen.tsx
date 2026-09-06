'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState, Label } from '@vims/ui';
import Link from 'next/link';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { getRegistry } from '../api/client';
import { orthoKeys } from '../api/keys';
import type { FractureView } from '../api/types';

const SIDE_TONE: Readonly<Record<string, 'danger' | 'info' | 'neutral'>> = {
  left: 'info',
  right: 'danger',
  midline: 'neutral',
  not_applicable: 'neutral',
};

const STATUS_TONE: Readonly<Record<string, 'warning' | 'success' | 'neutral'>> = {
  open: 'warning',
  united: 'success',
  closed_other: 'neutral',
  reopened: 'warning',
};

const selectClass = 'h-10 rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

/**
 * TR-002 — the fracture registry.
 *
 * ── Side is a badge, not a word in a sentence ───────────────────────────────
 *
 * Left and right get different colours *and* different words, on every row, in
 * the same place. A laterality error survives four handoffs because at each one
 * the side is buried in prose; putting it in the same position on every row is
 * the cheapest thing this screen does and probably the most useful.
 *
 * ── The gaps are named, not counted ─────────────────────────────────────────
 *
 * "3 fields missing" makes somebody open the record to find out which. The row
 * says "AO code below type level; no mechanism", which is a thing a coder can
 * act on from the list.
 */
export function FractureRegistryScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = orthoKeys(hospitalId);

  const [status, setStatus] = useState('');
  const [openOnly, setOpenOnly] = useState(false);
  const [confirmedOnly, setConfirmedOnly] = useState(false);

  const registry = useQuery({
    queryKey: keys.registry(`${status}|${String(openOnly)}|${String(confirmedOnly)}`),
    queryFn: ({ signal }) =>
      getRegistry({ ...(status === '' ? {} : { status }), openOnly, confirmedOnly }, { signal }),
  });
  const rows: readonly FractureView[] = registry.data?.items ?? [];

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Fracture registry"
        description="Every fracture, its AO/OTA code and its side. A row that would not survive an export says which field is missing."
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="fx-status">Status</Label>
          <select
            id="fx-status"
            className={selectClass}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
            }}
          >
            <option value="">All</option>
            {['open', 'united', 'closed_other', 'reopened'].map((s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ')}
              </option>
            ))}
          </select>
        </div>
        <label className="flex min-h-12 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={openOnly}
            onChange={(e) => {
              setOpenOnly(e.target.checked);
            }}
          />
          Open fractures only
        </label>
        <label className="flex min-h-12 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={confirmedOnly}
            onChange={(e) => {
              setConfirmedOnly(e.target.checked);
            }}
          />
          Confirmed classifications only
        </label>
      </div>

      <AsyncPanel
        loading={registry.isPending}
        error={registry.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading the fracture registry"
        skeletonRows={8}
        onRetry={() => {
          void registry.refetch();
        }}
        empty={
          <EmptyState
            cause="No fractures match this filter."
            nextAction="Clear the filters, or register one from the ER or the clinic when it arrives."
          />
        }
      >
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm" data-testid="fracture-registry">
            <caption className="sr-only">Fracture registry</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {['AO code', 'Bone', 'Side', 'Open', 'Classification', 'Status', 'Weeks', 'Registry'].map(
                  (h) => (
                    <th key={h} scope="col" className="px-3 py-2 text-start">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr
                  key={f.id}
                  className="border-b border-default last:border-0"
                  data-testid={`fx-row-${f.id}`}
                >
                  <td className="px-3 py-2">
                    <Link
                      href={{ pathname: '/ortho/fractures/record', query: { id: f.id } }}
                      className="font-mono text-2xs text-fg-link underline-offset-2 hover:underline"
                    >
                      {f.aoCode ?? 'unclassified'}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{f.boneDisplay}</td>
                  <td className="px-3 py-2">
                    {/* Colour and word, in the same place on every row. */}
                    <Badge tone={SIDE_TONE[f.side] ?? 'neutral'}>{f.side.replace('_', ' ')}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    {f.isOpen ? (
                      <Badge tone="danger">{`open · Gustilo ${f.gustilo ?? '?'}`}</Badge>
                    ) : (
                      <span className="text-2xs text-fg-subtle">closed</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={f.classificationStatus === 'confirmed' ? 'success' : 'warning'}>
                      {f.classificationStatus}
                    </Badge>
                    {f.cosignRequired && f.cosignedAt === null ? (
                      <div className="mt-1">
                        <Badge tone="warning">co-sign due</Badge>
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={STATUS_TONE[f.status] ?? 'neutral'}>{f.status.replace('_', ' ')}</Badge>
                  </td>
                  <td className="px-3 py-2 font-mono text-2xs">{f.weeksSinceInjury ?? '—'}</td>
                  <td className="px-3 py-2">
                    {f.registryReady ? (
                      <Badge tone="success">ready</Badge>
                    ) : (
                      <span className="text-2xs text-fg-muted">{f.registryGaps.join('; ')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      <p className="text-2xs text-fg-subtle">
        Side is shown as a badge in the same position on every row, in colour and in words. A laterality error
        survives four handoffs because at each one the side is buried in a sentence.
      </p>
    </section>
  );
}
