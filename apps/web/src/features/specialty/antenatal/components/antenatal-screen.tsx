'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { getPregnancies, getSchedule, updateScheduleItem } from '../api/client';
import { antenatalKeys } from '../api/keys';
import type { PregnancyRow, ScheduleItemRow } from '../api/types';

/**
 * OP-040 — the antenatal clinic.
 *
 * ── The anti-D register is at the top, alone ────────────────────────────────
 *
 * Every other overdue item on this screen is a delay. That one is a child who
 * has not been conceived, and the person it harms will never be in the room
 * when it is missed. It is the only thing on the clinic board that gets its own
 * section, and it stays there until the dose is given or somebody writes down
 * why it is not needed.
 *
 * ── Then the calendar, because the module is a calendar ─────────────────────
 *
 * A booking, a scan window, a glucose test, a vaccine. Each is stored as a week
 * of gestation rather than a date, so when the dating is corrected the whole
 * list moves — and this screen shows what moved rather than what was booked.
 */
export function AntenatalScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = antenatalKeys(hospitalId);
  const qc = useQueryClient();

  const canManage = granted.has('obg.schedule.manage');
  const [waiving, setWaiving] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const pregnancies = useQuery({
    queryKey: keys.pregnancies('active'),
    queryFn: ({ signal }) => getPregnancies({ activeOnly: true }, { signal }),
    refetchInterval: 120_000,
  });

  const overdue = useQuery({
    queryKey: keys.schedule('overdue'),
    queryFn: ({ signal }) => getSchedule({ overdueOnly: true }, { signal }),
    refetchInterval: 120_000,
  });

  const settle = useMutation({
    mutationFn: (input: { id: string; status: string; waivedReason?: string }) =>
      updateScheduleItem(
        input.id,
        input.waivedReason === undefined
          ? { status: input.status }
          : { status: input.status, waivedReason: input.waivedReason },
      ),
    onSuccess: () => {
      setWaiving(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: keys.scheduleRoot() });
      void qc.invalidateQueries({ queryKey: keys.pregnanciesRoot() });
    },
  });

  const rows = pregnancies.data ?? [];
  const items = overdue.data ?? [];
  const antiD = items.filter((i) => i.kind === 'anti_d');
  const otherOverdue = items.filter((i) => i.kind !== 'anti_d');
  const highRisk = rows.filter((p) => p.riskCategory === 'high');

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Antenatal clinic"
        description="Who is booked, how far on they are, and what the calendar says is late — because every date in this module is arithmetic on one date, and the schedule moves when that one does."
      />

      {antiD.length > 0 ? (
        <section
          aria-label="Anti-D outstanding"
          className="rounded-lg border border-danger bg-danger-subtle p-4"
        >
          <h2 className="text-sm font-semibold text-fg-danger">
            {antiD.length} Rhesus-negative {antiD.length === 1 ? 'woman is' : 'women are'} owed anti-D
          </h2>
          <p className="mt-1 text-xs text-fg-muted">
            A missed dose does nothing to this baby and can kill the next one. It is given, or it is waived
            with a reason — most often that the baby is Rhesus negative too — and a pregnancy cannot be closed
            until one of those has happened.
          </p>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {antiD.map((item) => (
              <li key={item.id} className="rounded-md border border-danger bg-layer-1 p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone="danger">{item.daysOverdue} days overdue</Badge>
                  <span className="font-medium">{item.name}</span>
                  <span className="font-mono text-xs text-fg-muted">
                    due {new Date(item.dueAt).toLocaleDateString()}
                  </span>
                </div>

                {canManage ? (
                  waiving === item.id ? (
                    <form
                      className="mt-2 flex flex-wrap items-end gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        settle.mutate({ id: item.id, status: 'waived', waivedReason: reason });
                      }}
                    >
                      <label className="flex flex-col gap-1 text-xs">
                        <span className="font-medium">Why no anti-D is needed</span>
                        <input
                          className="w-96 rounded border border-control bg-layer-1 px-2 py-1 text-sm"
                          value={reason}
                          onChange={(event) => setReason(event.target.value)}
                          placeholder="Baby is Rhesus negative on cord blood; no prophylaxis indicated."
                          required
                          minLength={4}
                        />
                      </label>
                      <Button type="submit" size="sm" variant="secondary" disabled={settle.isPending}>
                        Waive it
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setWaiving(null);
                          setReason('');
                        }}
                      >
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={settle.isPending}
                        onClick={() => settle.mutate({ id: item.id, status: 'done' })}
                      >
                        Given
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={settle.isPending}
                        onClick={() => {
                          setWaiving(item.id);
                          setReason('');
                        }}
                      >
                        Not needed
                      </Button>
                    </div>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {highRisk.length > 0 ? (
        <p className="rounded-md border border-warning-border bg-warning-surface p-3 text-xs text-warning-on-surface">
          {highRisk.length} {highRisk.length === 1 ? 'pregnancy is' : 'pregnancies are'} flagged high risk.
          They are seen more often and their scans are booked closer together, which is why the schedule below
          is per-woman rather than per-week.
        </p>
      ) : null}

      <section aria-label="Booked pregnancies" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">On the register</h2>
        <AsyncPanel
          loading={pregnancies.isPending}
          error={pregnancies.error}
          isEmpty={rows.length === 0}
          skeletonLabel="Loading the antenatal register"
          skeletonRows={6}
          onRetry={() => void pregnancies.refetch()}
          empty={
            <EmptyState
              cause="Nobody is booked."
              nextAction="Register a pregnancy with a last period or a dating scan; the estimated date and the whole visit schedule follow from it."
            />
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <caption className="sr-only">
                Booked pregnancies. The gestational age is computed from the working estimated date of
                delivery, and the schedule moves with it when the dating is corrected.
              </caption>
              <thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
                <tr>
                  <th scope="col" className="py-2">
                    ANC no.
                  </th>
                  <th scope="col">Gestation</th>
                  <th scope="col">Formula</th>
                  <th scope="col">Dating</th>
                  <th scope="col">Rh</th>
                  <th scope="col">Overdue</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((pregnancy) => (
                  <tr key={pregnancy.id} className="border-t border-default">
                    <td className="py-2 font-mono text-xs">{pregnancy.ancNo}</td>
                    <td>
                      <Badge tone={pregnancy.trimester === 3 ? 'accent' : 'neutral'}>
                        {pregnancy.gaLabel}
                      </Badge>
                    </td>
                    <td className="font-mono text-xs">{pregnancy.formula}</td>
                    <td>
                      <DatingChip pregnancy={pregnancy} />
                    </td>
                    <td>
                      <AntiDChip status={pregnancy.antiDStatus} rhNegative={pregnancy.rhNegative} />
                    </td>
                    <td>
                      {pregnancy.overdueItems === 0 ? (
                        <span className="text-fg-muted">—</span>
                      ) : (
                        <Badge tone="warning">{pregnancy.overdueItems}</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AsyncPanel>
      </section>

      <section aria-label="Overdue" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Late on the calendar</h2>
        <AsyncPanel
          loading={overdue.isPending}
          error={overdue.error}
          isEmpty={otherOverdue.length === 0}
          skeletonLabel="Loading overdue items"
          skeletonRows={5}
          onRetry={() => void overdue.refetch()}
          empty={
            <EmptyState
              cause="Nothing is late."
              nextAction="Items appear here the day after they fall due, and they move when the dating is corrected rather than staying on the old date."
            />
          }
        >
          <ul className="flex flex-col gap-2 text-sm">
            {otherOverdue.map((item) => (
              <ScheduleLine key={item.id} item={item} />
            ))}
          </ul>
        </AsyncPanel>
      </section>
    </section>
  );
}

/**
 * Where the date came from.
 *
 * A clinician reading a growth chart needs to know whether the dating is a
 * scan, a remembered period, or somebody's judgement — because the third one
 * means the centile they are about to act on is soft.
 */
function DatingChip({ pregnancy }: { readonly pregnancy: PregnancyRow }): React.JSX.Element {
  const tone =
    pregnancy.eddSource === 'usg' ? 'success' : pregnancy.eddSource === 'lmp' ? 'neutral' : 'warning';
  const label = pregnancy.eddSource === 'usg' ? 'scan' : pregnancy.eddSource === 'lmp' ? 'dates' : 'clinical';
  return (
    <span title={pregnancy.eddRationale ?? undefined}>
      <Badge tone={tone}>{label}</Badge>
    </span>
  );
}

function AntiDChip({
  status,
  rhNegative,
}: {
  readonly status: string;
  readonly rhNegative: boolean | null;
}): React.JSX.Element {
  if (rhNegative !== true) return <span className="text-fg-muted">+</span>;
  const tone = status === 'overdue' ? 'danger' : status === 'due' ? 'warning' : 'success';
  return <Badge tone={tone}>anti-D {status}</Badge>;
}

function ScheduleLine({ item }: { readonly item: ScheduleItemRow }): React.JSX.Element {
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border border-default bg-layer-1 p-3">
      <Badge tone={(item.daysOverdue ?? 0) > 28 ? 'danger' : 'warning'}>
        {item.daysOverdue} days overdue
      </Badge>
      <span className="font-medium">{item.name}</span>
      <span className="text-xs text-fg-muted">due at {item.dueGaWeeks} weeks</span>
      <span className="font-mono text-xs text-fg-muted">{new Date(item.dueAt).toLocaleDateString()}</span>
    </li>
  );
}
