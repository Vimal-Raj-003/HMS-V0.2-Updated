'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, Textarea, useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { StorePicker } from '@/features/inventory/components/store-picker';
import { useSession } from '@/lib/session-context';
import { actOnExpiry, listPharmacyExpiry } from '../api/client';
import { pharmacyKeys } from '../api/keys';
import type { ExpiryAction, PharmacyExpiryRow } from '../api/types';
import {
  EXPIRY_BAND_LABEL,
  EXPIRY_BAND_TONE,
  daysUntil,
  expiryBand,
  formatDate,
  formatMoney,
  formatQty,
} from '../lib/format';

/**
 * OP-003 §3.4.4 — near-expiry management, and the six things that may lawfully
 * be done about a batch that is running out of shelf life.
 *
 * ── Why there is no seventh ─────────────────────────────────────────────────
 *
 * The list is the API's enum, and it is closed on purpose: return it to the
 * supplier, move it to a store that will use it, discount it, quarantine it,
 * write it off, or destroy it. Every one of those is a ledger movement with a
 * reason and a value at cost. What is not on the list — and has no request shape
 * — is leaving it on the shelf and hoping, which is what an expiry board without
 * actions amounts to.
 *
 * ── Why the horizon is a control and not a constant ─────────────────────────
 *
 * A hospital's return window is its supplier contract's, not ours. 30, 60, 90
 * and 180 days are OP-003 §8's bands; the screen defaults to 90 and lets the
 * in-charge widen it, because a 120-day return window with a 90-day board means
 * stock that could have gone back goes in the yellow bag instead.
 */
const ACTIONS: readonly { readonly value: ExpiryAction; readonly label: string; readonly hint: string }[] = [
  {
    value: 'return_to_supplier',
    label: 'Return to the supplier',
    hint: 'Within the return window in the supplier contract. Raises a debit note.',
  },
  {
    value: 'transfer',
    label: 'Transfer to a faster-moving store',
    hint: 'The stock is fine; this counter is simply not using it.',
  },
  {
    value: 'discount',
    label: 'Discount it',
    hint: 'Never below cost without approval. The price change is effective-dated, never retroactive.',
  },
  { value: 'quarantine', label: 'Quarantine it', hint: 'Blocks dispensing immediately, everywhere.' },
  { value: 'writeoff', label: 'Write it off', hint: 'The value leaves the books. Needs approval.' },
  {
    value: 'disposal',
    label: 'Dispose of it',
    hint: 'Yellow-bag disposal under the BMW Rules 2016 — record the disposal reference.',
  },
];

const HORIZONS: readonly number[] = [30, 60, 90, 180, 365];

export function ExpiryScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = pharmacyKeys(hospitalId);
  const { publish } = useToast();

  const [storeId, setStoreId] = useState('');
  const [days, setDays] = useState(90);
  const [target, setTarget] = useState<PharmacyExpiryRow | null>(null);
  const [action, setAction] = useState<ExpiryAction>('return_to_supplier');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [bmwRef, setBmwRef] = useState('');

  const canAct = granted.has('pharmacy.expiry.manage');
  const now = new Date();

  const expiring = useQuery({
    queryKey: keys.expiry(storeId, days),
    queryFn: ({ signal }) =>
      listPharmacyExpiry({ pharmacyStoreId: storeId === '' ? undefined : storeId, days }, { signal }),
    enabled: storeId !== '',
  });

  const act = useMutation({
    mutationFn: () => {
      if (target === null) throw new Error('No batch selected.');
      return actOnExpiry({
        storeId: target.storeId,
        batchId: target.batchId,
        itemId: target.itemId,
        action,
        qtyEntered: Number(quantity),
        reason: reason.trim(),
        ...(bmwRef.trim() === '' ? {} : { bmwRecordRef: bmwRef.trim() }),
      });
    },
    onSuccess: () => {
      setTarget(null);
      setQuantity('');
      setReason('');
      setBmwRef('');
      void expiring.refetch();
      publish({
        title: 'Recorded',
        description: 'The movement is on the ledger with its reason and its value at cost.',
        severity: 'success',
      });
    },
  });

  const rows = expiring.data?.items ?? [];
  const valueAtRisk = rows.reduce((total, row) => total + Number(row.valueAtCost), 0);

  return (
    <section className="flex flex-col gap-4" data-testid="expiry-screen">
      <PageHeader
        eyebrow="OP-003 · expiry"
        title="Expiry & near-expiry"
        description="What is running out of shelf life on this counter, what it is worth, and the six things that may lawfully be done about it."
        actions={
          <div className="flex flex-wrap items-end gap-3">
            <StorePicker storeType="pharmacy" value={storeId} onChange={setStoreId} label="Counter" />
            <div className="flex min-w-40 flex-col gap-1">
              <Label htmlFor="expiry-horizon">Expiring within</Label>
              <select
                id="expiry-horizon"
                data-testid="expiry-horizon"
                className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                value={days}
                onChange={(event) => {
                  setDays(Number(event.target.value));
                }}
              >
                {HORIZONS.map((horizon) => (
                  <option key={horizon} value={horizon}>
                    {horizon} days
                  </option>
                ))}
              </select>
            </div>
          </div>
        }
        meta={
          rows.length === 0 ? null : (
            <Badge tone="warning">
              {rows.length} batch{rows.length === 1 ? '' : 'es'} · {formatMoney(valueAtRisk.toFixed(2))} at
              cost
            </Badge>
          )
        }
      />

      {storeId === '' ? (
        <EmptyState
          cause="No counter chosen yet."
          nextAction="Choose the counter whose shelf you are reviewing. Expiry is a property of a batch in a store, not of an item."
        />
      ) : (
        <AsyncPanel
          loading={expiring.isPending}
          error={expiring.error}
          isEmpty={rows.length === 0}
          skeletonLabel="Loading the expiry board"
          skeletonRows={8}
          onRetry={() => void expiring.refetch()}
          empty={
            <EmptyState
              cause={`Nothing on this counter expires within ${String(days)} days.`}
              nextAction="Widen the horizon above to see what is coming, or move on — this is the answer you want."
            />
          }
        >
          <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
            <table className="w-full text-sm" data-testid="expiry-table">
              <caption className="sr-only">Batches expiring on this counter, earliest first</caption>
              <thead>
                <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                  <th scope="col" className="px-3 py-2 text-start">
                    Item
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    Batch
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    Expires
                  </th>
                  <th scope="col" className="px-3 py-2 text-end">
                    On hand
                  </th>
                  <th scope="col" className="px-3 py-2 text-end">
                    At cost
                  </th>
                  <th scope="col" className="px-3 py-2 text-start">
                    Decide
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const band = expiryBand(daysUntil(row.expiryDate, now));
                  return (
                    <tr key={row.batchId} className="border-b border-default last:border-0">
                      <td className="px-3 py-2">
                        <span className="text-fg-default">{row.itemName}</span>
                        <span className="ms-2 font-mono text-2xs text-fg-subtle">{row.itemCode}</span>
                      </td>
                      <td className="px-3 py-2 font-mono text-2xs">{row.batchNo}</td>
                      <td className="px-3 py-2">
                        <span className="font-mono text-2xs">{formatDate(row.expiryDate)}</span>
                        <span className={`ms-2 text-2xs ${EXPIRY_BAND_TONE[band]}`}>
                          {EXPIRY_BAND_LABEL[band]}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-end font-mono">{formatQty(row.qtyOnHand)}</td>
                      <td className="px-3 py-2 text-end font-mono">{formatMoney(row.valueAtCost)}</td>
                      <td className="px-3 py-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          data-testid={`decide-${row.batchNo}`}
                          disabled={!canAct}
                          onClick={() => {
                            setTarget(row);
                            setQuantity(row.qtyOnHand);
                            setReason('');
                          }}
                        >
                          Decide
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </AsyncPanel>
      )}

      {!canAct ? (
        <p className="text-sm text-fg-muted">
          Deciding what happens to near-expiry stock needs{' '}
          <span className="font-mono">pharmacy.expiry.manage</span>. You can see what is at risk and tell the
          pharmacy in-charge.
        </p>
      ) : null}

      {target === null ? null : (
        <section
          className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4"
          data-testid="expiry-decision"
        >
          <h2 className="text-md font-medium text-fg-default">
            {target.itemName} · batch {target.batchNo} · expires {formatDate(target.expiryDate)}
          </h2>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-72 flex-col gap-1">
              <Label htmlFor="expiry-action">What happens to it?</Label>
              <select
                id="expiry-action"
                data-testid="expiry-action"
                className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                value={action}
                onChange={(event) => {
                  setAction(event.target.value as ExpiryAction);
                }}
              >
                {ACTIONS.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
              <p className="text-2xs text-fg-muted">
                {ACTIONS.find((entry) => entry.value === action)?.hint}
              </p>
            </div>
            <div className="flex w-32 flex-col gap-1">
              <Label htmlFor="expiry-qty">Units</Label>
              <Input
                id="expiry-qty"
                data-testid="expiry-qty"
                inputMode="decimal"
                value={quantity}
                onChange={(event) => {
                  setQuantity(event.target.value);
                }}
              />
            </div>
            {action === 'disposal' ? (
              <div className="flex min-w-56 flex-col gap-1">
                <Label htmlFor="bmw-ref">BMW disposal reference</Label>
                <Input
                  id="bmw-ref"
                  data-testid="bmw-ref"
                  value={bmwRef}
                  onChange={(event) => {
                    setBmwRef(event.target.value);
                  }}
                />
              </div>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="expiry-reason">Reason (at least 8 characters — an auditor reads this)</Label>
            <Textarea
              id="expiry-reason"
              data-testid="expiry-reason"
              rows={2}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          </div>
          <div className="flex gap-2">
            <Button
              variant="primary"
              data-testid="confirm-expiry-action"
              disabled={reason.trim().length < 8 || Number(quantity) <= 0 || act.isPending}
              onClick={() => {
                act.mutate();
              }}
            >
              {act.isPending ? 'Recording…' : 'Record the decision'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setTarget(null);
              }}
            >
              Cancel
            </Button>
          </div>
          {act.error === null ? null : <ProblemCard error={act.error} />}
        </section>
      )}
    </section>
  );
}
