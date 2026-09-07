'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { administer, getTasks, recordDressing, setTaskStatus } from '../api/client';
import { procedureKeys } from '../api/keys';
import type { TaskRow } from '../api/types';

const input = 'h-10 w-full rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

const ROOMS = [
  { key: 'injection_room', label: 'Injection room' },
  { key: 'dressing', label: 'Dressing' },
  { key: 'plaster', label: 'Plaster' },
  { key: 'nebulisation', label: 'Nebulisation' },
  { key: 'observation_bay', label: 'Observation' },
  { key: 'minor_ot', label: 'Minor OT' },
] as const;

/**
 * OP-039 — the OPD nursing rooms.
 *
 * ── The five rights, at a chair rather than a bedside ───────────────────────
 *
 * Identity, drug, dose, route, time — and the two things the ward MAR taught
 * this product: the batch is scanned rather than typed, and a high-alert drug
 * is checked by somebody who is not giving it. The form asks for the second
 * person by name; the server refuses them when they are the same person.
 *
 * ── Watching is a state, not a note ─────────────────────────────────────────
 *
 * A first parenteral dose is watched. The task sits in `observation` until
 * somebody says how it went, so a patient who walked out after ten minutes is
 * visible rather than silently complete.
 */
export function NursingRoomsScreen(): React.JSX.Element {
  const { hospitalId, granted, userId } = useSession();
  const keys = procedureKeys(hospitalId);
  const client = useQueryClient();

  const [room, setRoom] = useState<string>('injection_room');
  const [openId, setOpenId] = useState<string | null>(null);
  const [drug, setDrug] = useState({
    name: '',
    dose: '',
    unit: 'mg',
    route: 'im',
    batch: '',
    expiry: '',
    highAlert: false,
    verifier: '',
    observe: '30',
  });
  const [dressing, setDressing] = useState({ site: '', removed: '', retained: '', infection: false });
  const [holdReason, setHoldReason] = useState('');

  const tasks = useQuery({
    queryKey: keys.tasks(room),
    queryFn: ({ signal }) => getTasks({ roomType: room, openOnly: true }, { signal }),
    refetchInterval: 45_000,
  });

  function invalidate(): void {
    void client.invalidateQueries({ queryKey: keys.tasksRoot() });
  }

  const give = useMutation({
    mutationFn: (task: TaskRow) =>
      administer(task.id, {
        drugName: drug.name.trim(),
        orderedDose: Number(drug.dose),
        givenDose: Number(drug.dose),
        doseUnit: drug.unit,
        route: drug.route,
        ...(drug.batch.trim() === '' ? {} : { batchNo: drug.batch.trim(), barcodeVerified: true }),
        ...(drug.expiry === '' ? {} : { expiry: drug.expiry }),
        identityMethod: 'wristband',
        highAlert: drug.highAlert,
        ...(drug.verifier.trim() === '' ? {} : { verifierId: drug.verifier.trim() }),
        allergyChecked: true,
        observationMinutes: Number(drug.observe),
      }),
    onSuccess: () => {
      setDrug({ ...drug, name: '', dose: '', batch: '', verifier: '' });
      invalidate();
    },
  });

  const dress = useMutation({
    mutationFn: (task: TaskRow) =>
      recordDressing(task.id, {
        patientId: task.patientId,
        site: dressing.site.trim(),
        assessment: {},
        ...(dressing.removed === '' ? {} : { suturesRemoved: Number(dressing.removed) }),
        ...(dressing.retained === '' ? {} : { suturesRetained: Number(dressing.retained) }),
        infectionSigns: dressing.infection,
      }),
    onSuccess: () => {
      setDressing({ site: '', removed: '', retained: '', infection: false });
      invalidate();
    },
  });

  const hold = useMutation({
    mutationFn: (id: string) => setTaskStatus(id, { status: 'held', reason: holdReason.trim() }),
    onSuccess: () => {
      setHoldReason('');
      invalidate();
    },
  });

  const rows: readonly TaskRow[] = tasks.data ?? [];
  const open = rows.find((t) => t.id === openId);
  const isDressingRoom = room === 'dressing' || room === 'plaster';

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="OPD nursing rooms"
        description="The injection, dressing and plaster rooms — who is waiting, who is being watched, and what each is here for."
      />

      <div className="flex flex-wrap gap-1">
        {ROOMS.map((r) => (
          <Button
            key={r.key}
            size="sm"
            variant={room === r.key ? 'primary' : 'secondary'}
            onClick={() => {
              setRoom(r.key);
              setOpenId(null);
            }}
          >
            {r.label}
          </Button>
        ))}
      </div>

      <AsyncPanel
        loading={tasks.isPending}
        error={tasks.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading the room worklist"
        skeletonRows={6}
        onRetry={() => {
          void tasks.refetch();
        }}
        empty={
          <EmptyState
            cause="Nobody is waiting in this room."
            nextAction="Tasks arrive from a prescription, a procedure order or a plaster job."
          />
        }
      >
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm" data-testid="nursing-worklist">
            <caption className="sr-only">Nursing room worklist</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {['Priority', 'What for', 'Day', 'State', ''].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 text-start">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr
                  key={t.id}
                  className={`border-b border-default last:border-0 ${openId === t.id ? 'bg-layer-2' : ''}`}
                  data-testid={`task-${t.id}`}
                >
                  <td className="px-3 py-2">
                    {t.priority === 'stat' ? (
                      <Badge tone="danger">STAT</Badge>
                    ) : t.priority === 'urgent' ? (
                      <Badge tone="warning">urgent</Badge>
                    ) : (
                      <span className="text-2xs text-fg-muted">routine</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-medium">{t.type.replace(/_/gu, ' ')}</td>
                  <td className="px-3 py-2 font-mono text-2xs">
                    {t.dayNo === null || t.dayTotal === null
                      ? '—'
                      : `${String(t.dayNo)} of ${String(t.dayTotal)}`}
                  </td>
                  <td className="px-3 py-2">
                    {t.underObservation > 0 ? (
                      <Badge tone="warning">being watched</Badge>
                    ) : t.status === 'held' ? (
                      <Badge tone="neutral">{`held — ${t.holdReason ?? ''}`}</Badge>
                    ) : (
                      <span className="text-2xs">{t.status.replace(/_/gu, ' ')}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setOpenId(t.id);
                      }}
                    >
                      Open
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      {open === undefined ? null : (
        <div className="flex flex-col gap-4 rounded-lg border border-strong bg-layer-1 p-4">
          <h2 className="text-base font-semibold text-fg-default">{open.type.replace(/_/gu, ' ')}</h2>

          {!isDressingRoom && granted.has('opdnursing.administer') ? (
            <div className="flex flex-col gap-3">
              <div className="grid gap-3 sm:grid-cols-4">
                <label className="flex flex-col gap-1 text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  Drug
                  <input
                    className={input}
                    value={drug.name}
                    onChange={(e) => {
                      setDrug({ ...drug, name: e.target.value });
                    }}
                  />
                </label>
                <label className="flex flex-col gap-1 text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  Dose
                  <input
                    className={`${input} font-mono`}
                    value={drug.dose}
                    onChange={(e) => {
                      setDrug({ ...drug, dose: e.target.value });
                    }}
                  />
                </label>
                <label className="flex flex-col gap-1 text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  Unit
                  <input
                    className={input}
                    value={drug.unit}
                    onChange={(e) => {
                      setDrug({ ...drug, unit: e.target.value });
                    }}
                  />
                </label>
                <label className="flex flex-col gap-1 text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  Route
                  <select
                    className={input}
                    value={drug.route}
                    onChange={(e) => {
                      setDrug({ ...drug, route: e.target.value });
                    }}
                  >
                    {['im', 'iv_push', 'iv_infusion', 'sc', 'id', 'inhalation'].map((r) => (
                      <option key={r} value={r}>
                        {r.replace(/_/gu, ' ')}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  Batch — scanned
                  <input
                    className={`${input} font-mono`}
                    value={drug.batch}
                    onChange={(e) => {
                      setDrug({ ...drug, batch: e.target.value });
                    }}
                  />
                </label>
                <label className="flex flex-col gap-1 text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  Expiry
                  <input
                    type="date"
                    className={input}
                    value={drug.expiry}
                    onChange={(e) => {
                      setDrug({ ...drug, expiry: e.target.value });
                    }}
                  />
                </label>
                <label className="flex flex-col gap-1 text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  Watch for (minutes)
                  <input
                    className={`${input} font-mono`}
                    value={drug.observe}
                    onChange={(e) => {
                      setDrug({ ...drug, observe: e.target.value });
                    }}
                  />
                </label>
                <label className="flex min-h-12 items-center gap-2 self-end text-sm">
                  <input
                    type="checkbox"
                    className="size-5"
                    checked={drug.highAlert}
                    onChange={(e) => {
                      setDrug({ ...drug, highAlert: e.target.checked });
                    }}
                  />
                  High-alert drug
                </label>
              </div>

              {drug.highAlert ? (
                <div className="flex w-96 flex-col gap-1">
                  <label className="text-2xs uppercase tracking-[0.08em] text-fg-subtle" htmlFor="ad-verify">
                    Second person checking (not you)
                  </label>
                  <input
                    id="ad-verify"
                    className={input}
                    placeholder="User id of the nurse at the next chair"
                    value={drug.verifier}
                    onChange={(e) => {
                      setDrug({ ...drug, verifier: e.target.value });
                    }}
                  />
                </div>
              ) : null}

              <div>
                <Button
                  size="sm"
                  disabled={
                    give.isPending ||
                    drug.name.trim() === '' ||
                    drug.dose.trim() === '' ||
                    (drug.highAlert && (drug.verifier.trim() === '' || drug.verifier.trim() === userId))
                  }
                  onClick={() => {
                    give.mutate(open);
                  }}
                >
                  Give
                </Button>
              </div>
              {give.error === null ? null : <ProblemCard error={give.error} />}
              <p className="text-2xs text-fg-subtle">
                The allergy list is read before this button does anything — there is no route that gives a
                drug without it, and an expired batch is refused with no override anywhere in the product.
              </p>
            </div>
          ) : null}

          {isDressingRoom && granted.has('opdnursing.dressing.record') ? (
            <div className="flex flex-col gap-3">
              <div className="grid gap-3 sm:grid-cols-4">
                <label className="flex flex-col gap-1 text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  Site
                  <input
                    className={input}
                    value={dressing.site}
                    onChange={(e) => {
                      setDressing({ ...dressing, site: e.target.value });
                    }}
                  />
                </label>
                <label className="flex flex-col gap-1 text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  Sutures out
                  <input
                    className={`${input} font-mono`}
                    value={dressing.removed}
                    onChange={(e) => {
                      setDressing({ ...dressing, removed: e.target.value });
                    }}
                  />
                </label>
                <label className="flex flex-col gap-1 text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  Left in
                  <input
                    className={`${input} font-mono`}
                    value={dressing.retained}
                    onChange={(e) => {
                      setDressing({ ...dressing, retained: e.target.value });
                    }}
                  />
                </label>
                <label className="flex min-h-12 items-center gap-2 self-end text-sm">
                  <input
                    type="checkbox"
                    className="size-5"
                    checked={dressing.infection}
                    onChange={(e) => {
                      setDressing({ ...dressing, infection: e.target.checked });
                    }}
                  />
                  Signs of infection
                </label>
              </div>
              <div>
                <Button
                  size="sm"
                  disabled={dress.isPending || dressing.site.trim() === ''}
                  onClick={() => {
                    dress.mutate(open);
                  }}
                >
                  Record the dressing
                </Button>
              </div>
              {dress.error === null ? null : <ProblemCard error={dress.error} />}
            </div>
          ) : null}

          {granted.has('opdnursing.task.manage') ? (
            <div className="flex flex-wrap items-end gap-3 border-t border-default pt-4">
              <div className="flex w-96 flex-col gap-1">
                <label className="text-2xs uppercase tracking-[0.08em] text-fg-subtle" htmlFor="hold-reason">
                  Hold this task — why
                </label>
                <input
                  id="hold-reason"
                  className={input}
                  value={holdReason}
                  onChange={(e) => {
                    setHoldReason(e.target.value);
                  }}
                />
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={hold.isPending || holdReason.trim().length < 4}
                onClick={() => {
                  hold.mutate(open.id);
                }}
              >
                Hold
              </Button>
              {hold.error === null ? null : <ProblemCard error={hold.error} />}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
