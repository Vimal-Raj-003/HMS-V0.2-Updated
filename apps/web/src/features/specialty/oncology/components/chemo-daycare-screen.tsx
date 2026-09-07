'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { cosignCycle, getCases, getCycle, getCycles, verifyLine } from '../api/client';
import { oncologyKeys } from '../api/keys';
import type { ChemoCycleRow, CumulativeRow, CycleDetail, OrderLineRow } from '../api/types';

/**
 * OP-031 and IP-023 — the chemotherapy day care.
 *
 * ── The lifetime totals come first, because they arrive slowly ─────────────
 *
 * Everything else on this board is today's problem. A doxorubicin total at
 * four-fifths of its ceiling is a problem in eighteen months — a cardiology
 * opinion and a change of regimen, both of which take weeks to arrange, and
 * neither of which anybody starts on the day the refusal happens.
 *
 * ── Then the pharmacy queue, because a patient is sitting in a chair ───────
 *
 * A queried dose is not paperwork. It is somebody in a day-care chair with a
 * cannula in, waiting for an oncologist who is on a ward round.
 *
 * ── And every dose shows its arithmetic ────────────────────────────────────
 *
 * "1.4 mg/m² × 1.82 m² = 2.55, capped at 2." A nurse who can see where the
 * number came from can see when it is wrong, and a nurse who is handed a
 * number cannot.
 */
export function ChemoDaycareScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = oncologyKeys(hospitalId);
  const qc = useQueryClient();

  const canVerify = granted.has('onco.pharmacy.verify');
  const canCosign = granted.has('onco.cycle.cosign');

  const [openId, setOpenId] = useState<string | null>(null);
  const [queryNote, setQueryNote] = useState('');
  const [queryingLine, setQueryingLine] = useState<string | null>(null);
  const [cosignReason, setCosignReason] = useState('');

  const cycles = useQuery({
    queryKey: keys.cycles('today'),
    queryFn: ({ signal }) => getCycles({}, { signal }),
    refetchInterval: 60_000,
  });

  const nearingCap = useQuery({
    queryKey: keys.cases('nearing-cap'),
    queryFn: ({ signal }) => getCases({ nearingCapOnly: true }, { signal }),
    refetchInterval: 300_000,
  });

  const detail = useQuery({
    queryKey: keys.cycle(openId ?? 'none'),
    queryFn: ({ signal }) => getCycle(openId ?? '', { signal }),
    enabled: openId !== null,
    refetchInterval: 60_000,
  });

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: keys.cyclesRoot() });
    void qc.invalidateQueries({ queryKey: keys.casesRoot() });
    if (openId !== null) void qc.invalidateQueries({ queryKey: keys.cycle(openId) });
  };

  const verify = useMutation({
    mutationFn: (input: { id: string; status: string; notes?: string }) =>
      verifyLine(input.id, input.notes === undefined ? { status: input.status } : input),
    onSuccess: () => {
      setQueryingLine(null);
      setQueryNote('');
      invalidate();
    },
  });

  const cosign = useMutation({
    mutationFn: (input: { id: string; reason: string }) => cosignCycle(input.id, input.reason),
    onSuccess: () => {
      setCosignReason('');
      invalidate();
    },
  });

  const rows = cycles.data ?? [];
  const pharmacyQueue = rows.filter((c) => c.linesPending > 0);
  const needsCosign = rows.filter((c) => c.fitnessFailures.length > 0 && c.secondSignerId === null);
  const caps = (nearingCap.data ?? []).flatMap((c) =>
    c.cumulative.filter((d) => d.approachingCap).map((d) => ({ caseNo: c.caseNo, dose: d })),
  );

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Chemotherapy day care"
        description="Today's cycles, what is waiting on pharmacy, and the lifetime totals that will refuse a dose in eighteen months if nobody starts on them now."
      />

      {caps.length > 0 ? (
        <section
          aria-label="Lifetime doses approaching their ceiling"
          className="rounded-lg border border-warning-border bg-warning-surface p-4"
        >
          <h2 className="text-sm font-semibold text-warning-on-surface">
            {caps.length} lifetime {caps.length === 1 ? 'dose is' : 'doses are'} past four-fifths of the
            ceiling
          </h2>
          <p className="mt-1 text-xs text-warning-on-surface">
            The way past an anthracycline cap is a cardiology opinion and a different regimen, and both take
            weeks. Nobody starts on that on the day the refusal happens, which is why this sits here rather
            than in an error.
          </p>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {caps.map((entry) => (
              <li
                key={`${entry.caseNo}:${entry.dose.drugName}`}
                className="flex flex-wrap items-center gap-3 rounded-md border border-warning-border bg-layer-1 p-3"
              >
                <span className="font-mono text-xs">{entry.caseNo}</span>
                <span className="font-medium">{entry.dose.drugName}</span>
                <CapChip dose={entry.dose} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {needsCosign.length > 0 ? (
        <section
          aria-label="Cycles waiting on a second oncologist"
          className="rounded-lg border border-danger bg-danger-subtle p-4"
        >
          <h2 className="text-sm font-semibold text-fg-danger">
            {needsCosign.length} {needsCosign.length === 1 ? 'cycle needs' : 'cycles need'} a second
            oncologist
          </h2>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {needsCosign.map((cycle) => (
              <li key={cycle.id} className="rounded-md border border-danger bg-layer-1 p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-xs">
                    cycle {cycle.cycleNo} day {cycle.dayNo}
                  </span>
                  <span className="text-fg-danger">{cycle.fitnessFailures.join('; ')}</span>
                </div>
                {canCosign ? (
                  <form
                    className="mt-2 flex flex-wrap items-end gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      cosign.mutate({ id: cycle.id, reason: cosignReason });
                    }}
                  >
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="font-medium">Why this is still the right thing</span>
                      <input
                        className="w-[30rem] rounded border border-control bg-layer-1 px-2 py-1 text-sm"
                        value={cosignReason}
                        onChange={(event) => setCosignReason(event.target.value)}
                        placeholder="Curable disease; marrow will not recover further with more delay."
                        required
                        minLength={8}
                      />
                    </label>
                    <Button type="submit" size="sm" disabled={cosign.isPending}>
                      Countersign
                    </Button>
                  </form>
                ) : (
                  <p className="mt-2 text-xs text-fg-muted">
                    Giving chemotherapy on these counts is sometimes correct. It is a decision a second
                    oncologist takes with the first, in writing.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {pharmacyQueue.length > 0 ? (
        <p className="rounded-md border border-warning-border bg-warning-surface p-3 text-xs text-warning-on-surface">
          {pharmacyQueue.reduce((n, c) => n + c.linesPending, 0)} dose(s) are waiting on pharmacy across{' '}
          {pharmacyQueue.length} cycle(s). Each of those is somebody in a chair with a cannula in.
        </p>
      ) : null}

      <AsyncPanel
        loading={cycles.isPending}
        error={cycles.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading today's cycles"
        skeletonRows={6}
        onRetry={() => void cycles.refetch()}
        empty={
          <EmptyState
            cause="No cycles are scheduled."
            nextAction="Schedule one against a signed plan; the doses come out of the regimen and the patient's own measurements."
          />
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem] text-sm">
            <caption className="sr-only">
              Chemotherapy cycles. Every dose is computed from the plan&rsquo;s body surface area and the
              regimen&rsquo;s own figures.
            </caption>
            <thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
              <tr>
                <th scope="col" className="py-2">
                  Cycle
                </th>
                <th scope="col">Scheduled</th>
                <th scope="col">Status</th>
                <th scope="col">Pharmacy</th>
                <th scope="col">Waiting on</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((cycle) => (
                <tr
                  key={cycle.id}
                  className="cursor-pointer border-t border-default hover:bg-layer-3"
                  onClick={() => setOpenId(cycle.id)}
                >
                  <td className="py-2 font-mono text-xs">
                    {cycle.cycleNo}·{cycle.dayNo}
                  </td>
                  <td className="font-mono text-xs">
                    {new Date(cycle.scheduledAt).toLocaleString([], {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td>
                    <StatusChip cycle={cycle} />
                  </td>
                  <td>
                    {cycle.linesPending === 0 ? (
                      <Badge tone="success">{cycle.linesApproved} approved</Badge>
                    ) : (
                      <Badge tone="warning">{cycle.linesPending} pending</Badge>
                    )}
                  </td>
                  <td className="text-xs text-fg-muted">
                    {cycle.blockedBy.length === 0 ? 'nothing' : cycle.blockedBy[0]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      {openId === null || detail.data === undefined ? null : (
        <Prescription
          detail={detail.data}
          canVerify={canVerify}
          busy={verify.isPending}
          queryingLine={queryingLine}
          queryNote={queryNote}
          onQueryNote={setQueryNote}
          onStartQuery={(id) => {
            setQueryingLine(id);
            setQueryNote('');
          }}
          onCancelQuery={() => {
            setQueryingLine(null);
            setQueryNote('');
          }}
          onVerify={(id, status, notes) =>
            verify.mutate(notes === undefined ? { id, status } : { id, status, notes })
          }
          onClose={() => setOpenId(null)}
        />
      )}
    </section>
  );
}

function StatusChip({ cycle }: { readonly cycle: ChemoCycleRow }): React.JSX.Element {
  const tone =
    cycle.status === 'administered'
      ? 'success'
      : cycle.status === 'deferred' || cycle.status === 'cancelled'
        ? 'neutral'
        : cycle.fitnessFailures.length > 0
          ? 'danger'
          : 'accent';
  return <Badge tone={tone}>{cycle.status.replace(/_/gu, ' ')}</Badge>;
}

function CapChip({ dose }: { readonly dose: CumulativeRow }): React.JSX.Element {
  const pct = dose.capFraction === null ? 0 : Math.round(dose.capFraction * 100);
  return (
    <Badge tone={pct >= 95 ? 'danger' : 'warning'}>
      {dose.totalPerM2} of {dose.cap} {dose.unit}/m² · {pct} %
    </Badge>
  );
}

function Prescription({
  detail,
  canVerify,
  busy,
  queryingLine,
  queryNote,
  onQueryNote,
  onStartQuery,
  onCancelQuery,
  onVerify,
  onClose,
}: {
  readonly detail: CycleDetail;
  readonly canVerify: boolean;
  readonly busy: boolean;
  readonly queryingLine: string | null;
  readonly queryNote: string;
  readonly onQueryNote: (value: string) => void;
  readonly onStartQuery: (id: string) => void;
  readonly onCancelQuery: () => void;
  readonly onVerify: (id: string, status: string, notes?: string) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { cycle, plan, lines } = detail;
  return (
    <section aria-label="The prescription" className="rounded-lg border border-default bg-layer-1 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">
          {plan.regimenName} v{plan.regimenVersion} · cycle {cycle.cycleNo} day {cycle.dayNo}
        </h2>
        <button type="button" onClick={onClose} className="text-sm text-fg-link hover:underline">
          Close
        </button>
      </div>

      {/* The two measurements everything below is computed from. */}
      <p className="mt-1 text-xs text-fg-muted">
        {plan.heightCm} cm, {plan.weightKg} kg → {plan.bsa} m² by {plan.bsaMethod}
        {plan.crcl === null ? null : ` · clearance ${String(plan.crcl)} mL/min`}
      </p>

      {cycle.blockedBy.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1 rounded-md border border-warning-border bg-warning-surface p-3 text-sm">
          {cycle.blockedBy.map((why) => (
            <li key={why} className="text-warning-on-surface">
              {why}
            </li>
          ))}
        </ul>
      ) : null}

      <ul className="mt-4 flex flex-col gap-2">
        {lines.map((line) => (
          <li key={line.id} className="rounded-md border border-default bg-layer-2 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium">{line.drugName}</span>
              <span className="font-mono text-xs">
                {line.finalDose} {line.unit}
              </span>
              {/* Where the number came from. A nurse who can see the arithmetic
                  can see when it is wrong. */}
              <span className="text-xs text-fg-muted">{workingOut(line, plan.bsa)}</span>
              {line.capApplied ? <Badge tone="warning">capped</Badge> : null}
              {line.vesicant ? <Badge tone="danger">vesicant</Badge> : null}
              <Badge tone={line.pharmStatus === 'approved' ? 'success' : 'warning'}>{line.pharmStatus}</Badge>
              {line.administered ? <Badge tone="success">given</Badge> : null}
            </div>

            {line.reductionReason === null ? null : (
              <p className="mt-1 text-xs text-fg-muted">
                reduced {line.reductionPct} % — {line.reductionReason}
              </p>
            )}
            {line.pharmNotes === null ? null : (
              <p className="mt-1 text-xs text-fg-muted">pharmacy: {line.pharmNotes}</p>
            )}

            {canVerify && line.pharmStatus !== 'approved' ? (
              queryingLine === line.id ? (
                <form
                  className="mt-2 flex flex-wrap items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    onVerify(line.id, 'queried', queryNote);
                  }}
                >
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="font-medium">What needs answering</span>
                    <input
                      className="w-[30rem] rounded border border-control bg-layer-1 px-2 py-1 text-sm"
                      value={queryNote}
                      onChange={(event) => onQueryNote(event.target.value)}
                      placeholder="Please confirm the weight — it differs from cycle 1 by 4 kg."
                      required
                      minLength={4}
                    />
                  </label>
                  <Button type="submit" size="sm" variant="secondary" disabled={busy}>
                    Query it
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={onCancelQuery}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy} onClick={() => onVerify(line.id, 'approved')}>
                    Approve
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => onStartQuery(line.id)}>
                    Query
                  </Button>
                </div>
              )
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The arithmetic, spelled out.
 *
 * A dose handed to somebody as a number is a number they cannot check. A dose
 * shown as "1.4 mg/m² × 1.82 m²" is one they can.
 */
function workingOut(line: OrderLineRow, bsa: number | null): string {
  const base =
    line.doseBasis === 'mg_m2' || line.doseBasis === 'mg_m2_capped'
      ? `${String(line.basisValue)} ${line.unit}/m² × ${String(bsa ?? 0)} m²`
      : line.doseBasis === 'mg_kg'
        ? `${String(line.basisValue)} ${line.unit}/kg`
        : line.doseBasis === 'auc'
          ? `AUC ${String(line.basisValue)} × (clearance + 25)`
          : 'flat dose';
  const calc = line.calcDose === null ? '' : ` = ${String(line.calcDose)}`;
  const reduced = line.reductionPct > 0 ? `, less ${String(line.reductionPct)} %` : '';
  return `${base}${calc}${reduced}`;
}
