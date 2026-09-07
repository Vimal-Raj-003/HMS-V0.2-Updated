'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { InvestigationsPane } from '@/features/specialty/components/investigations-pane';
import { SpecialtyWorklist } from '@/features/specialty/components/specialty-worklist';
import { useSession } from '@/lib/session-context';
import { getVisit, getVisits } from '../api/client';
import { ophthaKeys } from '../api/keys';
import { ExaminationPanel } from './examination-panel';
import { PrescriptionPanel } from './prescription-panel';
import { RefractionPanel } from './refraction-panel';

/**
 * The lanes a patient walks in an eye clinic, in order.
 *
 * The worklist advances along this list, so `Ctrl+Shift+D` means "send them to
 * the next one" — which on a refraction lane is the whole interaction.
 */
const LANES = [
  { key: 'refraction', label: 'Refraction' },
  { key: 'dilating', label: 'Dilating' },
  { key: 'doctor', label: 'Doctor' },
  { key: 'imaging', label: 'Imaging' },
  { key: 'counselling', label: 'Counselling' },
] as const;

const TABS = [
  { key: 'refraction', label: 'Refraction' },
  { key: 'examination', label: 'Examination' },
  { key: 'investigations', label: 'Investigations' },
  { key: 'prescription', label: 'Prescription & surgery' },
] as const;

/**
 * OP-025 — the eye clinic, and the first console on the framework.
 *
 * ── The worklist and the investigations pane are not ours ───────────────────
 *
 * `SpecialtyWorklist` and `InvestigationsPane` come from the framework
 * unchanged. That is the point of the phase: `phase-08` calls a console that
 * ships its own worklist or its own upload path a defect, and the way to keep
 * that honest is for the first console to import both rather than write
 * something that looks nicer for eyes.
 *
 * ── What is ours is the eye ─────────────────────────────────────────────────
 *
 * The refraction grid, the acuity ladder, the retinopathy grade, the lens
 * calculation. Those have no generic form, which is exactly why they are typed
 * tables in `specialty` rather than a dynamic form.
 */
export function EyeClinicScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = ophthaKeys(hospitalId);

  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<string>('refraction');

  const visits = useQuery({
    queryKey: keys.visits('open'),
    queryFn: ({ signal }) => getVisits({ openOnly: true }, { signal }),
    refetchInterval: 60_000,
  });

  const detail = useQuery({
    queryKey: keys.visit(openId ?? 'none'),
    queryFn: ({ signal }) => getVisit(openId ?? '', { signal }),
    enabled: openId !== null,
  });

  const rows = visits.data ?? [];
  const open = detail.data;

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Eye clinic"
        description="The refraction lane, the examination and what each patient is waiting on — one console over the same chart."
      />

      <SpecialtyWorklist
        consoleCode="OPHTHA"
        lanes={LANES}
        onOpen={(row) => {
          const match = rows.find((v) => v.encounterId === row.encounterId);
          if (match !== undefined) {
            setOpenId(match.id);
            setTab('refraction');
          }
        }}
      />

      <AsyncPanel
        loading={visits.isPending}
        error={visits.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading eye visits"
        skeletonRows={4}
        onRetry={() => {
          void visits.refetch();
        }}
        empty={
          <EmptyState
            cause="No eye visit is open."
            nextAction="A visit opens when a patient checked in to an eye department is seen. Open one from the worklist above."
          />
        }
      >
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm" data-testid="ophtha-visits">
            <caption className="px-3 py-2 text-start text-2xs uppercase tracking-[0.08em] text-fg-subtle">
              Eye visits in progress
            </caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {['Opened', 'Lane', 'Dilated', 'Highest pressure', ''].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 text-start">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr
                  key={v.id}
                  className={`border-b border-default last:border-0 ${openId === v.id ? 'bg-layer-2' : ''}`}
                  data-testid={`ophtha-visit-${v.id}`}
                >
                  <td className="px-3 py-2 font-mono text-2xs">
                    {v.createdAt.slice(0, 16).replace('T', ' ')}
                  </td>
                  <td className="px-3 py-2 text-2xs">{v.stage}</td>
                  <td className="px-3 py-2 text-2xs">
                    {v.dilatedAt === null ? '—' : <Badge tone="warning">{v.dilatingDrug ?? 'dilated'}</Badge>}
                  </td>
                  <td className="px-3 py-2">
                    {v.highestIop === null ? (
                      <span className="text-2xs text-fg-muted">—</span>
                    ) : v.highestIop >= 30 ? (
                      <Badge tone="danger">{`${v.highestIop.toFixed(1)} mmHg`}</Badge>
                    ) : v.highestIop >= 22 ? (
                      <Badge tone="warning">{`${v.highestIop.toFixed(1)} mmHg`}</Badge>
                    ) : (
                      <span className="font-mono text-2xs">{`${v.highestIop.toFixed(1)} mmHg`}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setOpenId(v.id);
                        setTab('refraction');
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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1">
              {TABS.map((t) => (
                <Button
                  key={t.key}
                  size="sm"
                  variant={tab === t.key ? 'primary' : 'secondary'}
                  onClick={() => {
                    setTab(t.key);
                  }}
                >
                  {t.label}
                </Button>
              ))}
            </div>
            {open.visit.signedAt === null ? null : <Badge tone="success">signed</Badge>}
          </div>

          {tab === 'refraction' ? <RefractionPanel detail={open} /> : null}
          {tab === 'examination' ? <ExaminationPanel detail={open} /> : null}
          {tab === 'investigations' ? (
            <InvestigationsPane
              consoleCode="OPHTHA"
              encounterId={open.visit.encounterId}
              patientId={open.visit.patientId}
            />
          ) : null}
          {tab === 'prescription' ? <PrescriptionPanel detail={open} /> : null}
        </div>
      )}

      <p className="text-2xs text-fg-subtle">
        The worklist and the investigations pane are the framework’s, shared with every other console. What is
        specific to eyes — the refraction grid, the acuity ladder, the retinopathy grade, the lens calculation
        — is this console’s own.
      </p>
    </section>
  );
}
