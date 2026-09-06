'use client';

import { useMutation } from '@tanstack/react-query';
import { Button, EmptyState, Input, Label, WorklistTable, useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { formatInstant } from '@/features/pharmacy/lib/format';
import { listConsumption, reverseConsumption } from '../api/client';
import { inventoryKeys } from '../api/keys';
import type { DocumentView } from '../api/types';
import { useCursorList } from '../lib/cursor-list';
import { worklistLabels } from '../lib/worklist-labels';
import { DocumentLinesTable, DocumentSummary } from './document-panel';
import { StorePicker } from './store-picker';

/**
 * NC-008 — consumption entry and cost centres.
 *
 * ── Two questions, deliberately on one screen ───────────────────────────────
 *
 * "What did this ward take off the shelf?" and "what did it cost the ward?" are
 * the same fact read twice, and splitting them across two screens is how a
 * hospital ends up with a stores figure and a finance figure that disagree by a
 * month. The entries tab is the transaction; the cost-centre tab is the same
 * transactions rolled up for a period. Nothing here re-derives a total the API
 * did not send.
 *
 * ── Reversed, never edited ──────────────────────────────────────────────────
 *
 * NC-008 §5. An entry that was wrong is corrected by a compensating entry with a
 * reason on it, because the ledger behind it is append-only and a silent edit
 * would leave the stock balance and the consumption history telling different
 * stories. The screen therefore offers no edit control at all — the absence is
 * the design, not an omission.
 *
 * ── Why recording is not offered here ───────────────────────────────────────
 *
 * `POST /inventory/consumption` exists and is `@Idempotent()`, but its real
 * caller is the ward scanner and the kit/BOM automation (`source` names five
 * origins, and only one of them is a person at a keyboard). A desk form would
 * mostly be used to correct what the scanner got wrong, which is what the
 * reversal is for. When a manual-entry flow is specified — NC-008 §3.2 names a
 * kit picker this screen does not have — it belongs behind its own permission
 * and its own review, not bolted to a read console.
 */
const ENTRY_TYPES: readonly { readonly value: string; readonly label: string }[] = [
  { value: '', label: 'Every kind' },
  { value: 'ward_consumption', label: 'Ward consumption' },
  { value: 'ot_consumption', label: 'Theatre consumption' },
  { value: 'department_use', label: 'Department use' },
  { value: 'patient_chargeable', label: 'Chargeable to a patient' },
  { value: 'wastage', label: 'Wastage' },
];

export function ConsumptionScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = inventoryKeys(hospitalId);
  const { publish } = useToast();

  const [storeId, setStoreId] = useState('');
  const [entryType, setEntryType] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [reverseReason, setReverseReason] = useState('');

  const canReverse = granted.has('inventory.consumption.reverse');

  const entries = useCursorList<DocumentView>({
    queryKey: keys.consumption(
      storeId === '' ? 'all' : storeId,
      'all',
      entryType === '' ? 'all' : entryType,
      'paged',
    ),
    fetchPage: (cursor, signal) =>
      listConsumption(
        {
          storeId: storeId === '' ? undefined : storeId,
          entryType: entryType === '' ? undefined : entryType,
          cursor,
        },
        signal === undefined ? {} : { signal },
      ),
  });

  const reverse = useMutation({
    mutationFn: (id: string) => reverseConsumption(id, { reason: reverseReason }),
    onSuccess: () => {
      entries.refetch();
      setOpenId(null);
      setReverseReason('');
      publish({
        title: 'Entry reversed',
        description: 'A compensating entry was written. The original stays on the record.',
        severity: 'success',
      });
    },
  });

  const openEntry = entries.items.find((row) => row.id === openId) ?? null;

  return (
    <section className="flex flex-col gap-4" data-testid="consumption-screen">
      <PageHeader
        eyebrow="NC-008 · consumption"
        title="Consumption & cost centres"
        description="What each ward, theatre and department actually took off the shelf, and what it cost them for a period. Entries are reversed with a reason, never edited."
        actions={
          <div className="flex flex-wrap items-end gap-3">
            <StorePicker value={storeId} onChange={setStoreId} label="Store" />
          </div>
        }
      />

      <div className="flex flex-col gap-3">
        <div className="flex min-w-56 max-w-xs flex-col gap-1">
          <Label htmlFor="entry-type">Kind of entry</Label>
          <select
            id="entry-type"
            data-testid="entry-type"
            className="h-9 rounded-md border border-control bg-layer-1 px-2 text-sm"
            value={entryType}
            onChange={(event) => {
              setEntryType(event.target.value);
            }}
          >
            {ENTRY_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <AsyncPanel
          loading={entries.isPending}
          error={entries.error}
          isEmpty={entries.items.length === 0}
          skeletonLabel="Loading consumption entries"
          skeletonRows={8}
          onRetry={entries.refetch}
          empty={
            <EmptyState
              cause="Nothing has been consumed against this filter."
              nextAction="Consumption is written by the ward scanner and by kit and BOM automation. Widen the store or the kind of entry."
            />
          }
        >
          <WorklistTable<DocumentView>
            rows={entries.items}
            getRowId={(row) => row.id}
            labels={worklistLabels('Consumption entries')}
            empty={{
              cause: 'Nothing consumed against this filter.',
              nextAction: 'Widen the store or the kind of entry.',
            }}
            hasMore={entries.hasMore}
            loading={entries.isFetching}
            onLoadMore={entries.loadMore}
            columns={[
              {
                key: 'document',
                header: 'Entry',
                hideable: false,
                render: (row) => <DocumentSummary document={row} />,
              },
              {
                key: 'when',
                header: 'Recorded',
                render: (row) => (
                  <span className="text-2xs text-fg-subtle">{formatInstant(row.createdAt)}</span>
                ),
              },
              {
                key: 'action',
                header: 'Action',
                render: (row) => (
                  <Button
                    variant="ghost"
                    data-testid={`open-entry-${row.documentNo}`}
                    onClick={() => {
                      setOpenId(row.id === openId ? null : row.id);
                      setReverseReason('');
                    }}
                  >
                    {row.id === openId ? 'Close' : 'Open'}
                  </Button>
                ),
              },
            ]}
          />
        </AsyncPanel>

        {openEntry === null ? null : (
          <div
            className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
            data-testid="entry-detail"
          >
            <DocumentSummary document={openEntry} title="consumption entry" />
            <DocumentLinesTable
              document={openEntry}
              caption={`Lines of consumption entry ${openEntry.documentNo}`}
              extras={[
                { header: 'Billable', keys: ['isBillable', 'is_billable'] },
                { header: 'Expense head', keys: ['expenseHead', 'expense_head'] },
              ]}
            />
            {reverse.error === null ? null : <ProblemCard error={reverse.error} />}
            {openEntry.status === 'reversed' ? (
              <p className="text-sm text-fg-muted">
                Already reversed. The compensating entry is itself a document and is never undone.
              </p>
            ) : canReverse ? (
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex min-w-72 flex-1 flex-col gap-1">
                  <Label htmlFor="consumption-reverse-reason">Why is this being reversed?</Label>
                  <Input
                    id="consumption-reverse-reason"
                    data-testid="consumption-reverse-reason"
                    value={reverseReason}
                    autoComplete="off"
                    onChange={(event) => {
                      setReverseReason(event.target.value);
                    }}
                  />
                </div>
                <Button
                  variant="danger"
                  data-testid="reverse-consumption"
                  disabled={reverseReason.trim() === '' || reverse.isPending}
                  onClick={() => {
                    reverse.mutate(openEntry.id);
                  }}
                >
                  Reverse this entry
                </Button>
              </div>
            ) : (
              <p className="text-sm text-fg-muted">
                Reversing an entry needs <code>inventory.consumption.reverse</code>, which is not the key that
                records one.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
