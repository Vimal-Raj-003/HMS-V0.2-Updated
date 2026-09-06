'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Label } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { callCode, closeCode, getCode, getCodes, recordCodeEvent, restockCart } from '../api/client';
import { ipKeys } from '../api/keys';
import type { CodeRow } from '../api/types';

const inputClass = 'h-10 w-full rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

/**
 * IP-013 — the code.
 *
 * ── Everything on this screen is one tap ────────────────────────────────────
 *
 * Rhythm, shock, drug, cycle, ROSC. The person recording is standing at the end
 * of a bed while somebody does compressions, and a form with dropdowns and a
 * save button is a form nobody fills in until afterwards — which is how the
 * timings become recollections.
 *
 * ── The clock is derived, always ────────────────────────────────────────────
 *
 * Time to first shock and time to first drug come from triggers on the rows
 * below. Neither is typed anywhere, on this screen or on any other.
 */
export function CodeBlueScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = ipKeys(hospitalId);
  const queryClient = useQueryClient();

  const [openId, setOpenId] = useState<string | null>(null);
  const [location, setLocation] = useState('');
  const [drug, setDrug] = useState('Adrenaline');
  const [dose, setDose] = useState('1 mg');
  const [seal, setSeal] = useState('');

  const codes = useQuery({
    queryKey: keys.codes('open'),
    queryFn: ({ signal }) => getCodes({ openOnly: true }, { signal }),
    // A code is measured in seconds. Refresh often enough that the elapsed
    // clock on an unopened card is not visibly wrong.
    refetchInterval: 10_000,
  });

  const detail = useQuery({
    queryKey: keys.code(openId ?? 'none'),
    queryFn: ({ signal }) => getCode(openId ?? '', { signal }),
    enabled: openId !== null,
    refetchInterval: 10_000,
  });

  function invalidate(): void {
    void queryClient.invalidateQueries({ queryKey: keys.codesRoot() });
    if (openId !== null) void queryClient.invalidateQueries({ queryKey: keys.code(openId) });
  }

  const call = useMutation({
    mutationFn: () => callCode({ location: location.trim() }),
    onSuccess: (created) => {
      setLocation('');
      setOpenId(created.id);
      invalidate();
    },
  });

  const event = useMutation({
    mutationFn: (body: Readonly<Record<string, unknown>>) => recordCodeEvent(openId ?? '', body as never),
    onSuccess: invalidate,
  });

  const restock = useMutation({
    mutationFn: () => restockCart(openId ?? '', seal.trim()),
    onSuccess: () => {
      setSeal('');
      invalidate();
    },
  });

  const close = useMutation({
    mutationFn: (outcome: string) => closeCode(openId ?? '', { outcome }),
    onSuccess: invalidate,
  });

  const rows: readonly CodeRow[] = codes.data?.items ?? [];
  const d = detail.data;

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Code blue"
        description="Call one, write the flowsheet as it happens, and let the clock come from the rows rather than from anybody's memory."
      />

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-strong bg-layer-1 p-4">
        <div className="grow">
          <Label htmlFor="code-loc">Where</Label>
          <input
            id="code-loc"
            className={inputClass}
            value={location}
            placeholder="General ward 2, bed 301-B"
            onChange={(e) => {
              setLocation(e.target.value);
            }}
          />
        </div>
        <Button
          type="button"
          disabled={call.isPending || location.trim() === ''}
          onClick={() => {
            call.mutate();
          }}
        >
          Call a code
        </Button>
      </div>
      {call.error === null ? null : <ProblemCard error={call.error} />}

      <AsyncPanel
        loading={codes.isPending}
        error={codes.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading the codes"
        skeletonRows={3}
        onRetry={() => {
          void codes.refetch();
        }}
        empty={
          <EmptyState cause="No code is running." nextAction="Call one above if somebody has arrested." />
        }
      >
        <ul className="flex flex-col gap-2">
          {rows.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger bg-danger-subtle p-4"
              data-testid={`code-${c.id}`}
            >
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-2xs">{c.codeNo}</span>
                  <span className="text-sm font-semibold text-fg-default">{c.location}</span>
                  <Badge tone="danger">{c.state.replace(/_/gu, ' ')}</Badge>
                </div>
                <p className="mt-1 font-mono text-2xs">
                  {`${describe(c.elapsedSeconds)} elapsed`}
                  {c.secondsToFirstShock === null
                    ? ' · no shock yet'
                    : ` · first shock at ${describe(c.secondsToFirstShock)}`}
                  {c.secondsToFirstDrug === null ? '' : ` · first drug at ${describe(c.secondsToFirstDrug)}`}
                </p>
              </div>
              <Button
                type="button"
                variant={openId === c.id ? 'secondary' : 'primary'}
                onClick={() => {
                  setOpenId(openId === c.id ? null : c.id);
                }}
              >
                {openId === c.id ? 'Close' : 'Record'}
              </Button>
            </li>
          ))}
        </ul>
      </AsyncPanel>

      {event.error === null ? null : <ProblemCard error={event.error} />}
      {close.error === null ? null : <ProblemCard error={close.error} />}
      {restock.error === null ? null : <ProblemCard error={restock.error} />}

      {d === undefined || openId === null ? null : (
        <div className="rounded-lg border border-strong bg-layer-1 p-4">
          <h2 className="text-sm font-semibold text-fg-default">{`${d.codeNo} — flowsheet`}</h2>

          {/* One tap each. Nobody fills a form during compressions. */}
          <div className="mt-3 flex flex-wrap gap-2">
            {(['vf', 'pvt', 'asystole', 'pea', 'sinus'] as const).map((r) => (
              <Button
                key={r}
                type="button"
                variant="secondary"
                disabled={event.isPending}
                onClick={() => {
                  event.mutate({ kind: 'rhythm', rhythm: r });
                }}
              >
                {r.toUpperCase()}
              </Button>
            ))}
            <Button
              type="button"
              disabled={event.isPending}
              onClick={() => {
                event.mutate({ kind: 'shock', joules: 200 });
              }}
            >
              Shock 200 J
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={event.isPending}
              onClick={() => {
                event.mutate({ kind: 'cpr_cycle', note: 'Two-minute cycle' });
              }}
            >
              CPR cycle
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={event.isPending}
              onClick={() => {
                event.mutate({ kind: 'rosc', note: 'Palpable pulse' });
              }}
            >
              ROSC
            </Button>
          </div>

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <Label htmlFor="code-drug">Drug</Label>
              <input
                id="code-drug"
                className={`${inputClass} max-w-48`}
                value={drug}
                onChange={(e) => {
                  setDrug(e.target.value);
                }}
              />
            </div>
            <div>
              <Label htmlFor="code-dose">Dose</Label>
              <input
                id="code-dose"
                className={`${inputClass} max-w-32`}
                value={dose}
                onChange={(e) => {
                  setDose(e.target.value);
                }}
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              disabled={event.isPending || drug.trim() === '' || dose.trim() === ''}
              onClick={() => {
                event.mutate({ kind: 'drug', drug: drug.trim(), dose: dose.trim(), route: 'iv' });
              }}
            >
              Give
            </Button>
          </div>

          <ol className="mt-4 flex flex-col gap-1" data-testid="code-flowsheet">
            {d.events.map((e) => (
              <li key={e.id} className="flex gap-3 text-sm">
                <span className="w-16 shrink-0 text-end font-mono text-2xs text-fg-subtle">
                  {describe(e.secondsFromCall)}
                </span>
                <span>
                  <span className="font-semibold">{e.kind.replace('_', ' ')}</span>
                  {e.rhythm === null ? '' : ` — ${e.rhythm.toUpperCase()}`}
                  {e.joules === null ? '' : ` — ${String(e.joules)} J`}
                  {e.drug === null ? '' : ` — ${e.drug} ${e.dose ?? ''}`}
                  {e.note === null ? '' : ` — ${e.note}`}
                </span>
              </li>
            ))}
          </ol>

          <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-default pt-3">
            <div>
              <Label htmlFor="code-seal">New seal number</Label>
              <input
                id="code-seal"
                className={`${inputClass} max-w-48`}
                value={seal}
                placeholder="SEAL-88215"
                onChange={(e) => {
                  setSeal(e.target.value);
                }}
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              disabled={restock.isPending || seal.trim() === ''}
              onClick={() => {
                restock.mutate();
              }}
            >
              Cart restocked and re-sealed
            </Button>
            {(['rosc', 'died', 'transferred', 'false_alarm'] as const).map((o) => (
              <Button
                key={o}
                type="button"
                disabled={close.isPending}
                onClick={() => {
                  close.mutate(o);
                }}
              >
                {`Close — ${o.replace('_', ' ')}`}
              </Button>
            ))}
          </div>
          <p className="mt-2 text-2xs text-fg-subtle">
            A code cannot close until the cart it used is restocked and re-sealed. The next arrest is the
            reason.
          </p>
        </div>
      )}
    </section>
  );
}

function describe(secondsValue: number): string {
  if (secondsValue < 60) return `${String(secondsValue)} s`;
  const m = Math.floor(secondsValue / 60);
  const s = secondsValue % 60;
  return `${String(m)}:${String(s).padStart(2, '0')}`;
}
