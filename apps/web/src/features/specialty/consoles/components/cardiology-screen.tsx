'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { InvestigationsPane } from '@/features/specialty/components/investigations-pane';
import { SpecialtyWorklist } from '@/features/specialty/components/specialty-worklist';
import { useSession } from '@/lib/session-context';
import { acknowledgeEcg, getEcgs } from '../api/client';
import { consoleKeys } from '../api/keys';
import type { EcgRow } from '../api/types';

const LANES = [
  { key: 'triage', label: 'Triage' },
  { key: 'ecg', label: 'ECG' },
  { key: 'doctor', label: 'Doctor' },
  { key: 'echo', label: 'Echo' },
  { key: 'counselling', label: 'Counselling' },
] as const;

interface OpenPatient {
  readonly encounterId: string;
  readonly patientId: string;
  readonly label: string;
}

/**
 * OP-029 — the cardiology console.
 *
 * ── The handover rail is above everything ───────────────────────────────────
 *
 * A cardiology department produces a tracing every few minutes, and the only
 * question that matters across a list of them is which ones nobody has been
 * told about. So unacknowledged criticals sit above the worklist, and the
 * handover form is on the row rather than two clicks inside it — the failure
 * this exists to prevent is somebody meaning to come back to it.
 *
 * ── The screen shows the QTc; it never asks for one ─────────────────────────
 *
 * There is no input for a corrected interval anywhere in this console. Bazett
 * runs in a trigger and `qtcProlonged` arrives with the row, so the chip here
 * and the pharmacy's interaction check are reading one number. A second
 * implementation in the client is exactly how they would come to disagree.
 */
export function CardiologyScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = consoleKeys(hospitalId);
  const qc = useQueryClient();

  const [open, setOpen] = useState<OpenPatient | null>(null);
  const [acknowledging, setAcknowledging] = useState<string | null>(null);
  const [toldTo, setToldTo] = useState('');

  const waiting = useQuery({
    queryKey: keys.ecgs('unacknowledged'),
    queryFn: ({ signal }) => getEcgs({ unacknowledgedOnly: true }, { signal }),
    refetchInterval: 30_000,
  });

  const tracings = useQuery({
    queryKey: keys.ecgs(open?.patientId ?? 'recent'),
    queryFn: ({ signal }) => getEcgs(open === null ? {} : { patientId: open.patientId }, { signal }),
    refetchInterval: 120_000,
  });

  const acknowledge = useMutation({
    mutationFn: (input: { id: string; toldTo: string }) => acknowledgeEcg(input.id, input.toldTo),
    onSuccess: () => {
      setAcknowledging(null);
      setToldTo('');
      void qc.invalidateQueries({ queryKey: keys.ecgsRoot() });
    },
  });

  const unacknowledged = waiting.data ?? [];
  const rows = tracings.data ?? [];

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Cardiology"
        description="Tracings waiting to be handed over, the day's studies, and what each patient is waiting on."
      />

      {unacknowledged.length > 0 ? (
        <section
          aria-label="Critical tracings awaiting handover"
          className="rounded-lg border border-danger bg-danger-subtle p-4"
        >
          <h2 className="text-sm font-semibold text-fg-danger">
            {unacknowledged.length} critical {unacknowledged.length === 1 ? 'tracing has' : 'tracings have'}{' '}
            not been handed over
          </h2>
          <p className="mt-1 text-xs text-fg-muted">
            These cannot be signed off until the handover records who was told. A tracing that sat in a queue
            looks, afterwards, exactly like one that was seen.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {unacknowledged.map((ecg) => (
              <li key={ecg.id} className="rounded-md border border-danger bg-layer-1 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="danger">Critical</Badge>
                  <span className="font-mono text-xs">{new Date(ecg.acquiredAt).toLocaleString()}</span>
                  <QtcChip ecg={ecg} />
                  <span className="text-sm">{ecg.readInterp.join('; ') || ecg.machineInterp.join('; ')}</span>
                </div>
                {acknowledging === ecg.id ? (
                  <form
                    className="mt-3 flex flex-wrap items-end gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      acknowledge.mutate({ id: ecg.id, toldTo });
                    }}
                  >
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="font-medium">Who was told</span>
                      <input
                        className="w-72 rounded border border-control bg-layer-1 px-2 py-1 text-sm"
                        value={toldTo}
                        onChange={(event) => setToldTo(event.target.value)}
                        placeholder="Dr Rao, cath lab, by telephone"
                        required
                        minLength={2}
                      />
                    </label>
                    {/* Who did the telling is the session's, so there is no field for it. */}
                    <Button type="submit" size="sm" disabled={acknowledge.isPending}>
                      Record handover
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setAcknowledging(null);
                        setToldTo('');
                      }}
                    >
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <Button
                    className="mt-2"
                    size="sm"
                    variant="danger"
                    onClick={() => setAcknowledging(ecg.id)}
                  >
                    Hand over
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <SpecialtyWorklist
        consoleCode="CARDIO"
        lanes={LANES}
        onOpen={(row) => {
          setOpen({
            encounterId: row.encounterId,
            patientId: row.patientId,
            label: row.patientName,
          });
        }}
      />

      <section aria-label="Tracings" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">
          {open === null ? 'Recent tracings' : `Tracings — ${open.label}`}
        </h2>
        <AsyncPanel
          loading={tracings.isPending}
          error={tracings.error}
          isEmpty={rows.length === 0}
          skeletonLabel="Loading tracings"
          skeletonRows={6}
          onRetry={() => void tracings.refetch()}
          empty={
            <EmptyState
              cause="No ECG has been filed here yet."
              nextAction="Record one from the machine, or attach a tracing through the investigations pane below."
            />
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <caption className="sr-only">
                Filed tracings, most recent first. The corrected interval is derived from the QT and the rate.
              </caption>
              <thead className="text-left text-xs uppercase tracking-wide text-fg-muted">
                <tr>
                  <th scope="col" className="py-2">
                    Acquired
                  </th>
                  <th scope="col">Rate</th>
                  <th scope="col">PR</th>
                  <th scope="col">QRS</th>
                  <th scope="col">QT</th>
                  <th scope="col">QTc</th>
                  <th scope="col">Read</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((ecg) => (
                  <tr key={ecg.id} className="border-t border-default">
                    <td className="py-2 font-mono text-xs">{new Date(ecg.acquiredAt).toLocaleString()}</td>
                    <td>{ecg.hr ?? '—'}</td>
                    <td>{ecg.prMs ?? '—'}</td>
                    <td>{ecg.qrsMs ?? '—'}</td>
                    <td>{ecg.qtMs ?? '—'}</td>
                    <td>
                      <QtcChip ecg={ecg} />
                    </td>
                    <td className="max-w-xs truncate">
                      {ecg.readInterp.join('; ') || (
                        <span className="text-fg-muted">{ecg.machineInterp.join('; ') || 'unread'}</span>
                      )}
                    </td>
                    <td>
                      <Badge tone={ecg.status === 'final' ? 'success' : 'neutral'}>{ecg.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AsyncPanel>
      </section>

      {open === null ? null : (
        <InvestigationsPane consoleCode="CARDIO" encounterId={open.encounterId} patientId={open.patientId} />
      )}
    </section>
  );
}

/**
 * The corrected interval, as the database computed it.
 *
 * Nothing here divides or takes a square root: `qtcMs` and `qtcProlonged` both
 * arrive from the API.
 */
function QtcChip({ ecg }: { readonly ecg: EcgRow }): React.JSX.Element {
  if (ecg.qtcMs === null) return <span className="text-fg-muted">—</span>;
  return (
    <Badge tone={ecg.qtcProlonged ? 'danger' : 'neutral'}>
      {ecg.qtcMs} ms{ecg.qtcProlonged ? ' · prolonged' : ''}
    </Badge>
  );
}
