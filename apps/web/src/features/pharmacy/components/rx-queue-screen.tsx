'use client';

import { useMutation } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Label, WorklistTable, useToast } from '@vims/ui';
import { useMemo, useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { StorePicker } from '@/features/inventory/components/store-picker';
import { useCursorList } from '@/features/inventory/lib/cursor-list';
import { worklistLabels } from '@/features/inventory/lib/worklist-labels';
import { Lock, OctagonAlert } from '@/lib/icons';
import { useSession } from '@/lib/session-context';
import { holdRxQueueEntry, listRxQueue } from '../api/client';
import { pharmacyKeys } from '../api/keys';
import type { RxQueueView } from '../api/types';
import { formatInstant, humanise } from '../lib/format';
import { patientRef } from './patient-identity-panel';

/**
 * OP-003 §3.1 — the prescription queue board.
 *
 * ── Why there are no names on it ────────────────────────────────────────────
 *
 * This board is read across a counter with a queue of people standing at it, and
 * `docs/06` §1.2 rule 8 makes a public-facing surface default to a token or a
 * masked label. The API helps by returning nothing but an opaque patient UUID —
 * no name, no UHID, no date of birth — so there is nothing here to mask. What a
 * pharmacist needs is a short stable handle they can match against the slip in
 * the patient's hand, and the last six characters of the id are exactly that.
 * The full identity appears on the **counter** screen, one patient at a time,
 * with the banner and the allergy strip.
 *
 * ── Why the priority column is a number and a word ──────────────────────────
 *
 * `docs/06` §1.2 rule 3: colour is never the only signal. A red row on a shared
 * monitor with a sun on it is not a signal at all.
 */
const STATUS_FILTERS: readonly { readonly value: string; readonly label: string }[] = [
  { value: '', label: 'Everything open' },
  { value: 'pending', label: 'Waiting for the patient' },
  { value: 'patient_arrived', label: 'Patient at the counter' },
  { value: 'in_progress', label: 'Being dispensed' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'awaiting_approval', label: 'Awaiting a substitution decision' },
];

export function RxQueueScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = pharmacyKeys(hospitalId);
  const { publish } = useToast();

  const [storeId, setStoreId] = useState('');
  const [status, setStatus] = useState('');
  const [holding, setHolding] = useState<RxQueueView | null>(null);
  const [holdReason, setHoldReason] = useState('');

  const canManage = granted.has('pharmacy.queue.manage');

  const queue = useCursorList<RxQueueView>({
    queryKey: keys.queue(storeId, status === '' ? 'open' : status, 'paged'),
    fetchPage: (cursor, signal) =>
      listRxQueue(
        { pharmacyStoreId: storeId, status: status === '' ? undefined : status, cursor },
        signal === undefined ? {} : { signal },
      ),
    enabled: storeId !== '',
    refetchInterval: 30_000,
  });

  const hold = useMutation({
    mutationFn: (input: { readonly id: string; readonly reason: string }) =>
      holdRxQueueEntry(input.id, input.reason),
    onSuccess: () => {
      setHolding(null);
      setHoldReason('');
      queue.refetch();
      publish({
        title: 'Held',
        description: 'The reason is on the queue entry and the prescriber can see it.',
        severity: 'warning',
      });
    },
  });

  const rows = useMemo(() => queue.items, [queue.items]);

  return (
    <section className="flex flex-col gap-4" data-testid="rx-queue-screen">
      <PageHeader
        eyebrow="OP-003 · queue"
        title="Prescription queue"
        description="Everything waiting at this counter. Patients are shown by reference rather than by name — this board is read across a counter, and the identity check happens one patient at a time on the dispensing screen."
        actions={
          <div className="flex flex-wrap items-end gap-3">
            <StorePicker storeType="pharmacy" value={storeId} onChange={setStoreId} label="Counter" />
            <div className="flex min-w-56 flex-col gap-1">
              <Label htmlFor="queue-status">Show</Label>
              <select
                id="queue-status"
                data-testid="queue-status"
                className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                }}
              >
                {STATUS_FILTERS.map((filter) => (
                  <option key={filter.value} value={filter.value}>
                    {filter.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        }
      />

      {storeId === '' ? (
        <EmptyState
          cause="No counter chosen yet."
          nextAction="Choose the counter whose queue you are working. A prescription is queued to one store, not to the hospital."
        />
      ) : (
        <AsyncPanel
          loading={queue.isPending}
          error={queue.error}
          isEmpty={rows.length === 0}
          skeletonLabel="Loading the prescription queue"
          skeletonRows={8}
          onRetry={queue.refetch}
          empty={
            <EmptyState
              cause="Nothing is waiting at this counter."
              nextAction="A prescription appears here within a second of a doctor signing it. If one was expected, check that it was sent to this counter and not to another."
            />
          }
        >
          <WorklistTable<RxQueueView>
            rows={rows}
            getRowId={(row) => row.id}
            labels={worklistLabels('Prescriptions waiting at this counter')}
            empty={{
              cause: 'Nothing is waiting at this counter.',
              nextAction: 'A prescription appears here within a second of a doctor signing it.',
            }}
            hasMore={queue.hasMore}
            loading={queue.isFetching}
            onLoadMore={queue.loadMore}
            criticalRowIds={new Set(rows.filter((row) => row.hasAllergyFlag).map((row) => row.id))}
            columns={[
              {
                key: 'ref',
                header: 'Patient reference',
                hideable: false,
                render: (row) => <span className="font-mono text-xs">{patientRef(row.patientId)}</span>,
              },
              {
                key: 'priority',
                header: 'Priority',
                hideable: false,
                render: (row) => (
                  <Badge tone={row.priority > 0 ? 'danger' : 'neutral'}>
                    {row.priority > 0 ? `Priority ${String(row.priority)}` : 'Routine'}
                  </Badge>
                ),
              },
              {
                key: 'flags',
                header: 'Flags',
                hideable: false,
                render: (row) => (
                  <span className="flex flex-wrap gap-1">
                    {row.hasAllergyFlag ? (
                      <Badge tone="danger" icon={<OctagonAlert aria-hidden="true" />}>
                        Allergy on file
                      </Badge>
                    ) : null}
                    {row.hasControlled ? (
                      <Badge tone="violet" icon={<Lock aria-hidden="true" />}>
                        Controlled
                      </Badge>
                    ) : null}
                    {row.identityVerified ? (
                      <Badge tone="success">Identity verified</Badge>
                    ) : (
                      <Badge tone="warning">Identity not verified</Badge>
                    )}
                  </span>
                ),
              },
              {
                key: 'items',
                header: 'Items',
                numeric: true,
                render: (row) => row.itemCount,
              },
              {
                key: 'status',
                header: 'Status',
                render: (row) => humanise(row.status),
              },
              {
                key: 'queued',
                header: 'Queued at',
                importance: 'secondary',
                render: (row) => <span className="font-mono text-xs">{formatInstant(row.queuedAt)}</span>,
              },
              {
                key: 'sla',
                header: 'Target',
                importance: 'secondary',
                render: (row) => <span className="font-mono text-xs">{formatInstant(row.slaDueAt)}</span>,
              },
              {
                key: 'hold',
                header: 'Hold',
                importance: 'secondary',
                render: (row) => (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!canManage}
                    data-testid={`hold-${row.id}`}
                    onClick={() => {
                      setHolding(row);
                      setHoldReason('');
                    }}
                  >
                    Put on hold
                  </Button>
                ),
              },
            ]}
          />
        </AsyncPanel>
      )}

      {holding === null ? null : (
        <div className="flex flex-col gap-2 rounded-lg border border-warning-border bg-warning-surface p-4">
          <p className="text-md font-medium text-warning-on-surface">
            Put {patientRef(holding.patientId)} on hold
          </p>
          <p className="text-sm text-warning-on-surface">
            A hold is visible to the prescriber and to the patient&rsquo;s token, so the reason has to say
            what is being waited for.
          </p>
          <Label htmlFor="hold-reason">Reason</Label>
          <input
            id="hold-reason"
            data-testid="hold-reason"
            className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            value={holdReason}
            onChange={(event) => {
              setHoldReason(event.target.value);
            }}
          />
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              data-testid="confirm-hold"
              disabled={holdReason.trim().length < 8 || hold.isPending}
              onClick={() => {
                hold.mutate({ id: holding.id, reason: holdReason.trim() });
              }}
            >
              {hold.isPending ? 'Holding…' : 'Hold'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setHolding(null);
              }}
            >
              Cancel
            </Button>
          </div>
          {hold.error === null ? null : <ProblemCard error={hold.error} />}
        </div>
      )}
    </section>
  );
}
