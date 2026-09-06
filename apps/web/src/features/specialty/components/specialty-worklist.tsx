'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState } from '@vims/ui';
import { useEffect, useRef, useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { getWorklist, moveStage } from '../api/client';
import { specialtyKeys } from '../api/keys';
import type { WorklistRow } from '../api/types';

/**
 * The worklist every console shares (OP-025 §0.2).
 *
 * ── One component, thirty consoles ──────────────────────────────────────────
 *
 * `phase-08`: "A console that ships its own worklist … is a defect, not a
 * feature." The lanes, their labels and their order come from the console's
 * `worklistConfig`; nothing here knows what an eye is.
 *
 * ── Waiting and unlooked-at are different chips ─────────────────────────────
 *
 * A patient waiting on a scan that has not been done is a scheduling problem; a
 * patient whose scan is sitting unread is a clinical one. One "results" number
 * would hide whichever is smaller that day, and it is usually the second.
 *
 * ── Keyboard-first, because the lane is ─────────────────────────────────────
 *
 * Arrows select, Enter opens, `Ctrl+Shift+D` advances, `/` filters. An
 * optometrist seeing a hundred patients a day does not reach for a mouse.
 */
export function SpecialtyWorklist({
  consoleCode,
  lanes,
  onOpen,
}: {
  readonly consoleCode: string;
  /** `[{ key, label }]` in the order the patient walks them. */
  readonly lanes: readonly { readonly key: string; readonly label: string }[];
  readonly onOpen?: (row: WorklistRow) => void;
}): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = specialtyKeys(hospitalId);
  const client = useQueryClient();

  const [lane, setLane] = useState('');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(0);
  const filterRef = useRef<HTMLInputElement | null>(null);

  const worklist = useQuery({
    queryKey: keys.worklist(`${consoleCode}|${lane}`),
    queryFn: ({ signal }) =>
      getWorklist({ consoleCode, ...(lane === '' ? {} : { stageKey: lane }), openOnly: true }, { signal }),
    refetchInterval: 30_000,
  });

  const advance = useMutation({
    mutationFn: (input: { readonly row: WorklistRow; readonly stageKey: string }) =>
      moveStage({
        encounterId: input.row.encounterId,
        patientId: input.row.patientId,
        consoleCode,
        stageKey: input.stageKey,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.worklistRoot() });
    },
  });

  const all: readonly WorklistRow[] = worklist.data ?? [];
  const needle = filter.trim().toLowerCase();
  const rows =
    needle === ''
      ? all
      : all.filter(
          (r) => r.patientName.toLowerCase().includes(needle) || r.uhid.toLowerCase().includes(needle),
        );

  /** The lane after this one, which is what `Ctrl+Shift+D` means. */
  function nextLane(current: string | null): string | null {
    const index = lanes.findIndex((l) => l.key === current);
    if (index < 0 || index + 1 >= lanes.length) return null;
    return lanes[index + 1]?.key ?? null;
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === '/' && document.activeElement !== filterRef.current) {
        event.preventDefault();
        filterRef.current?.focus();
        return;
      }
      if (rows.length === 0) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelected((s) => Math.min(s + 1, rows.length - 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
      } else if (event.key === 'Enter' && document.activeElement !== filterRef.current) {
        const row = rows[selected];
        if (row !== undefined && onOpen !== undefined) {
          event.preventDefault();
          onOpen(row);
        }
      } else if (event.key === 'D' && event.ctrlKey && event.shiftKey) {
        const row = rows[selected];
        const next = row === undefined ? null : nextLane(row.stageKey);
        if (row !== undefined && next !== null && granted.has('console.stage.record')) {
          event.preventDefault();
          advance.mutate({ row, stageKey: next });
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  });

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant={lane === '' ? 'primary' : 'secondary'}
            onClick={() => {
              setLane('');
            }}
          >
            All lanes
          </Button>
          {lanes.map((l) => (
            <Button
              key={l.key}
              size="sm"
              variant={lane === l.key ? 'primary' : 'secondary'}
              onClick={() => {
                setLane(l.key);
                setSelected(0);
              }}
            >
              {l.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-2xs uppercase tracking-[0.08em] text-fg-subtle" htmlFor="wl-filter">
            Filter — press /
          </label>
          <input
            id="wl-filter"
            ref={filterRef}
            className="h-10 w-56 rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default"
            placeholder="Name or UHID"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setSelected(0);
            }}
          />
        </div>
      </div>

      {advance.error === null ? null : <ProblemCard error={advance.error} />}

      <AsyncPanel
        loading={worklist.isPending}
        error={worklist.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading the worklist"
        skeletonRows={8}
        onRetry={() => {
          void worklist.refetch();
        }}
        empty={
          <EmptyState
            cause={filter === '' ? 'Nobody is waiting in this console.' : 'Nobody matches that.'}
            nextAction="Patients appear here as they are checked in and routed to one of the lanes."
          />
        }
      >
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm" data-testid="specialty-worklist">
            <caption className="sr-only">{`${consoleCode} worklist`}</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {['Token', 'Patient', 'UHID', 'Lane', 'Waiting', 'Results', ''].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 text-start">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, index) => {
                const next = nextLane(r.stageKey);
                return (
                  <tr
                    key={r.encounterId}
                    className={`border-b border-default last:border-0 ${index === selected ? 'bg-layer-2' : ''}`}
                    data-testid={`wl-${r.encounterId}`}
                    aria-selected={index === selected}
                  >
                    <td className="px-3 py-2 font-mono text-2xs">{r.tokenDisplay ?? '—'}</td>
                    <td className="px-3 py-2 font-medium">{r.patientName}</td>
                    <td className="px-3 py-2 font-mono text-2xs text-fg-muted">{r.uhid}</td>
                    <td className="px-3 py-2 text-2xs">
                      {lanes.find((l) => l.key === r.stageKey)?.label ?? r.stageKey ?? '—'}
                    </td>
                    <td className="px-3 py-2">
                      {r.minutesInStage === null ? (
                        <span className="text-2xs text-fg-muted">—</span>
                      ) : r.minutesInStage >= 45 ? (
                        <Badge tone="warning">{`${String(r.minutesInStage)} min`}</Badge>
                      ) : (
                        <span className="font-mono text-2xs">{`${String(r.minutesInStage)} min`}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {r.pendingResults > 0 ? (
                          <Badge tone="neutral">{`${String(r.pendingResults)} awaited`}</Badge>
                        ) : null}
                        {r.unreviewedResults > 0 ? (
                          <Badge tone="warning">{`${String(r.unreviewedResults)} unread`}</Badge>
                        ) : null}
                        {r.pendingResults === 0 && r.unreviewedResults === 0 ? (
                          <span className="text-2xs text-fg-muted">—</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-2">
                        {onOpen === undefined ? null : (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              onOpen(r);
                            }}
                          >
                            Open
                          </Button>
                        )}
                        {next !== null && granted.has('console.stage.record') ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={advance.isPending}
                            onClick={() => {
                              advance.mutate({ row: r, stageKey: next });
                            }}
                          >
                            {`→ ${lanes.find((l) => l.key === next)?.label ?? next}`}
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      <p className="text-2xs text-fg-subtle">
        Arrows select, Enter opens, Ctrl+Shift+D sends the selected patient to the next lane. Waiting time is
        time in the current lane, not since arrival — a long wait for the doctor and a long wait for dilation
        are different problems.
      </p>
    </section>
  );
}
