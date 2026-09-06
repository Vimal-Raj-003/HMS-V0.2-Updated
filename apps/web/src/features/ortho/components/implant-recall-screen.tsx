'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Label } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { closeRecall, getRecall, getRecalls, recordRecallContact, traceImplants } from '../api/client';
import { orthoKeys } from '../api/keys';
import type { RecallCaseView, RecallView, TraceResult } from '../api/types';

const SEVERITY_TONE: Readonly<Record<string, 'danger' | 'warning' | 'info' | 'neutral'>> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'info',
};

const RESPONSE_TONE: Readonly<Record<string, 'danger' | 'warning' | 'success' | 'neutral'>> = {
  pending: 'danger',
  unreachable: 'warning',
  declined: 'warning',
  informed: 'success',
  reviewed: 'success',
  revised: 'success',
  deceased: 'neutral',
};

const RESPONSES = [
  'pending',
  'informed',
  'reviewed',
  'revised',
  'declined',
  'unreachable',
  'deceased',
] as const;

const selectClass = 'h-10 rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';
const inputClass = 'h-10 w-full rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

/**
 * TR-003 — the recall desk.
 *
 * ── The trace is a form, not a link ─────────────────────────────────────────
 *
 * Running it writes an audit row naming who ran it and why, so it cannot be a
 * thing that happens when a page loads. The reason box is required by the
 * screen for the same reason the server requires it: a list of patients
 * produced from a device identifier should have a stated purpose attached.
 *
 * ── The unscanned count is shown next to the total, always ──────────────────
 *
 * "11 patients" reads as a complete answer. "11 patients, 4 entered by hand"
 * says the list is 11 patients *and* four serials that were typed by somebody
 * and might not be the serials that were used. That second number is the
 * confidence interval on the recall, and hiding it makes a short list look
 * finished.
 *
 * ── Pending is red, and it is what the list sorts on ────────────────────────
 *
 * A recall's failure mode is not being wrong, it is being forgotten while three
 * people remain uncontacted. The register puts open notices first and pending
 * patients at the top of each one.
 */
export function ImplantRecallScreen(): React.JSX.Element {
  const { hospitalId } = useSession();
  const keys = orthoKeys(hospitalId);
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<string | null>(null);

  const [lotNo, setLotNo] = useState('');
  const [udiDi, setUdiDi] = useState('');
  const [inSituOnly, setInSituOnly] = useState(false);
  const [traceReason, setTraceReason] = useState('');
  const [trace, setTrace] = useState<TraceResult | null>(null);

  const recalls = useQuery({
    queryKey: keys.recalls(),
    queryFn: ({ signal }) => getRecalls({ signal }),
  });
  const rows: readonly RecallView[] = recalls.data?.items ?? [];

  const detail = useQuery({
    queryKey: keys.recall(selected ?? 'none'),
    queryFn: ({ signal }) => getRecall(selected ?? '', { signal }),
    enabled: selected !== null,
  });

  const runTrace = useMutation({
    mutationFn: () =>
      traceImplants(
        {
          ...(lotNo.trim() === '' ? {} : { lotNo: lotNo.trim() }),
          ...(udiDi.trim() === '' ? {} : { udiDi: udiDi.trim() }),
          inSituOnly,
        },
        traceReason.trim(),
      ),
    onSuccess: (result) => {
      setTrace(result);
    },
  });

  const contact = useMutation({
    mutationFn: (input: { readonly caseId: string; readonly response: string; readonly notes: string }) =>
      recordRecallContact(selected ?? '', input.caseId, {
        response: input.response,
        notifiedPatient: input.response !== 'pending' && input.response !== 'unreachable',
        ...(input.notes.trim() === '' ? {} : { notes: input.notes.trim() }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.recall(selected ?? 'none') });
      void queryClient.invalidateQueries({ queryKey: keys.recalls() });
    },
  });

  const close = useMutation({
    mutationFn: () => closeRecall(selected ?? ''),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.recall(selected ?? 'none') });
      void queryClient.invalidateQueries({ queryKey: keys.recalls() });
    },
  });

  const traceReady = traceReason.trim().length >= 12 && (lotNo.trim() !== '' || udiDi.trim() !== '');

  return (
    <section className="flex flex-col gap-6">
      <PageHeader
        title="Implant recalls"
        description="Given a device identifier or a lot number, exactly who is carrying it — with the count of records that were typed rather than scanned."
      />

      {/* ── The trace ─────────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-strong bg-layer-1 p-4">
        <h2 className="text-sm font-semibold text-fg-default">Trace a device</h2>
        <p className="mt-1 text-2xs text-fg-subtle">
          This produces a list of patients. Running it is recorded with your name and your reason.
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="trace-lot">Lot number</Label>
            <input
              id="trace-lot"
              className={inputClass}
              value={lotNo}
              placeholder="LOT-2026-A14"
              onChange={(e) => {
                setLotNo(e.target.value);
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="trace-udi">Device identifier (UDI-DI)</Label>
            <input
              id="trace-udi"
              className={inputClass}
              value={udiDi}
              placeholder="08717648200274"
              onChange={(e) => {
                setUdiDi(e.target.value);
              }}
            />
          </div>
          <div className="flex flex-col gap-1 sm:col-span-2">
            <Label htmlFor="trace-reason">Why you are running this</Label>
            <input
              id="trace-reason"
              className={inputClass}
              value={traceReason}
              placeholder="Field safety notice FSN/… names this lot"
              onChange={(e) => {
                setTraceReason(e.target.value);
              }}
            />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-4">
          <label className="flex min-h-12 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-5"
              checked={inSituOnly}
              onChange={(e) => {
                setInSituOnly(e.target.checked);
              }}
            />
            Exclude devices already removed
          </label>
          <Button
            type="button"
            disabled={!traceReady || runTrace.isPending}
            onClick={() => {
              runTrace.mutate();
            }}
          >
            {runTrace.isPending ? 'Tracing…' : 'Trace'}
          </Button>
          {traceReady ? null : (
            <span className="text-2xs text-fg-subtle">
              Needs a lot or a device identifier, and a reason of at least twelve characters.
            </span>
          )}
        </div>

        {runTrace.error === null ? null : <ProblemCard error={runTrace.error} />}

        {trace === null ? null : (
          <div className="mt-4">
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="text-lg font-semibold text-fg-default">
                {trace.total} {trace.total === 1 ? 'patient' : 'patients'}
              </span>
              <span className="text-sm text-fg-muted">{trace.inSitu} still carrying it</span>
              {/* The confidence interval on the list, never hidden. */}
              {trace.manualEntries > 0 ? (
                <Badge tone="warning">
                  {`${String(trace.manualEntries)} entered by hand — those serials were typed, not scanned`}
                </Badge>
              ) : (
                <Badge tone="success">every record scanned</Badge>
              )}
            </div>

            {trace.total === 0 ? (
              <p className="mt-3 text-sm text-fg-muted">
                No device matching that identifier has been recorded into a patient here.
              </p>
            ) : (
              <div className="mt-3 overflow-x-auto rounded-md border border-default">
                <table className="w-full text-sm" data-testid="implant-trace">
                  <caption className="sr-only">Patients carrying the traced device</caption>
                  <thead>
                    <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                      {['Serial', 'Lot', 'Device', 'Side', 'Implanted', 'State', 'Record'].map((h) => (
                        <th key={h} scope="col" className="px-3 py-2 text-start">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {trace.rows.map((r) => (
                      <tr key={r.usageId} className="border-b border-default last:border-0">
                        <td className="px-3 py-2 font-mono text-2xs">{r.serialNo ?? '—'}</td>
                        <td className="px-3 py-2 font-mono text-2xs">{r.lotNo ?? '—'}</td>
                        <td className="px-3 py-2">{r.description}</td>
                        <td className="px-3 py-2">
                          <Badge
                            tone={r.side === 'right' ? 'danger' : r.side === 'left' ? 'info' : 'neutral'}
                          >
                            {(r.side ?? 'not stated').replace('_', ' ')}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 font-mono text-2xs">{r.implantedAt.slice(0, 10)}</td>
                        <td className="px-3 py-2">
                          {r.explantedAt === null ? (
                            <Badge tone="warning">in situ</Badge>
                          ) : (
                            <span className="text-2xs text-fg-subtle">
                              removed {r.explantedAt.slice(0, 10)}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {r.scanned ? (
                            <span className="text-2xs text-fg-subtle">scanned</span>
                          ) : (
                            <Badge tone="warning">typed</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── The register ──────────────────────────────────────────────────── */}
      <AsyncPanel
        loading={recalls.isPending}
        error={recalls.error}
        isEmpty={rows.length === 0}
        skeletonLabel="Loading the recall register"
        skeletonRows={4}
        onRetry={() => {
          void recalls.refetch();
        }}
        empty={
          <EmptyState
            cause="No field safety notices on this register."
            nextAction="Open one when a manufacturer issues it — the patient list is built at the same moment."
          />
        }
      >
        <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
          <table className="w-full text-sm" data-testid="recall-register">
            <caption className="sr-only">Recall register</caption>
            <thead>
              <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {['Reference', 'Device', 'Severity', 'Issued', 'Patients', 'Pending', 'State', ''].map(
                  (h) => (
                    <th key={h} scope="col" className="px-3 py-2 text-start">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-default last:border-0"
                  data-testid={`recall-${r.id}`}
                >
                  <td className="px-3 py-2 font-mono text-2xs">{r.reference}</td>
                  <td className="px-3 py-2">
                    {r.manufacturer}
                    {r.lotNos.length === 0 ? null : (
                      <div className="font-mono text-2xs text-fg-subtle">{r.lotNos.join(', ')}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={SEVERITY_TONE[r.severity] ?? 'neutral'}>{r.severity}</Badge>
                  </td>
                  <td className="px-3 py-2 font-mono text-2xs">{r.issuedOn.slice(0, 10)}</td>
                  <td className="px-3 py-2 font-mono text-2xs">{r.patients}</td>
                  <td className="px-3 py-2">
                    {r.pending > 0 ? (
                      <Badge tone="danger">{`${String(r.pending)} unaccounted for`}</Badge>
                    ) : (
                      <Badge tone="success">all accounted for</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {r.closedAt === null ? (
                      <Badge tone="warning">open</Badge>
                    ) : (
                      <span className="text-2xs text-fg-subtle">closed {r.closedAt.slice(0, 10)}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        setSelected(r.id === selected ? null : r.id);
                      }}
                    >
                      {r.id === selected ? 'Hide' : 'Work it'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AsyncPanel>

      {/* ── One notice, patient by patient ────────────────────────────────── */}
      {selected === null ? null : (
        <AsyncPanel
          loading={detail.isPending}
          error={detail.error}
          isEmpty={false}
          skeletonLabel="Loading the recall"
          skeletonRows={5}
          onRetry={() => {
            void detail.refetch();
          }}
          empty={null}
        >
          {detail.data === undefined ? null : (
            <div className="flex flex-col gap-4 rounded-lg border border-strong bg-layer-1 p-4">
              <div>
                <h2 className="text-sm font-semibold text-fg-default">{detail.data.reference}</h2>
                <p className="mt-1 text-sm text-fg-muted">{detail.data.summary}</p>
                <p className="mt-2 text-sm text-fg-default">
                  <span className="text-2xs uppercase tracking-[0.08em] text-fg-subtle">Action required</span>
                  <br />
                  {detail.data.actionRequired}
                </p>
              </div>

              <RecallCases
                cases={detail.data.cases}
                busy={contact.isPending}
                onRecord={(caseId, response, notes) => {
                  contact.mutate({ caseId, response, notes });
                }}
              />

              {contact.error === null ? null : <ProblemCard error={contact.error} />}
              {close.error === null ? null : <ProblemCard error={close.error} />}

              <div className="flex flex-wrap items-center gap-3 border-t border-default pt-3">
                <Button
                  type="button"
                  disabled={detail.data.closedAt !== null || close.isPending}
                  onClick={() => {
                    close.mutate();
                  }}
                >
                  {detail.data.closedAt === null ? 'Close this notice' : 'Closed'}
                </Button>
                <span className="text-2xs text-fg-subtle">
                  {detail.data.pending > 0
                    ? `${String(detail.data.pending)} patient(s) are still unaccounted for. Closing now closes it with people uninformed, and the register refuses.`
                    : 'Everybody on this notice has been accounted for.'}
                </span>
              </div>
            </div>
          )}
        </AsyncPanel>
      )}
    </section>
  );
}

function RecallCases({
  cases,
  busy,
  onRecord,
}: {
  readonly cases: readonly RecallCaseView[];
  readonly busy: boolean;
  readonly onRecord: (caseId: string, response: string, notes: string) => void;
}): React.JSX.Element {
  const [drafts, setDrafts] = useState<Readonly<Record<string, { response: string; notes: string }>>>({});

  function draft(id: string, current: string): { response: string; notes: string } {
    return drafts[id] ?? { response: current, notes: '' };
  }

  return (
    <div className="overflow-x-auto rounded-md border border-default">
      <table className="w-full text-sm" data-testid="recall-cases">
        <caption className="sr-only">Patients on this recall</caption>
        <thead>
          <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
            {['Serial / lot', 'Implanted', 'State', 'Attempts', 'Response', 'What happened', ''].map((h) => (
              <th key={h} scope="col" className="px-3 py-2 text-start">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => {
            const d = draft(c.id, c.response);
            return (
              <tr key={c.id} className="border-b border-default last:border-0">
                <td className="px-3 py-2 font-mono text-2xs">{c.serialNo ?? c.lotNo ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-2xs">{c.implantedAt.slice(0, 10)}</td>
                <td className="px-3 py-2">
                  {c.explantedAt === null ? (
                    <Badge tone="warning">in situ</Badge>
                  ) : (
                    <span className="text-2xs text-fg-subtle">removed</span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-2xs">{c.contactAttempts}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-1">
                    <Badge tone={RESPONSE_TONE[c.response] ?? 'neutral'}>{c.response}</Badge>
                    <select
                      aria-label="Response"
                      className={selectClass}
                      value={d.response}
                      onChange={(e) => {
                        setDrafts({ ...drafts, [c.id]: { ...d, response: e.target.value } });
                      }}
                    >
                      {RESPONSES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    {d.response === 'unreachable' && c.contactAttempts < 1 ? (
                      <span className="text-2xs text-fg-subtle">
                        Unreachable needs two recorded attempts. Record this one as still pending first.
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <input
                    aria-label="What happened"
                    className={inputClass}
                    value={d.notes}
                    placeholder="Phone rang out, 11:20"
                    onChange={(e) => {
                      setDrafts({ ...drafts, [c.id]: { ...d, notes: e.target.value } });
                    }}
                  />
                </td>
                <td className="px-3 py-2">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      onRecord(c.id, d.response, d.notes);
                      setDrafts({ ...drafts, [c.id]: { response: d.response, notes: '' } });
                    }}
                  >
                    Record
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
