'use client';

import { useMutation } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, Textarea, useToast } from '@vims/ui';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { StorePicker } from '@/features/inventory/components/store-picker';
import { useCursorList } from '@/features/inventory/lib/cursor-list';
import { worklistLabels } from '@/features/inventory/lib/worklist-labels';
import { WorklistTable } from '@vims/ui';
import { Lock } from '@/lib/icons';
import { useSession } from '@/lib/session-context';
import { listRegisterEntries, recordCustodyCheck, recordRegisterEntry } from '../api/client';
import { pharmacyKeys } from '../api/keys';
import type { CoSignerInput, RegisterEntryView } from '../api/types';
import { formatInstant, formatQty, humanise } from '../lib/format';
import { CoSignDialog } from './cosign-dialog';

/**
 * OP-003 §3.6 — the NDPS, Schedule X and Schedule H1 registers, and `phase-04`
 * exit gate 4: "narcotic issue requires two users; the register balances against
 * physical count; a deliberate mismatch raises an alert and cannot be silently
 * adjusted".
 *
 * ── Two people, twice ───────────────────────────────────────────────────────
 *
 * Both writes on this screen — a register entry and a shift custody check — take
 * a co-signer, and the co-signer is a **credential**, not a name. The dialog
 * asks the second pharmacist for their own password; `PharmacyCoSignService`
 * verifies it with Argon2, refuses the acting user's own id outright ("Two
 * signatures from one person are one signature"), and checks the second person
 * holds the authority themselves. There is no checkbox anywhere on this screen,
 * and no field that names a colleague without proving they were there.
 *
 * ── Why a variance cannot be typed away ─────────────────────────────────────
 *
 * When the physical count disagrees with the register, the API requires the
 * count to carry the **posted, maker-checked stock adjustment** that reconciles
 * the shelf — at the moment the count is filed, because
 * `pharmacy.narcotic_custody_checks` has `UPDATE` revoked and a row filed
 * without one can never acquire one. So the form asks for the adjustment id and
 * says why, rather than letting somebody file a variance now and promise to
 * explain it later. Until that is done,
 * `pharmacy.enforce_day_close_preconditions` refuses the day close for that
 * date — which is the alert, and it is not dismissible either.
 */
const REGISTER_TYPES: readonly { readonly value: string; readonly label: string }[] = [
  { value: '', label: 'All registers' },
  { value: 'ndps', label: 'NDPS — narcotics & psychotropics' },
  { value: 'schedule_x', label: 'Schedule X' },
  { value: 'schedule_h1', label: 'Schedule H1' },
];

type PendingWrite =
  | { readonly kind: 'entry'; readonly txnType: 'receipt' | 'issue' | 'return_in' }
  | { readonly kind: 'custody' };

export function ControlledRegisterScreen(): React.JSX.Element {
  const { hospitalId, granted, displayName } = useSession();
  const keys = pharmacyKeys(hospitalId);
  const { publish } = useToast();

  const [storeId, setStoreId] = useState('');
  const [registerType, setRegisterType] = useState('');
  const [itemId, setItemId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [patientName, setPatientName] = useState('');
  const [prescriberName, setPrescriberName] = useState('');
  const [prescriberRegNo, setPrescriberRegNo] = useState('');
  const [remarks, setRemarks] = useState('');
  const [shiftLabel, setShiftLabel] = useState('');
  const [physicalCount, setPhysicalCount] = useState('');
  const [explanation, setExplanation] = useState('');
  const [adjustmentId, setAdjustmentId] = useState('');
  const [pending, setPending] = useState<PendingWrite | null>(null);

  const canPrepare = granted.has('pharmacy.narcotic.prepare');

  const register = useCursorList<RegisterEntryView>({
    queryKey: keys.register(storeId, registerType === '' ? 'all' : registerType, 'paged'),
    fetchPage: (cursor, signal) =>
      listRegisterEntries(
        {
          storeId: storeId === '' ? undefined : storeId,
          registerType:
            registerType === '' ? undefined : (registerType as 'ndps' | 'schedule_x' | 'schedule_h1'),
          cursor,
        },
        signal === undefined ? {} : { signal },
      ),
    enabled: storeId !== '',
  });

  const entry = useMutation({
    mutationFn: (input: {
      readonly coSigner: CoSignerInput;
      readonly txnType: 'receipt' | 'issue' | 'return_in';
    }) =>
      recordRegisterEntry({
        storeId,
        itemId: itemId.trim(),
        txnType: input.txnType,
        qtyEntered: Number(quantity),
        ...(patientName.trim() === '' ? {} : { patientName: patientName.trim() }),
        ...(prescriberName.trim() === '' ? {} : { prescriberName: prescriberName.trim() }),
        ...(prescriberRegNo.trim() === '' ? {} : { prescriberRegNo: prescriberRegNo.trim() }),
        ...(remarks.trim() === '' ? {} : { remarks: remarks.trim() }),
        coSigner: input.coSigner,
      }),
    onSuccess: (created) => {
      setPending(null);
      setQuantity('');
      setRemarks('');
      register.refetch();
      publish({
        title: `Register entry ${created.serialNo}`,
        description: `Balance after this entry: ${created.balanceAfterBase}. Both signatures are on the row.`,
        severity: 'success',
      });
    },
  });

  const custody = useMutation({
    mutationFn: (coSigner: CoSignerInput) =>
      recordCustodyCheck({
        storeId,
        itemId: itemId.trim(),
        shiftLabel: shiftLabel.trim(),
        physicalCountEntered: Number(physicalCount),
        ...(explanation.trim() === '' ? {} : { explanation: explanation.trim() }),
        ...(adjustmentId.trim() === '' ? {} : { adjustmentId: adjustmentId.trim() }),
        coSigner,
      }),
    onSuccess: (check) => {
      setPending(null);
      setPhysicalCount('');
      setExplanation('');
      setAdjustmentId('');
      register.refetch();
      const variance = Number(check.varianceBase);
      publish({
        title: variance === 0 ? 'Custody check balances' : `Variance of ${check.varianceBase}`,
        description:
          variance === 0
            ? 'The shelf agrees with the register. Both counters have signed.'
            : 'The variance is recorded with its adjustment. The day close for this date stays refused until it is resolved.',
        severity: variance === 0 ? 'success' : 'warning',
      });
    },
  });

  const entryReady = itemId.trim() !== '' && Number(quantity) > 0 && storeId !== '';
  const custodyReady = itemId.trim() !== '' && shiftLabel.trim() !== '' && physicalCount.trim() !== '';

  return (
    <section className="flex flex-col gap-4" data-testid="controlled-register-screen">
      <PageHeader
        eyebrow="OP-003 · NDPS"
        title="Controlled-drug register"
        description="A bound book that cannot be edited: entries are gapless and serially numbered, corrections are reversals, and every write takes two authorised pharmacists signing with their own passwords."
        actions={
          <div className="flex flex-wrap items-end gap-3">
            <StorePicker value={storeId} onChange={setStoreId} label="Store" />
            <div className="flex min-w-56 flex-col gap-1">
              <Label htmlFor="register-type">Register</Label>
              <select
                id="register-type"
                data-testid="register-type"
                className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                value={registerType}
                onChange={(event) => {
                  setRegisterType(event.target.value);
                }}
              >
                {REGISTER_TYPES.map((entryType) => (
                  <option key={entryType.value} value={entryType.value}>
                    {entryType.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        }
      />

      {storeId === '' ? (
        <EmptyState
          cause="No store chosen yet."
          nextAction="A controlled-drug register belongs to a store's safe, not to the hospital. Choose the one you are working in."
        />
      ) : (
        <AsyncPanel
          loading={register.isPending}
          error={register.error}
          isEmpty={register.items.length === 0}
          skeletonLabel="Loading the register"
          skeletonRows={8}
          onRetry={register.refetch}
          empty={
            <EmptyState
              cause="This register has no entries yet."
              nextAction="Every receipt, issue and return of a controlled drug in this store appears here, gapless and serially numbered. Record the opening receipt to start it."
            />
          }
        >
          <WorklistTable<RegisterEntryView>
            rows={register.items}
            getRowId={(row) => row.id}
            labels={worklistLabels('Controlled-drug register entries')}
            empty={{
              cause: 'This register has no entries yet.',
              nextAction: 'Record the opening receipt to start it.',
            }}
            hasMore={register.hasMore}
            loading={register.isFetching}
            onLoadMore={register.loadMore}
            columns={[
              {
                key: 'serial',
                header: 'Serial',
                hideable: false,
                render: (row) => (
                  <span className="font-mono text-xs">
                    {row.serialNo}
                    <span className="ms-1 text-fg-subtle">{row.fy}</span>
                  </span>
                ),
              },
              {
                key: 'register',
                header: 'Register',
                render: (row) => <Badge tone="violet">{humanise(row.registerType)}</Badge>,
              },
              { key: 'item', header: 'Item', render: (row) => row.itemCode },
              { key: 'txn', header: 'Movement', render: (row) => humanise(row.txnType) },
              {
                key: 'in',
                header: 'In',
                numeric: true,
                render: (row) => formatQty(row.qtyInBase),
              },
              {
                key: 'out',
                header: 'Out',
                numeric: true,
                render: (row) => formatQty(row.qtyOutBase),
              },
              {
                key: 'balance',
                header: 'Balance',
                numeric: true,
                hideable: false,
                render: (row) => <span className="font-mono">{formatQty(row.balanceAfterBase)}</span>,
              },
              {
                key: 'signatures',
                header: 'Signatures',
                hideable: false,
                render: (row) => (
                  <Badge tone={row.secondAuthUserId === null ? 'danger' : 'success'}>
                    {row.secondAuthUserId === null ? 'One signature' : 'Two signatures'}
                  </Badge>
                ),
              },
              {
                key: 'when',
                header: 'Entered',
                importance: 'secondary',
                render: (row) => <span className="font-mono text-xs">{formatInstant(row.enteredAt)}</span>,
              },
              {
                key: 'prescriber',
                header: 'Prescriber',
                importance: 'secondary',
                render: (row) =>
                  row.prescriberName === null
                    ? '—'
                    : `${row.prescriberName}${row.prescriberRegNo === null ? '' : ` (${row.prescriberRegNo})`}`,
              },
            ]}
          />
        </AsyncPanel>
      )}

      {!canPrepare ? (
        <p className="text-sm text-fg-muted">
          Making an entry needs <span className="font-mono">pharmacy.narcotic.prepare</span> — and a second
          authorised pharmacist. You can read the register.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
            <h2 className="text-md font-medium text-fg-default">Make an entry</h2>
            <p className="text-sm text-fg-muted">
              A receipt, an issue or a return. There is deliberately no &ldquo;adjustment&rdquo; here: a
              correction to a controlled balance is a stock adjustment first, with a maker, a checker and a
              ledger row, and it reaches this register through the custody check that found it.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="reg-item">Item id</Label>
                <Input
                  id="reg-item"
                  data-testid="reg-item"
                  value={itemId}
                  onChange={(event) => {
                    setItemId(event.target.value);
                  }}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="reg-qty">Quantity</Label>
                <Input
                  id="reg-qty"
                  data-testid="reg-qty"
                  inputMode="decimal"
                  value={quantity}
                  onChange={(event) => {
                    setQuantity(event.target.value);
                  }}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="reg-patient">Patient name (for an issue)</Label>
                <Input
                  id="reg-patient"
                  data-testid="reg-patient"
                  value={patientName}
                  onChange={(event) => {
                    setPatientName(event.target.value);
                  }}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="reg-prescriber">Prescriber</Label>
                <Input
                  id="reg-prescriber"
                  data-testid="reg-prescriber"
                  value={prescriberName}
                  onChange={(event) => {
                    setPrescriberName(event.target.value);
                  }}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="reg-regno">Prescriber registration no.</Label>
                <Input
                  id="reg-regno"
                  data-testid="reg-regno"
                  value={prescriberRegNo}
                  onChange={(event) => {
                    setPrescriberRegNo(event.target.value);
                  }}
                />
              </div>
              <div className="flex flex-col gap-1 sm:col-span-2">
                <Label htmlFor="reg-remarks">Remarks</Label>
                <Textarea
                  id="reg-remarks"
                  data-testid="reg-remarks"
                  rows={2}
                  value={remarks}
                  onChange={(event) => {
                    setRemarks(event.target.value);
                  }}
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {(['receipt', 'issue', 'return_in'] as const).map((txnType) => (
                <Button
                  key={txnType}
                  variant="secondary"
                  data-testid={`entry-${txnType}`}
                  disabled={!entryReady}
                  onClick={() => {
                    setPending({ kind: 'entry', txnType });
                  }}
                >
                  <Lock aria-hidden="true" className="size-4" />
                  {humanise(txnType)} — two signatures
                </Button>
              ))}
            </div>
            {entry.error === null ? null : <ProblemCard error={entry.error} />}
          </section>

          <section className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
            <h2 className="text-md font-medium text-fg-default">Shift custody check</h2>
            <p className="text-sm text-fg-muted">
              Two people count the safe and both sign. If the count disagrees with the register, the posted
              stock adjustment that reconciles it is required <em>now</em> — this row can never be edited
              afterwards, and the day close for this date stays refused until the variance is resolved.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="custody-shift">Shift</Label>
                <Input
                  id="custody-shift"
                  data-testid="custody-shift"
                  value={shiftLabel}
                  placeholder="e.g. 14:00–22:00"
                  onChange={(event) => {
                    setShiftLabel(event.target.value);
                  }}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="custody-count">Physical count</Label>
                <Input
                  id="custody-count"
                  data-testid="custody-count"
                  inputMode="decimal"
                  value={physicalCount}
                  onChange={(event) => {
                    setPhysicalCount(event.target.value);
                  }}
                />
              </div>
              <div className="flex flex-col gap-1 sm:col-span-2">
                <Label htmlFor="custody-explanation">If it disagrees — what happened?</Label>
                <Textarea
                  id="custody-explanation"
                  data-testid="custody-explanation"
                  rows={2}
                  value={explanation}
                  onChange={(event) => {
                    setExplanation(event.target.value);
                  }}
                />
              </div>
              <div className="flex flex-col gap-1 sm:col-span-2">
                <Label htmlFor="custody-adjustment">
                  Posted stock-adjustment id that reconciles the shelf
                </Label>
                <Input
                  id="custody-adjustment"
                  data-testid="custody-adjustment"
                  value={adjustmentId}
                  onChange={(event) => {
                    setAdjustmentId(event.target.value);
                  }}
                />
                <p className="text-2xs text-fg-muted">
                  Required when the count disagrees. Raise it on the adjustments screen first — it needs its
                  own maker and checker — and paste its id here.
                </p>
              </div>
            </div>
            <Button
              variant="secondary"
              className="self-start"
              data-testid="file-custody-check"
              disabled={!custodyReady}
              onClick={() => {
                setPending({ kind: 'custody' });
              }}
            >
              <Lock aria-hidden="true" className="size-4" />
              File the count — two signatures
            </Button>
            {custody.error === null ? null : <ProblemCard error={custody.error} />}
          </section>
        </div>
      )}

      <CoSignDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending?.kind === 'custody' ? 'Second counter' : 'Second authorising pharmacist'}
        purpose={
          pending?.kind === 'custody'
            ? 'A shift custody check is signed by both people who counted the safe.'
            : 'Every movement of a controlled drug is signed by two authorised pharmacists.'
        }
        actingUserName={displayName}
        pending={entry.isPending || custody.isPending}
        error={entry.error ?? custody.error}
        onConfirm={(coSigner) => {
          if (pending === null) return;
          if (pending.kind === 'custody') custody.mutate(coSigner);
          else entry.mutate({ coSigner, txnType: pending.txnType });
        }}
      />
    </section>
  );
}
