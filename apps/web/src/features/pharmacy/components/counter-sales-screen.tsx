'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { StorePicker } from '@/features/inventory/components/store-picker';
import { OctagonAlert, ScanSearch } from '@/lib/icons';
import { useSession } from '@/lib/session-context';
import { addDispenseItem, createDispense, getDispense, listPharmacyStock } from '../api/client';
import { pharmacyKeys } from '../api/keys';
import type { DispenseView, PharmacyStockRow } from '../api/types';
import { otcVerdict } from '../lib/counter';
import { formatDate, formatMoney, formatQty, humanise } from '../lib/format';

/**
 * OP-003 §3.3 — the over-the-counter till, and `phase-04` exit gate 3's second
 * half: "attempt to sell a Schedule H drug OTC → blocked with reason".
 *
 * ── Where the refusal lives ─────────────────────────────────────────────────
 *
 * In three places, on purpose. `pharmacy.enforce_dispense_line` refuses it in
 * the database; `DispenseService.assertSchedulePermitted` refuses it in the
 * service with the rule quoted; and this screen refuses it **before the pack is
 * scanned**, by not offering an Add button on a prescription-only row and saying
 * which rule forbids it. The third is the only one that reaches somebody in
 * time to do the lawful thing instead, which is to take the prescription and
 * dispense against it on the counter screen.
 *
 * The refusal is deliberately not a hidden row. A pharmacist searching for
 * amoxicillin and finding nothing would conclude the shelf is empty and go and
 * look; a pharmacist finding it greyed with Rule 65(9)(a) beside it knows what
 * to ask the customer for.
 *
 * ── The anonymous sale ──────────────────────────────────────────────────────
 *
 * The API refuses a dispense that identifies nobody at all — "an anonymous sale
 * of a prescription medicine is not a record of anything" — so a walk-in name is
 * required here. It is a name and a phone number, not a registration: a person
 * buying a bandage should not have to become a patient.
 */
export function CounterSalesScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = pharmacyKeys(hospitalId);
  const queryClient = useQueryClient();
  const { publish } = useToast();

  const [storeId, setStoreId] = useState('');
  const [term, setTerm] = useState('');
  const [walkInName, setWalkInName] = useState('');
  const [walkInPhone, setWalkInPhone] = useState('');
  const [dispenseId, setDispenseId] = useState<string | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});

  const canSearch = granted.has('pharmacy.stock.list');
  const canDispense = granted.has('pharmacy.dispense.create');

  const stock = useQuery({
    queryKey: keys.stock(storeId, term),
    queryFn: ({ signal }) =>
      listPharmacyStock({ pharmacyStoreId: storeId, q: term === '' ? undefined : term }, { signal }),
    enabled: canSearch && storeId !== '',
    staleTime: 30_000,
  });

  const sale = useQuery({
    queryKey: keys.dispense(dispenseId ?? 'none'),
    queryFn: ({ signal }) =>
      dispenseId === null ? Promise.reject(new Error('no sale')) : getDispense(dispenseId, { signal }),
    enabled: dispenseId !== null,
  });

  function land(view: DispenseView): void {
    setDispenseId(view.id);
    queryClient.setQueryData(keys.dispense(view.id), view);
  }

  const openSale = useMutation({
    mutationFn: () =>
      createDispense({
        pharmacyStoreId: storeId,
        dispenseType: 'otc',
        walkInName: walkInName.trim(),
        ...(walkInPhone.trim() === '' ? {} : { walkInPhone: walkInPhone.trim() }),
        payerType: 'cash',
      }),
    onSuccess: land,
  });

  const addLine = useMutation({
    mutationFn: (input: { readonly row: PharmacyStockRow; readonly quantity: number }) => {
      if (dispenseId === null) throw new Error('No sale is open.');
      return addDispenseItem(dispenseId, {
        itemId: input.row.itemId,
        ...(input.row.batchId === null ? {} : { batchId: input.row.batchId }),
        qtyEntered: input.quantity,
      });
    },
    onSuccess: (view) => {
      land(view);
      publish({ title: 'Added to the sale', severity: 'success' });
    },
  });

  const rows = stock.data?.items ?? [];
  const current = sale.data ?? null;

  return (
    <section className="flex flex-col gap-4" data-testid="counter-sales-screen">
      <PageHeader
        eyebrow="OP-003 · over the counter"
        title="Counter sales"
        description="A walk-in sale from this counter's shelf. A prescription-only medicine cannot leave this way, and the screen says which rule refuses it rather than hiding the row."
        actions={<StorePicker storeType="pharmacy" value={storeId} onChange={setStoreId} label="Counter" />}
      />

      {!canDispense ? (
        <EmptyState
          cause="You can see the shelf but you cannot open a sale."
          nextAction="Opening a dispense — including an over-the-counter sale — needs pharmacy.dispense.create. Ask your hospital administrator to grant it."
        />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
          <h2 className="font-display text-2xs uppercase tracking-[0.08em] text-fg-subtle">The shelf</h2>
          <div className="flex flex-col gap-1">
            <Label htmlFor="otc-search">Search by name, brand or code</Label>
            <Input
              id="otc-search"
              data-testid="otc-search"
              value={term}
              autoComplete="off"
              placeholder="Paracetamol, ORS, bandage…"
              onChange={(event) => {
                setTerm(event.target.value);
              }}
            />
          </div>

          {!canSearch ? (
            <EmptyState
              cause="You cannot search this counter's stock."
              nextAction="The shelf is a separate permission (pharmacy.stock.list). Ask your hospital administrator to grant it — it is read-only."
            />
          ) : storeId === '' ? (
            <EmptyState
              cause="No counter chosen yet."
              nextAction="Choose the counter you are selling from; stock is held per store, not per hospital."
            />
          ) : (
            <AsyncPanel
              loading={stock.isPending}
              error={stock.error}
              isEmpty={rows.length === 0}
              skeletonLabel="Searching the shelf"
              skeletonRows={6}
              onRetry={() => void stock.refetch()}
              empty={
                <EmptyState
                  icon={<ScanSearch aria-hidden="true" />}
                  cause={
                    term === ''
                      ? 'Nothing on this counter matches an empty search.'
                      : `Nothing on this counter matches "${term}".`
                  }
                  nextAction="Try the generic name, or check the item is stocked at this counter rather than in the main store."
                />
              }
            >
              <ul className="flex flex-col gap-2" data-testid="otc-stock">
                {rows.map((row) => {
                  const verdict = otcVerdict(row.schedule, row.itemName);
                  const rowKey = `${row.itemId}:${row.batchId ?? 'none'}`;
                  return (
                    <li
                      key={rowKey}
                      data-testid={`stock-row-${row.itemCode}`}
                      className="flex flex-col gap-2 rounded-md border border-default bg-layer-2 p-3"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-md text-fg-default">{row.itemName}</span>
                        <span className="font-mono text-2xs text-fg-subtle">{row.itemCode}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 font-mono text-2xs text-fg-muted">
                        <span>Batch {row.batchNo ?? '—'}</span>
                        <span>Exp {formatDate(row.expiryDate)}</span>
                        <span>{formatQty(row.qtyOnHand)} on hand</span>
                        <span>MRP {formatMoney(row.mrp)}</span>
                      </div>

                      {verdict.kind === 'refused' ? (
                        <p
                          role="note"
                          data-testid={`otc-refused-${row.itemCode}`}
                          className="flex items-start gap-2 rounded-md border border-danger-border bg-danger-surface p-2 text-sm text-danger-on-surface"
                        >
                          <OctagonAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                          {verdict.message}
                        </p>
                      ) : (
                        <div className="flex flex-wrap items-end gap-2">
                          <div className="flex w-24 flex-col gap-1">
                            <Label htmlFor={`qty-${rowKey}`}>Units</Label>
                            <Input
                              id={`qty-${rowKey}`}
                              data-testid={`qty-${row.itemCode}`}
                              inputMode="decimal"
                              value={qty[rowKey] ?? ''}
                              onChange={(event) => {
                                setQty((previous) => ({ ...previous, [rowKey]: event.target.value }));
                              }}
                            />
                          </div>
                          <Button
                            variant="secondary"
                            size="sm"
                            data-testid={`add-${row.itemCode}`}
                            disabled={
                              dispenseId === null ||
                              addLine.isPending ||
                              !Number.isFinite(Number(qty[rowKey])) ||
                              Number(qty[rowKey] ?? '0') <= 0
                            }
                            onClick={() => {
                              addLine.mutate({ row, quantity: Number(qty[rowKey] ?? '0') });
                            }}
                          >
                            Add to sale
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </AsyncPanel>
          )}
        </section>

        <section className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
          <h2 className="font-display text-2xs uppercase tracking-[0.08em] text-fg-subtle">The sale</h2>

          {dispenseId === null ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-fg-muted">
                A sale identifies somebody. A name and, where they will give it, a phone number — not a
                registration: a person buying a bandage should not have to become a patient.
              </p>
              <div className="flex flex-col gap-1">
                <Label htmlFor="walkin-name">Customer name</Label>
                <Input
                  id="walkin-name"
                  data-testid="walkin-name"
                  value={walkInName}
                  onChange={(event) => {
                    setWalkInName(event.target.value);
                  }}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="walkin-phone">Phone (optional)</Label>
                <Input
                  id="walkin-phone"
                  data-testid="walkin-phone"
                  inputMode="tel"
                  value={walkInPhone}
                  onChange={(event) => {
                    setWalkInPhone(event.target.value);
                  }}
                />
              </div>
              <Button
                variant="primary"
                data-testid="open-sale"
                disabled={walkInName.trim() === '' || storeId === '' || !canDispense || openSale.isPending}
                onClick={() => {
                  openSale.mutate();
                }}
              >
                {openSale.isPending ? 'Opening…' : 'Open the sale'}
              </Button>
              {openSale.error === null ? null : <ProblemCard error={openSale.error} />}
            </div>
          ) : (
            <AsyncPanel
              loading={sale.isPending}
              error={sale.error}
              isEmpty={current === null}
              skeletonLabel="Loading the sale"
              skeletonRows={4}
              onRetry={() => void sale.refetch()}
              empty={
                <EmptyState
                  cause="The sale could not be read back."
                  nextAction="Try again. Nothing has left the shelf — an over-the-counter sale moves stock only when it is completed."
                />
              }
            >
              {current === null ? null : (
                <div className="flex flex-col gap-3" data-testid="sale-panel">
                  <p className="font-mono text-md text-fg-default">{current.dispenseNo}</p>
                  {current.items.length === 0 ? (
                    <EmptyState
                      cause="Nothing on this sale yet."
                      nextAction="Add an item from the shelf on the left. A Schedule H, H1 or X medicine cannot be added here at all."
                    />
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {current.items.map((item) => (
                        <li key={item.id} className="flex flex-wrap justify-between gap-2 text-sm">
                          <span className="text-fg-default">
                            {item.itemName}
                            <Badge tone="neutral" className="ms-2">
                              {humanise(item.status)}
                            </Badge>
                          </span>
                          <span className="font-mono text-fg-muted">
                            {formatQty(item.qtyEntered)} × {formatMoney(item.sellingPrice)} ={' '}
                            {formatMoney(item.lineTotal)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-md text-fg-default">
                    Total <span className="font-mono">{formatMoney(current.totalAmount)}</span> including{' '}
                    <span className="font-mono">{formatMoney(current.taxAmount)}</span> GST
                  </p>
                  <p className="text-2xs text-fg-muted">
                    Completing the sale and taking payment happens on the dispensing counter, which runs the
                    same safety checks on the same dispense. Nothing has left the shelf yet.
                  </p>
                  {addLine.error === null ? null : <ProblemCard error={addLine.error} />}
                </div>
              )}
            </AsyncPanel>
          )}
        </section>
      </div>
    </section>
  );
}
