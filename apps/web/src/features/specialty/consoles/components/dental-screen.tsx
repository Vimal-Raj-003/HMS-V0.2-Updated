'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { InvestigationsPane } from '@/features/specialty/components/investigations-pane';
import { SpecialtyWorklist } from '@/features/specialty/components/specialty-worklist';
import { useSession } from '@/lib/session-context';
import { getDentalChart, getDentalPlans } from '../api/client';
import { consoleKeys } from '../api/keys';
import type { DentalChartDetail } from '../api/types';

const LANES = [
  { key: 'triage', label: 'Triage' },
  { key: 'chair', label: 'Chair' },
  { key: 'radiograph', label: 'Radiograph' },
  { key: 'hygiene', label: 'Hygiene' },
  { key: 'counselling', label: 'Counselling' },
] as const;

/**
 * FDI notation, laid out as the mouth is.
 *
 * Upper right runs 18→11 and upper left 21→28, so the two quadrants meet at the
 * midline in the middle of the row — which is where they meet in the patient.
 * Getting this backwards is the chart equivalent of a wrong-site marking.
 */
const UPPER = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28] as const;
const LOWER = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38] as const;

/** Condition codes that mean the tooth is not there. */
const ABSENT = new Set(['extraction', 'extracted', 'missing', 'congenitally_absent', 'avulsed']);

interface OpenPatient {
  readonly encounterId: string;
  readonly patientId: string;
  readonly label: string;
}

interface ToothState {
  readonly done?: readonly string[];
  readonly planned?: readonly string[];
  readonly surfaces?: readonly string[];
  readonly lastAt?: string;
}

/**
 * OP-026 — the dental console.
 *
 * ── The odontogram is read-only, because the chart is derived ───────────────
 *
 * There is no "save chart" button on this screen and no endpoint behind one.
 * The chart is rebuilt from the append-only tooth log by a trigger, and the
 * application role holds no write privilege on it at all — so what a clinician
 * does here is record what happened to a tooth, and the mouth redraws itself.
 *
 * ── An absent tooth looks absent ────────────────────────────────────────────
 *
 * A tooth the log says has gone is drawn struck through and cannot be selected
 * for new work. The database refuses it anyway; the screen refusing it first
 * means the dentist does not build a plan around a tooth that is not there and
 * then have it rejected line by line.
 */
export function DentalScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = consoleKeys(hospitalId);

  const [open, setOpen] = useState<OpenPatient | null>(null);

  const chart = useQuery({
    queryKey: keys.dentalChart(open?.patientId ?? 'none'),
    queryFn: ({ signal }) => getDentalChart(open?.patientId ?? '', { signal }),
    enabled: open !== null,
  });

  const plans = useQuery({
    queryKey: keys.dentalPlans(open?.patientId ?? 'open'),
    queryFn: ({ signal }) =>
      getDentalPlans(open === null ? { openOnly: true } : { patientId: open.patientId }, { signal }),
    refetchInterval: 120_000,
  });

  const planRows = plans.data ?? [];

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Dentistry"
        description="The mouth as the log describes it, and the quotation the patient is asked to agree to — one price, fixed once they do."
      />

      <SpecialtyWorklist
        consoleCode="DENTAL"
        lanes={LANES}
        onOpen={(row) => {
          setOpen({
            encounterId: row.encounterId,
            patientId: row.patientId,
            label: row.patientName,
          });
        }}
      />

      {open === null ? (
        <EmptyState
          cause="No patient is open."
          nextAction="Choose somebody from the chair list to see their chart and their plans."
        />
      ) : (
        <AsyncPanel
          loading={chart.isPending}
          error={chart.error}
          isEmpty={chart.data === undefined}
          skeletonLabel="Loading the chart"
          skeletonRows={4}
          onRetry={() => void chart.refetch()}
          empty={
            <EmptyState
              cause="Nothing has been charted for this patient yet."
              nextAction="Record a finding on a tooth; the chart is built from what you record."
            />
          }
        >
          {chart.data === undefined ? null : <Odontogram detail={chart.data} label={open.label} />}
        </AsyncPanel>
      )}

      <section aria-label="Treatment plans" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">
          {open === null ? 'Open treatment plans' : `Treatment plans — ${open.label}`}
        </h2>
        <AsyncPanel
          loading={plans.isPending}
          error={plans.error}
          isEmpty={planRows.length === 0}
          skeletonLabel="Loading treatment plans"
          skeletonRows={4}
          onRetry={() => void plans.refetch()}
          empty={
            <EmptyState
              cause="No treatment plan is open."
              nextAction="Build one from the charted findings, then present it to the patient."
            />
          }
        >
          <ul className="flex flex-col gap-3">
            {planRows.map((plan) => (
              <li key={plan.id} className="rounded-md border border-default bg-layer-1 p-3">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="font-mono text-xs">{plan.planNo}</span>
                  <Badge
                    tone={
                      plan.status === 'cancelled' || plan.status === 'declined'
                        ? 'neutral'
                        : plan.priceLocked
                          ? 'success'
                          : 'accent'
                    }
                  >
                    {plan.status}
                  </Badge>
                  {/* Once accepted, a line's price cannot move. Changing it is a
                      new version of the plan, presented again. */}
                  {plan.priceLocked ? <Badge tone="neutral">prices fixed</Badge> : null}
                  <span className="text-fg-muted">
                    {plan.acceptedTotal > 0
                      ? `accepted ₹${plan.acceptedTotal.toLocaleString('en-IN')} of ₹${plan.total.toLocaleString('en-IN')}`
                      : `₹${plan.total.toLocaleString('en-IN')}`}
                  </span>
                  {plan.acceptedVia === null ? null : (
                    <span className="text-fg-muted">agreed by {plan.acceptedVia.replace('_', ' ')}</span>
                  )}
                </div>
                <ul className="mt-2 flex flex-col gap-1 text-sm">
                  {plan.items.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-baseline gap-2">
                      <span className="font-mono text-xs text-fg-muted">{item.procedureCode}</span>
                      <span>{item.description}</span>
                      {item.teeth.length > 0 ? (
                        <span className="font-mono text-xs">{item.teeth.join(', ')}</span>
                      ) : null}
                      <span className="text-fg-muted">₹{item.lineTotal.toLocaleString('en-IN')}</span>
                      <Badge tone={item.status === 'declined' ? 'neutral' : 'neutral'} size="sm">
                        {item.status}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </AsyncPanel>
      </section>

      {open === null ? null : (
        <InvestigationsPane consoleCode="DENTAL" encounterId={open.encounterId} patientId={open.patientId} />
      )}
    </section>
  );
}

function Odontogram({
  detail,
  label,
}: {
  readonly detail: DentalChartDetail;
  readonly label: string;
}): React.JSX.Element {
  const state = (detail.chart?.state ?? {}) as Record<string, ToothState>;

  const tooth = (fdi: number) => {
    const entry = state[String(fdi)];
    const done = entry?.done ?? [];
    const planned = entry?.planned ?? [];
    return {
      absent: done.some((code) => ABSENT.has(code.toLowerCase())),
      done,
      planned,
      touched: done.length > 0 || planned.length > 0,
    };
  };

  return (
    <section aria-label={`Odontogram for ${label}`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold">Chart — {label}</h2>
        {detail.chart === null ? null : (
          <>
            <Badge tone="neutral">DMFT {detail.chart.dmft ?? 0}</Badge>
            <span className="text-xs text-fg-muted">
              rebuilt from the log {new Date(detail.chart.rebuiltAt).toLocaleString()}
            </span>
          </>
        )}
      </div>

      {([UPPER, LOWER] as const).map((arch, index) => (
        <div key={index === 0 ? 'upper' : 'lower'} className="overflow-x-auto">
          <ul className="flex min-w-max gap-1" aria-label={index === 0 ? 'Upper arch' : 'Lower arch'}>
            {arch.map((fdi) => {
              const t = tooth(fdi);
              return (
                <li
                  key={fdi}
                  title={
                    t.absent
                      ? `Tooth ${fdi}: absent — no new work can be charted on it`
                      : [...t.done, ...t.planned.map((p) => `${p} (planned)`)].join(', ') || `Tooth ${fdi}`
                  }
                  className={[
                    'flex h-12 w-9 flex-col items-center justify-center rounded border text-xs',
                    t.absent
                      ? 'border-default bg-layer-3 text-fg-muted line-through'
                      : t.planned.length > 0
                        ? 'border-accent-border bg-accent-surface text-accent-on-surface'
                        : t.done.length > 0
                          ? 'border-warning-border bg-warning-surface text-warning-on-surface'
                          : 'border-default bg-layer-1',
                  ].join(' ')}
                >
                  <span className="font-mono">{fdi}</span>
                  {t.touched ? (
                    <span aria-hidden className="text-3xs">
                      {t.planned.length > 0 ? '•' : '▪'}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      <p className="text-xs text-fg-muted">
        Struck through means the log records the tooth as absent — nothing new can be charted on it except an
        implant, a pontic or a denture tooth. This chart is rebuilt from the tooth log; there is no way to
        edit it directly.
      </p>
    </section>
  );
}
