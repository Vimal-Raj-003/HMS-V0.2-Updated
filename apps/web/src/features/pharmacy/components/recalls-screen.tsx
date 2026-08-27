'use client';

import { useMutation } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, Textarea, useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useCursorList } from '@/features/inventory/lib/cursor-list';
import { OctagonAlert } from '@/lib/icons';
import { useSession } from '@/lib/session-context';
import { closeRecall, listRecalls, raiseRecall, traceRecall } from '../api/client';
import { pharmacyKeys } from '../api/keys';
import type { RecallSource, RecallTraceView, RecallView } from '../api/types';
import { formatInstant, formatQty, humanise } from '../lib/format';
import { patientRef } from './patient-identity-panel';

/**
 * OP-003 §3.4.6 — the recall console, and `phase-04` exit gate 5: "recall a
 * batch → the list of affected patients is produced and notifications go out".
 *
 * ── The order of operations is the safety property ──────────────────────────
 *
 * Raising the recall **quarantines the batch in every store first**, before
 * anybody produces a list. That is the API's behaviour and this screen says so
 * on the form, because the instinct is the other way round — find out who has it,
 * then decide — and in the hour that takes, the next patient gets some.
 *
 * ── Why the trace is a separate button behind a separate permission ─────────
 *
 * The trace produces a list of patients, which is PHI. `pharmacy.recall.trace`
 * gates it separately from `pharmacy.recall.read`, so somebody can run the
 * quarantine without opening the patient list. Both keys are
 * `clinicalSafetyExempt`: a recall does not wait for an invoice.
 */
const SOURCES: readonly { readonly value: RecallSource; readonly label: string }[] = [
  { value: 'cdsco', label: 'CDSCO' },
  { value: 'state_fda', label: 'State FDA' },
  { value: 'manufacturer', label: 'Manufacturer' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'internal', label: 'Internal — our own finding' },
];

const CLASSES: readonly { readonly value: 'class_i' | 'class_ii' | 'class_iii'; readonly label: string }[] = [
  { value: 'class_i', label: 'Class I — reasonable probability of serious harm or death' },
  { value: 'class_ii', label: 'Class II — temporary or reversible harm' },
  { value: 'class_iii', label: 'Class III — unlikely to cause harm' },
];

export function RecallsScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = pharmacyKeys(hospitalId);
  const { publish } = useToast();

  const [raising, setRaising] = useState(false);
  const [source, setSource] = useState<RecallSource>('cdsco');
  const [sourceRef, setSourceRef] = useState('');
  const [itemId, setItemId] = useState('');
  const [batchNo, setBatchNo] = useState('');
  const [recallClass, setRecallClass] = useState<'class_i' | 'class_ii' | 'class_iii'>('class_ii');
  const [reason, setReason] = useState('');
  const [trace, setTrace] = useState<RecallTraceView | null>(null);
  const [closing, setClosing] = useState<RecallView | null>(null);
  const [closeReason, setCloseReason] = useState('');

  const canManage = granted.has('pharmacy.recall.manage');
  const canTrace = granted.has('pharmacy.recall.trace');

  const recalls = useCursorList<RecallView>({
    queryKey: keys.recalls('all', 'paged'),
    fetchPage: (cursor, signal) => listRecalls({ cursor }, signal === undefined ? {} : { signal }),
  });

  const raise = useMutation({
    mutationFn: () =>
      raiseRecall({
        source,
        ...(sourceRef.trim() === '' ? {} : { sourceRef: sourceRef.trim() }),
        itemId: itemId.trim(),
        batchNo: batchNo.trim(),
        recallClass,
        reason: reason.trim(),
      }),
    onSuccess: (recall) => {
      setRaising(false);
      setReason('');
      setBatchNo('');
      setItemId('');
      recalls.refetch();
      publish({
        title: `Recall raised — ${recall.recallNo}`,
        description: 'The batch is quarantined in every store as of now. Trace the patients next.',
        severity: 'warning',
      });
    },
  });

  const runTrace = useMutation({
    mutationFn: (id: string) => traceRecall(id),
    onSuccess: (result) => {
      setTrace(result);
      recalls.refetch();
    },
  });

  const close = useMutation({
    mutationFn: (input: { readonly id: string; readonly reason: string }) =>
      closeRecall(input.id, input.reason),
    onSuccess: () => {
      setClosing(null);
      setCloseReason('');
      recalls.refetch();
    },
  });

  return (
    <section className="flex flex-col gap-4" data-testid="recalls-screen">
      <PageHeader
        eyebrow="OP-003 · recall"
        title="Recall console"
        description="Raising a recall quarantines the batch in every store first, and only then produces the list of patients who already received some of it."
        primaryAction={
          canManage ? (
            <Button
              variant="primary"
              data-testid="open-raise-recall"
              onClick={() => {
                setRaising(true);
              }}
            >
              Raise a recall
            </Button>
          ) : undefined
        }
      />

      {raising ? (
        <section
          className="flex flex-col gap-3 rounded-lg border-2 border-danger-border bg-danger-surface p-4"
          data-testid="raise-recall"
        >
          <p className="flex items-center gap-2 text-md font-semibold text-danger-on-surface">
            <OctagonAlert className="size-4 shrink-0" aria-hidden="true" />
            This quarantines the batch immediately, in every store
          </p>
          <p className="text-sm text-danger-on-surface">
            Nothing from this batch can be dispensed or issued from the moment you confirm — before anybody
            has worked out who already has some. That order is deliberate.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="recall-source">Who called the recall?</Label>
              <select
                id="recall-source"
                data-testid="recall-source"
                className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                value={source}
                onChange={(event) => {
                  setSource(event.target.value as RecallSource);
                }}
              >
                {SOURCES.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="recall-source-ref">Their reference (optional)</Label>
              <Input
                id="recall-source-ref"
                data-testid="recall-source-ref"
                value={sourceRef}
                onChange={(event) => {
                  setSourceRef(event.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="recall-item">Item id</Label>
              <Input
                id="recall-item"
                data-testid="recall-item"
                value={itemId}
                placeholder="Copy it from the item master"
                onChange={(event) => {
                  setItemId(event.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="recall-batch">Batch number</Label>
              <Input
                id="recall-batch"
                data-testid="recall-batch"
                value={batchNo}
                onChange={(event) => {
                  setBatchNo(event.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-1 md:col-span-2">
              <Label htmlFor="recall-class">Severity</Label>
              <select
                id="recall-class"
                data-testid="recall-class"
                className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                value={recallClass}
                onChange={(event) => {
                  setRecallClass(event.target.value as 'class_i' | 'class_ii' | 'class_iii');
                }}
              >
                {CLASSES.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1 md:col-span-2">
              <Label htmlFor="recall-reason">Why (at least 8 characters)</Label>
              <Textarea
                id="recall-reason"
                data-testid="recall-reason"
                rows={2}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="danger"
              data-testid="confirm-raise-recall"
              disabled={
                reason.trim().length < 8 || itemId.trim() === '' || batchNo.trim() === '' || raise.isPending
              }
              onClick={() => {
                raise.mutate();
              }}
            >
              {raise.isPending ? 'Quarantining…' : 'Quarantine this batch everywhere'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setRaising(false);
              }}
            >
              Cancel
            </Button>
          </div>
          {raise.error === null ? null : <ProblemCard error={raise.error} />}
        </section>
      ) : null}

      <AsyncPanel
        loading={recalls.isPending}
        error={recalls.error}
        isEmpty={recalls.items.length === 0}
        skeletonLabel="Loading the recall register"
        skeletonRows={5}
        onRetry={recalls.refetch}
        empty={
          <EmptyState
            cause="No recall has ever been raised in this hospital."
            nextAction="That is the answer you want. If CDSCO or a manufacturer calls one, raise it here — the quarantine happens before anything else."
          />
        }
      >
        <ul className="flex flex-col gap-3" data-testid="recall-list">
          {recalls.items.map((recall) => (
            <li
              key={recall.id}
              className="flex flex-col gap-2 rounded-lg border border-strong bg-layer-1 p-4"
              data-testid={`recall-${recall.recallNo}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-md text-fg-default">{recall.recallNo}</span>
                <Badge tone={recall.recallClass === 'class_i' ? 'danger' : 'warning'}>
                  {humanise(recall.recallClass)}
                </Badge>
                <Badge tone={recall.status === 'closed' ? 'neutral' : 'danger'}>
                  {humanise(recall.status)}
                </Badge>
                <span className="text-2xs text-fg-subtle">
                  {humanise(recall.source)} · batch {recall.batchNo ?? '—'} · raised{' '}
                  {formatInstant(recall.raisedAt)}
                </span>
              </div>
              <p className="text-sm text-fg-muted">{recall.reason}</p>
              <p className="text-2xs text-fg-muted">
                {recall.patientsIdentified} patient(s) identified · {recall.patientsContacted} contacted ·{' '}
                {formatQty(recall.unitsReturned)} units returned
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid={`trace-${recall.recallNo}`}
                  disabled={!canTrace || runTrace.isPending}
                  onClick={() => {
                    runTrace.mutate(recall.id);
                  }}
                >
                  {runTrace.isPending ? 'Tracing…' : 'Produce the patient list'}
                </Button>
                {recall.status === 'closed' ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!canManage}
                    onClick={() => {
                      setClosing(recall);
                      setCloseReason('');
                    }}
                  >
                    Close the recall
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {recalls.hasMore ? (
          <Button variant="secondary" size="sm" onClick={recalls.loadMore} disabled={recalls.isFetching}>
            {recalls.isFetching ? 'Loading the next page…' : 'Load the next page'}
          </Button>
        ) : null}
      </AsyncPanel>

      {!canTrace ? (
        <p className="text-sm text-fg-muted">
          Producing the list of affected patients needs{' '}
          <span className="font-mono">pharmacy.recall.trace</span>, because that list is patient data. The
          quarantine does not wait for it.
        </p>
      ) : null}

      {runTrace.error === null ? null : <ProblemCard error={runTrace.error} />}

      {trace === null ? null : (
        <section
          className="flex flex-col gap-2 rounded-lg border border-strong bg-layer-1 p-4"
          data-testid="recall-trace"
        >
          <h2 className="text-md font-medium text-fg-default">
            {trace.recall.recallNo} — {trace.patients.length} patient(s) received this batch
          </h2>
          <p className="text-2xs text-fg-muted">
            {formatQty(trace.quarantinedQtyBase)} units quarantined across {trace.openStoreCount} store(s).
            Patients are shown by reference; the contact list goes out through the notification service rather
            than being read off this screen.
          </p>
          {trace.patients.length === 0 ? (
            <EmptyState
              cause="Nobody received any of this batch."
              nextAction="The quarantine still stands. Close the recall once the stock has been returned or destroyed."
            />
          ) : (
            <ul className="flex flex-col gap-1">
              {trace.patients.map((patient) => (
                <li key={patient.traceId} className="flex flex-wrap gap-3 text-sm">
                  <span className="font-mono">{patientRef(patient.patientId)}</span>
                  <span className="text-fg-muted">{formatQty(patient.qtyDispensedBase)} units</span>
                  <span className="text-fg-muted">dispensed {formatInstant(patient.dispensedAt)}</span>
                  <span className={patient.contactedAt === null ? 'text-danger-fg' : 'text-success-fg'}>
                    {patient.contactedAt === null
                      ? 'not contacted yet'
                      : `contacted ${formatInstant(patient.contactedAt)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {closing === null ? null : (
        <section className="flex flex-col gap-2 rounded-lg border border-strong bg-layer-1 p-4">
          <p className="text-md font-medium text-fg-default">Close {closing.recallNo}</p>
          <Label htmlFor="close-reason">
            What happened to the stock, and were all the patients reached? (at least 8 characters)
          </Label>
          <Textarea
            id="close-reason"
            data-testid="close-reason"
            rows={2}
            value={closeReason}
            onChange={(event) => {
              setCloseReason(event.target.value);
            }}
          />
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              data-testid="confirm-close-recall"
              disabled={closeReason.trim().length < 8 || close.isPending}
              onClick={() => {
                close.mutate({ id: closing.id, reason: closeReason.trim() });
              }}
            >
              {close.isPending ? 'Closing…' : 'Close'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setClosing(null);
              }}
            >
              Cancel
            </Button>
          </div>
          {close.error === null ? null : <ProblemCard error={close.error} />}
        </section>
      )}
    </section>
  );
}
