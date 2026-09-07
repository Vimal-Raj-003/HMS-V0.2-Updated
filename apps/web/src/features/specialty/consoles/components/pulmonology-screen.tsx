'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { InvestigationsPane } from '@/features/specialty/components/investigations-pane';
import { SpecialtyWorklist } from '@/features/specialty/components/specialty-worklist';
import { useSession } from '@/lib/session-context';
import { getPapRx, getPfts, getSleepStudies } from '../api/client';
import { consoleKeys } from '../api/keys';
import type { PftRow } from '../api/types';

const LANES = [
  { key: 'triage', label: 'Triage' },
  { key: 'pft', label: 'Lung function' },
  { key: 'doctor', label: 'Doctor' },
  { key: 'bronchoscopy', label: 'Bronchoscopy' },
  { key: 'counselling', label: 'Counselling' },
] as const;

interface OpenPatient {
  readonly encounterId: string;
  readonly patientId: string;
  readonly label: string;
}

/**
 * OP-030 — the pulmonology console.
 *
 * ── The derived numbers are shown as derived ────────────────────────────────
 *
 * The ratio, the reversibility and the apnoea severity are the diagnosis, and
 * every one of them is a trigger's output. The table labels them so a
 * technician can see that the column with no input box is the column that
 * decides — which is a better explanation of the design than a tooltip.
 *
 * ── An unacceptable effort is shown before it is refused ────────────────────
 *
 * A grade F study carries a chip saying it cannot be signed, so the technician
 * repeats the manoeuvre while the patient is still in the room rather than
 * discovering it when a doctor tries to sign an hour later.
 */
export function PulmonologyScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = consoleKeys(hospitalId);

  const [open, setOpen] = useState<OpenPatient | null>(null);
  const scope = open?.patientId ?? 'all';

  const studies = useQuery({
    queryKey: keys.pfts(scope),
    queryFn: ({ signal }) => getPfts(open === null ? {} : { patientId: open.patientId }, { signal }),
    refetchInterval: 120_000,
  });

  const sleep = useQuery({
    queryKey: keys.sleepStudies(scope),
    queryFn: ({ signal }) =>
      getSleepStudies(open === null ? { openOnly: true } : { patientId: open.patientId }, { signal }),
    refetchInterval: 120_000,
  });

  const pap = useQuery({
    queryKey: keys.papRx(scope),
    queryFn: ({ signal }) => getPapRx(open === null ? {} : { patientId: open.patientId }, { signal }),
    enabled: open !== null,
  });

  const pfts = studies.data ?? [];
  const nights = sleep.data ?? [];
  const machines = pap.data ?? [];

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Pulmonology & sleep"
        description="Lung function, sleep studies and the machines patients go home with — the numbers that decide, derived from the ones the device produced."
      />

      <SpecialtyWorklist
        consoleCode="PULMO"
        lanes={LANES}
        onOpen={(row) => {
          setOpen({
            encounterId: row.encounterId,
            patientId: row.patientId,
            label: row.patientName,
          });
        }}
      />

      <section aria-label="Lung function" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">
          {open === null ? 'Recent lung function studies' : `Lung function — ${open.label}`}
        </h2>
        <AsyncPanel
          loading={studies.isPending}
          error={studies.error}
          isEmpty={pfts.length === 0}
          skeletonLabel="Loading lung function studies"
          skeletonRows={5}
          onRetry={() => void studies.refetch()}
          empty={
            <EmptyState
              cause="No spirometry has been recorded here yet."
              nextAction="Run a manoeuvre at the machine, or attach a study through the investigations pane."
            />
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-sm">
              <caption className="sr-only">
                Lung function studies. FEV1/FVC, the bronchodilator response and whether it is significant are
                computed from the litres the device produced.
              </caption>
              <thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
                <tr>
                  <th scope="col" className="py-2">
                    Performed
                  </th>
                  <th scope="col">Effort</th>
                  <th scope="col">FVC</th>
                  <th scope="col">FEV1</th>
                  <th scope="col" title="Derived">
                    Ratio
                  </th>
                  <th scope="col" title="Derived">
                    Post-BD change
                  </th>
                  <th scope="col" title="Derived">
                    Reversible
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {pfts.map((study) => (
                  <tr key={study.id} className="border-t border-default">
                    <td className="py-2 font-mono text-xs">{new Date(study.performedAt).toLocaleString()}</td>
                    <td>
                      <EffortChip study={study} />
                    </td>
                    <td>{study.preFvc ?? '—'}</td>
                    <td>{study.preFev1 ?? '—'}</td>
                    <td>
                      {study.preRatio === null ? (
                        '—'
                      ) : (
                        <Badge tone={study.obstructed === true ? 'warning' : 'neutral'}>
                          {study.preRatio.toFixed(2)}
                          {study.obstructed === true ? ' · obstructed' : ''}
                        </Badge>
                      )}
                    </td>
                    <td>
                      {study.revFev1Ml === null ? '—' : `${study.revFev1Pct ?? 0}% · ${study.revFev1Ml} mL`}
                    </td>
                    <td>
                      {study.reversible === null ? (
                        '—'
                      ) : (
                        <Badge tone={study.reversible ? 'accent' : 'neutral'}>
                          {study.reversible ? 'yes' : 'no'}
                        </Badge>
                      )}
                    </td>
                    <td>
                      <Badge tone={study.signedAt === null ? 'neutral' : 'success'}>{study.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AsyncPanel>
      </section>

      <section aria-label="Sleep studies" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">
          {open === null ? 'Sleep studies awaiting a report' : `Sleep studies — ${open.label}`}
        </h2>
        <AsyncPanel
          loading={sleep.isPending}
          error={sleep.error}
          isEmpty={nights.length === 0}
          skeletonLabel="Loading sleep studies"
          skeletonRows={4}
          onRetry={() => void sleep.refetch()}
          empty={
            <EmptyState
              cause="No sleep study is waiting."
              nextAction="Book a night in the laboratory, or issue a home test from the device list."
            />
          }
        >
          <ul className="flex flex-col gap-2">
            {nights.map((study) => (
              <li
                key={study.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-default bg-layer-1 p-3 text-sm"
              >
                <Badge tone="neutral">{study.type.toUpperCase()}</Badge>
                <span className="font-mono text-xs">{new Date(study.scheduledAt).toLocaleString()}</span>
                <span>AHI {study.ahi ?? '—'}</span>
                {/* Derived from the index. An insurer, a supplier and a licensing
                    authority all read this word. */}
                {study.severity === null ? null : (
                  <Badge
                    tone={
                      study.severity === 'severe'
                        ? 'danger'
                        : study.severity === 'moderate'
                          ? 'warning'
                          : 'neutral'
                    }
                  >
                    {study.severity}
                  </Badge>
                )}
                <Badge tone={study.signedAt === null ? 'neutral' : 'success'}>{study.status}</Badge>
              </li>
            ))}
          </ul>
        </AsyncPanel>
      </section>

      {open === null ? null : (
        <>
          <section aria-label="Positive airway pressure" className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">Machines — {open.label}</h2>
            {machines.length === 0 ? (
              <p className="text-sm text-fg-muted">No PAP prescription on file.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {machines.map((rx) => (
                  <li
                    key={rx.id}
                    className="flex flex-wrap items-center gap-3 rounded-md border border-default bg-layer-1 p-3 text-sm"
                  >
                    <Badge tone="accent">{rx.mode.toUpperCase()}</Badge>
                    <span>{describePressures(rx)}</span>
                    <span className="text-fg-muted">{rx.mask ?? 'mask not recorded'}</span>
                    {rx.adherent === null ? null : (
                      <Badge tone={rx.adherent ? 'success' : 'warning'}>
                        {rx.adherent ? 'adherent' : 'below the adherence threshold'}
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <InvestigationsPane consoleCode="PULMO" encounterId={open.encounterId} patientId={open.patientId} />
        </>
      )}
    </section>
  );
}

/**
 * The effort grade, and what it forecloses.
 *
 * An `F` is not a poor result, it is not a result — and saying so here means
 * the manoeuvre is repeated while the patient is still in the room.
 */
function EffortChip({ study }: { readonly study: PftRow }): React.JSX.Element {
  if (study.qualityGrade === null) return <span className="text-fg-muted">—</span>;
  return (
    <Badge tone={study.unsignable ? 'danger' : 'neutral'}>
      {study.qualityGrade}
      {study.unsignable ? ' · cannot be signed' : ''}
    </Badge>
  );
}

/** The pressures the mode actually carries. */
function describePressures(rx: {
  readonly mode: string;
  readonly pressureCm: number | null;
  readonly pressureMin: number | null;
  readonly pressureMax: number | null;
  readonly epap: number | null;
  readonly ipap: number | null;
}): string {
  if (rx.mode === 'cpap') return `${rx.pressureCm ?? '—'} cm H₂O`;
  if (rx.mode === 'apap') return `${rx.pressureMin ?? '—'}–${rx.pressureMax ?? '—'} cm H₂O`;
  return `EPAP ${rx.epap ?? '—'} / IPAP ${rx.ipap ?? '—'} cm H₂O`;
}
