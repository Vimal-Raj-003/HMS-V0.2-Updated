'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, Textarea, useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { ScanSearch } from '@/lib/icons';
import { useSession } from '@/lib/session-context';
import { approveSaleReturn, createSaleReturn, getDispense } from '../api/client';
import { pharmacyKeys } from '../api/keys';
import type { SaleReturnView } from '../api/types';
import { formatDate, formatMoney, formatQty, humanise } from '../lib/format';

/**
 * OP-003 §3.5 — the returns desk.
 *
 * ── Why a return starts from the original dispense ──────────────────────────
 *
 * Because a return that does not name what it is returning is a stock increase
 * with a story attached. The API keys the whole thing on `originalDispenseId`
 * and its lines on `dispenseItemId`, so the units go back to the batch they came
 * out of — which is the only way the batch's own history, and a later recall
 * trace, stay true.
 *
 * ── Why disposition is a decision and not a default ─────────────────────────
 *
 * `restock` puts the units back on the shelf for the next patient. That is the
 * right answer for an unopened strip handed back at the counter five minutes
 * later, and the wrong one for anything that has left the building, been in a
 * car in June, or is a cold-chain item. So the screen makes it three explicit
 * choices with the consequence spelled out, and defaults to `quarantine` —
 * which is the safe answer when nobody has looked at the box yet.
 *
 * ── Why approval is somebody else's ─────────────────────────────────────────
 *
 * Approval is what moves the stock and what triggers the refund, and
 * `pharmacy.return.approve` is a different key from `pharmacy.return.create`.
 * The screen shows both halves so a counter pharmacist can see exactly what is
 * waiting for the in-charge, and cannot do it themselves.
 */
const REASON_CODES: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'wrong_item', label: 'Wrong item dispensed' },
  { code: 'doctor_stopped', label: 'Doctor stopped the medicine' },
  { code: 'duplicate', label: 'Duplicate — the patient already had it' },
  { code: 'patient_expired', label: 'Patient died' },
  { code: 'discharge_unused', label: 'Unused at discharge' },
  { code: 'adverse_reaction', label: 'Adverse reaction' },
];

const DISPOSITIONS: readonly {
  readonly value: 'restock' | 'quarantine' | 'destroy';
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    value: 'quarantine',
    label: 'Quarantine — hold it off the shelf',
    hint: 'The safe default. Nothing is dispensed from quarantine until somebody has inspected it.',
  },
  {
    value: 'restock',
    label: 'Restock — put it back on the shelf',
    hint: 'Only for an unopened, in-date, room-temperature strip handed back at the counter. It will be given to the next patient.',
  },
  {
    value: 'destroy',
    label: 'Destroy it',
    hint: 'Cold-chain breaks, opened packs, Schedule X. Goes to BMW disposal, never back to a shelf.',
  },
];

export function ReturnsScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = pharmacyKeys(hospitalId);
  const { publish } = useToast();

  const [dispenseId, setDispenseId] = useState('');
  const [lookupId, setLookupId] = useState('');
  const [reasonCode, setReasonCode] = useState('wrong_item');
  const [note, setNote] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [dispositions, setDispositions] = useState<Record<string, 'restock' | 'quarantine' | 'destroy'>>({});
  const [raised, setRaised] = useState<SaleReturnView | null>(null);

  const canApprove = granted.has('pharmacy.return.approve');

  const dispense = useQuery({
    queryKey: keys.dispense(lookupId === '' ? 'none' : lookupId),
    queryFn: ({ signal }) =>
      lookupId === '' ? Promise.reject(new Error('no dispense')) : getDispense(lookupId, { signal }),
    enabled: lookupId !== '',
  });

  const create = useMutation({
    mutationFn: () => {
      const source = dispense.data;
      if (source === undefined) throw new Error('No dispense loaded.');
      const lines = source.items
        .filter((item) => Number(quantities[item.id] ?? '0') > 0)
        .map((item) => ({
          dispenseItemId: item.id,
          qtyEntered: Number(quantities[item.id] ?? '0'),
          disposition: dispositions[item.id] ?? ('quarantine' as const),
        }));
      if (lines.length === 0) throw new Error('Nothing has been marked for return.');
      return createSaleReturn({
        originalDispenseId: source.id,
        reasonCode,
        ...(note.trim() === '' ? {} : { reason: note.trim() }),
        lines,
      });
    },
    onSuccess: (result) => {
      setRaised(result);
      setQuantities({});
      publish({
        title: `Return raised — ${result.returnNo}`,
        description:
          'Nothing has moved yet. The pharmacy in-charge approves it, and that is what puts the units back or into quarantine.',
        severity: 'success',
      });
    },
  });

  const approve = useMutation({
    mutationFn: (id: string) => approveSaleReturn(id, undefined),
    onSuccess: (result) => {
      setRaised(result);
      publish({
        title: 'Return approved',
        description: 'The stock has moved and the refund can be raised against the original invoice.',
        severity: 'success',
      });
    },
  });

  const source = dispense.data ?? null;

  return (
    <section className="flex flex-col gap-4" data-testid="returns-screen">
      <PageHeader
        eyebrow="OP-003 · returns"
        title="Returns desk"
        description="A return names the dispense it is undoing, line by line, so the units go back to the batch they came out of — and so a later recall still finds them."
      />

      <section className="flex flex-wrap items-end gap-3 rounded-lg border border-strong bg-layer-1 p-4">
        <div className="flex min-w-72 flex-col gap-1">
          <Label htmlFor="dispense-lookup">Original dispense id</Label>
          <Input
            id="dispense-lookup"
            data-testid="dispense-lookup"
            value={dispenseId}
            autoComplete="off"
            placeholder="Scan the bill QR, or paste the dispense id"
            onChange={(event) => {
              setDispenseId(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              setLookupId(dispenseId.trim());
            }}
          />
          <p className="text-2xs text-fg-muted">
            The identifier is sent in the request path, never as a search term — the counter receipt carries
            it as a QR code so it never has to be typed.
          </p>
        </div>
        <Button
          variant="secondary"
          data-testid="lookup-dispense"
          onClick={() => {
            setLookupId(dispenseId.trim());
          }}
        >
          Load the dispense
        </Button>
      </section>

      {lookupId === '' ? (
        <EmptyState
          icon={<ScanSearch aria-hidden="true" />}
          cause="No dispense loaded."
          nextAction="Scan the receipt or paste the dispense id above. A return is always against something that was given out."
        />
      ) : (
        <AsyncPanel
          loading={dispense.isPending}
          error={dispense.error}
          isEmpty={source === null}
          skeletonLabel="Loading the original dispense"
          skeletonRows={5}
          onRetry={() => void dispense.refetch()}
          empty={
            <EmptyState
              cause="That identifier does not resolve to a dispense in this hospital."
              nextAction="Check the receipt. A dispense from another branch resolves to nothing here, which is the tenancy boundary doing its job."
            />
          }
        >
          {source === null ? null : (
            <section className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-md text-fg-default">{source.dispenseNo}</span>
                <Badge tone="neutral">{humanise(source.status)}</Badge>
                <span className="text-2xs text-fg-subtle">
                  {source.items.length} line(s) · {formatMoney(source.totalAmount)}
                </span>
              </div>

              <ul className="flex flex-col gap-2">
                {source.items.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-col gap-2 rounded-md border border-default bg-layer-2 p-3"
                    data-testid={`return-line-${item.itemCode}`}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-md text-fg-default">{item.itemName}</span>
                      <span className="font-mono text-2xs text-fg-subtle">
                        batch {item.batchNo ?? '—'} · exp {formatDate(item.expiryDate)}
                      </span>
                    </div>
                    <p className="font-mono text-2xs text-fg-muted">
                      {formatQty(item.qtyBase)} given · {formatQty(item.qtyReturnedBase)} already returned
                    </p>
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="flex w-28 flex-col gap-1">
                        <Label htmlFor={`return-qty-${item.id}`}>Units back</Label>
                        <Input
                          id={`return-qty-${item.id}`}
                          data-testid={`return-qty-${item.itemCode}`}
                          inputMode="decimal"
                          value={quantities[item.id] ?? ''}
                          onChange={(event) => {
                            setQuantities((previous) => ({ ...previous, [item.id]: event.target.value }));
                          }}
                        />
                      </div>
                      <div className="flex min-w-72 flex-col gap-1">
                        <Label htmlFor={`disposition-${item.id}`}>Where do they go?</Label>
                        <select
                          id={`disposition-${item.id}`}
                          data-testid={`disposition-${item.itemCode}`}
                          className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                          value={dispositions[item.id] ?? 'quarantine'}
                          onChange={(event) => {
                            setDispositions((previous) => ({
                              ...previous,
                              [item.id]: event.target.value as 'restock' | 'quarantine' | 'destroy',
                            }));
                          }}
                        >
                          {DISPOSITIONS.map((entry) => (
                            <option key={entry.value} value={entry.value}>
                              {entry.label}
                            </option>
                          ))}
                        </select>
                        <p className="text-2xs text-fg-muted">
                          {
                            DISPOSITIONS.find(
                              (entry) => entry.value === (dispositions[item.id] ?? 'quarantine'),
                            )?.hint
                          }
                        </p>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="flex flex-wrap items-end gap-3">
                <div className="flex min-w-64 flex-col gap-1">
                  <Label htmlFor="return-reason-code">Why is it coming back?</Label>
                  <select
                    id="return-reason-code"
                    data-testid="return-reason-code"
                    className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    value={reasonCode}
                    onChange={(event) => {
                      setReasonCode(event.target.value);
                    }}
                  >
                    {REASON_CODES.map((entry) => (
                      <option key={entry.code} value={entry.code}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex min-w-72 flex-1 flex-col gap-1">
                  <Label htmlFor="return-note">Anything else worth recording (optional)</Label>
                  <Textarea
                    id="return-note"
                    data-testid="return-note"
                    rows={2}
                    value={note}
                    onChange={(event) => {
                      setNote(event.target.value);
                    }}
                  />
                </div>
              </div>

              <Button
                variant="primary"
                className="self-start"
                data-testid="raise-return"
                disabled={create.isPending}
                onClick={() => {
                  create.mutate();
                }}
              >
                {create.isPending ? 'Raising…' : 'Raise the return'}
              </Button>
              {create.error === null ? null : <ProblemCard error={create.error} />}
            </section>
          )}
        </AsyncPanel>
      )}

      {raised === null ? null : (
        <section
          className="flex flex-col gap-2 rounded-lg border border-strong bg-layer-1 p-4"
          data-testid="raised-return"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-md text-fg-default">{raised.returnNo}</span>
            <Badge tone={raised.status === 'approved' ? 'success' : 'warning'}>
              {humanise(raised.status)}
            </Badge>
            <span className="text-2xs text-fg-subtle">
              refund {formatMoney(raised.refundAmount)} · {raised.lines.length} line(s)
            </span>
          </div>
          {raised.status === 'approved' ? (
            <p className="text-sm text-success-fg">
              Approved. The stock has moved and the refund can be raised against the original invoice.
            </p>
          ) : canApprove ? (
            <Button
              variant="primary"
              className="self-start"
              data-testid="approve-return"
              disabled={approve.isPending}
              onClick={() => {
                approve.mutate(raised.id);
              }}
            >
              {approve.isPending ? 'Approving…' : 'Approve — this is what moves the stock'}
            </Button>
          ) : (
            <p className="text-sm text-fg-muted">
              Waiting for the pharmacy in-charge. Approval needs{' '}
              <span className="font-mono">pharmacy.return.approve</span>, which is deliberately not the key
              that raises one — approval is what moves the stock and triggers the refund.
            </p>
          )}
          {approve.error === null ? null : <ProblemCard error={approve.error} />}
        </section>
      )}
    </section>
  );
}
