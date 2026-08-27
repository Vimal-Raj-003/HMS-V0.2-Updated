'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Checkbox, EmptyState, Input, Label, Textarea, useToast } from '@vims/ui';
import { useCallback, useMemo, useRef, useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { ShortcutBar } from '@/features/frontoffice/components/keyboard-sheet';
import type { Shortcut } from '@/features/frontoffice/lib/shortcuts';
import { StorePicker } from '@/features/inventory/components/store-picker';
import { useCursorList } from '@/features/inventory/lib/cursor-list';
import { Lock, OctagonAlert, ScanSearch } from '@/lib/icons';
import { newIdempotencyKey } from '@/features/clinical/api/http';
import { useSession } from '@/lib/session-context';
import {
  addDispenseItem,
  addSecondAuthoriser,
  completeDispense,
  createDispense,
  declineDispenseItem,
  getDispense,
  listRxQueue,
  markArrived,
  printLabels,
} from '../api/client';
import { pharmacyKeys } from '../api/keys';
import { useCounterShortcuts } from '../lib/counter-shortcuts';
import type { CoSignerInput, DispenseView, IdentityMethod, LabelView, RxQueueView } from '../api/types';
import {
  EMPTY_SCAN_LINE,
  LABEL_SECOND_LOCALES,
  advisoryHardStops,
  blockingHardStops,
  canPostScan,
  completionVerdict,
  isPartialFill,
  labelLocales,
  scanProblems,
  secondPersonVerdict,
  toCompleteRequest,
  type ScanLineDraft,
} from '../lib/counter';
import { formatDate, formatMoney, formatQty, humanise } from '../lib/format';
import { CoSignDialog } from './cosign-dialog';
import { HardStopPanel } from './hard-stop-panel';
import { LabelPreview } from './label-preview';
import { PatientIdentityPanel, patientRef } from './patient-identity-panel';

/**
 * OP-003 §3.2 — the dispensing counter, and the screen `phase-04` exit gate 2
 * is measured against: "dispense a 4-item prescription in ≤ 45 seconds with
 * barcode scanning".
 *
 * ── Why the queue is on this screen and not a link away ─────────────────────
 *
 * Forty-five seconds does not survive a page navigation, and a route carrying a
 * queue id would put a prescription reference in the address bar. So the queue,
 * the identity check and the dispense are one screen: select, verify, scan,
 * scan, scan, scan, complete — with the scan field holding focus throughout.
 *
 * ── How the time budget is actually spent ───────────────────────────────────
 *
 *  - **No waterfall.** Every mutation returns the whole `DispenseView`, and the
 *    response is written straight into the query cache with `setQueryData`.
 *    Nothing on this screen posts and then refetches to find out what happened.
 *  - **Focus never leaves the scan field.** A successful line clears the draft
 *    and refocuses; `Enter` moves scan → quantity → post. A scanner is a
 *    keyboard that types very fast and then presses Enter, so the whole loop for
 *    one item is: scan, type the count, Enter.
 *  - **Nothing is optimistic that touches stock.** `phase-04 §Constraints`: fail
 *    closed on stock integrity. A line appears when the API has validated its
 *    batch and not a frame before, because an optimistic line is a promise about
 *    a shelf the counter cannot see.
 *
 * ── The refusals ────────────────────────────────────────────────────────────
 *
 *  1. **Allergy and interaction are hard stops.** `HardStopPanel` has no close
 *     button and this screen has no state that hides it. The only path is a
 *     recorded reason, which travels on the completion request.
 *  2. **A narcotic needs a second pharmacist**, signed in themselves, *before*
 *     the controlled line is scanned — because `pharmacy.enforce_dispense_line`
 *     reads `second_auth_user_id` when the line is inserted, so a signature
 *     taken afterwards would be a signature for something the second pharmacist
 *     never saw.
 *  3. **The completion key is minted once per press** and reused by every retry,
 *     because a regenerated key is the same as no key, and here that means two
 *     bags off one shelf.
 */
const IDENTITY_METHODS: readonly { readonly value: IdentityMethod; readonly label: string }[] = [
  { value: 'uhid_scan', label: 'Scanned the UHID on the OP slip' },
  { value: 'wristband_scan', label: 'Scanned the wristband' },
  { value: 'abha_verified', label: 'Verified through ABHA' },
  { value: 'photo_id', label: 'Checked a photo ID' },
  { value: 'two_identifiers_verbal', label: 'Asked for two identifiers (name and date of birth)' },
  { value: 'attendant_verified', label: 'Attendant collected — identity confirmed with them' },
];

export function DispenseCounterScreen(): React.JSX.Element {
  const { hospitalId, granted, userId, displayName } = useSession();
  const keys = pharmacyKeys(hospitalId);
  const queryClient = useQueryClient();
  const { publish } = useToast();

  const [storeId, setStoreId] = useState('');
  const [selected, setSelected] = useState<RxQueueView | null>(null);
  const [identityMethod, setIdentityMethod] = useState<IdentityMethod>('uhid_scan');
  const [dispenseId, setDispenseId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScanLineDraft>(EMPTY_SCAN_LINE);
  const [acknowledgements, setAcknowledgements] = useState<ReadonlyMap<string, string>>(new Map());
  const [secondLocale, setSecondLocale] = useState('hi');
  const [counselled, setCounselled] = useState(false);
  const [coSignOpen, setCoSignOpen] = useState(false);
  const [labels, setLabels] = useState<readonly LabelView[]>([]);
  const [completeKey, setCompleteKey] = useState<string | null>(null);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState('');

  const scanRef = useRef<HTMLInputElement | null>(null);
  const qtyRef = useRef<HTMLInputElement | null>(null);

  const canQueue = granted.has('pharmacy.queue.list');
  const canManageQueue = granted.has('pharmacy.queue.manage');
  const canComplete = granted.has('pharmacy.dispense.complete');
  const canPrepareControlled = granted.has('pharmacy.narcotic.prepare');
  const canLabel = granted.has('pharmacy.label.print');

  const queue = useCursorList<RxQueueView>({
    queryKey: keys.queue(storeId, 'open', 'paged'),
    fetchPage: (cursor, signal) =>
      listRxQueue({ pharmacyStoreId: storeId, cursor }, signal === undefined ? {} : { signal }),
    enabled: canQueue && storeId !== '',
    refetchInterval: 30_000,
  });

  const dispense = useQuery({
    queryKey: keys.dispense(dispenseId ?? 'none'),
    queryFn: ({ signal }) =>
      dispenseId === null ? Promise.reject(new Error('no dispense')) : getDispense(dispenseId, { signal }),
    enabled: dispenseId !== null,
  });

  const current = dispense.data ?? null;

  /** Every mutation lands the whole view in the cache — no follow-up read. */
  const land = useCallback(
    (view: DispenseView): void => {
      setDispenseId(view.id);
      queryClient.setQueryData(keys.dispense(view.id), view);
    },
    [queryClient, keys],
  );

  const focusScan = useCallback((): void => {
    scanRef.current?.focus();
    scanRef.current?.select();
  }, []);

  const arrive = useMutation({
    mutationFn: (entry: RxQueueView) => markArrived(entry.id, identityMethod),
    onSuccess: (updated) => {
      setSelected(updated);
      queue.refetch();
      publish({
        title: 'Identity verified',
        description: 'How it was verified is recorded on the queue entry, not just that it was.',
        severity: 'success',
      });
    },
  });

  const start = useMutation({
    mutationFn: (entry: RxQueueView) =>
      createDispense({
        pharmacyStoreId: storeId,
        dispenseType: 'rx',
        prescriptionId: entry.prescriptionId,
        rxQueueId: entry.id,
        patientId: entry.patientId,
        payerType: 'cash',
      }),
    onSuccess: (view) => {
      land(view);
      setDraft(EMPTY_SCAN_LINE);
      setAcknowledgements(new Map());
      setLabels([]);
      setCompleteKey(null);
      window.setTimeout(focusScan, 0);
    },
  });

  const addItem = useMutation({
    mutationFn: (input: ScanLineDraft) => {
      if (dispenseId === null) throw new Error('No dispense is open.');
      const partial = input.partialReason.trim();
      const ordered = Number(input.qtyOrderedBase);
      const fefo = input.fefoOverrideReason.trim();
      return addDispenseItem(dispenseId, {
        scanned: input.scanned.trim(),
        qtyEntered: Number(input.qtyEntered),
        ...(Number.isFinite(ordered) && ordered > 0 ? { qtyOrderedBase: ordered } : {}),
        ...(partial === '' ? {} : { partialReason: partial }),
        ...(fefo === '' ? {} : { fefoOverrideReason: fefo }),
      });
    },
    onSuccess: (view) => {
      land(view);
      setDraft(EMPTY_SCAN_LINE);
      window.setTimeout(focusScan, 0);
    },
  });

  const coSign = useMutation({
    mutationFn: (coSigner: CoSignerInput) => {
      if (dispenseId === null) throw new Error('No dispense is open.');
      return addSecondAuthoriser(dispenseId, { coSigner });
    },
    onSuccess: (view) => {
      land(view);
      setCoSignOpen(false);
      publish({
        title: 'Second pharmacist recorded',
        description: 'The controlled line can now be scanned. Both signatures are on the register entry.',
        severity: 'success',
      });
      window.setTimeout(focusScan, 0);
    },
  });

  const decline = useMutation({
    mutationFn: (input: { readonly itemId: string; readonly reason: string }) => {
      if (dispenseId === null) throw new Error('No dispense is open.');
      return declineDispenseItem(dispenseId, {
        itemId: input.itemId,
        status: 'backordered',
        reason: input.reason,
      });
    },
    onSuccess: (view) => {
      land(view);
      setDeclineOpen(false);
      setDeclineReason('');
    },
  });

  const complete = useMutation({
    mutationFn: () => {
      if (dispenseId === null || current === null) throw new Error('No dispense is open.');
      const key = completeKey ?? newIdempotencyKey();
      if (completeKey === null) setCompleteKey(key);
      return completeDispense(
        dispenseId,
        toCompleteRequest(current, acknowledgements, { counselled, language: secondLocale }),
        key,
      );
    },
    onSuccess: (view) => {
      land(view);
      setCompleteKey(null);
      queue.refetch();
      publish({
        title: `Dispensed — ${view.dispenseNo}`,
        description:
          'The stock has left the shelf batch by batch and the prescriber has been told. Print the labels before the bag goes over the counter.',
        severity: 'success',
      });
    },
  });

  const label = useMutation({
    mutationFn: () => {
      if (dispenseId === null) throw new Error('No dispense is open.');
      return printLabels(dispenseId, labelLocales(secondLocale));
    },
    onSuccess: (result) => {
      setLabels(result.labels);
    },
  });

  const blocking = current === null ? [] : blockingHardStops(current);
  const advisory = current === null ? [] : advisoryHardStops(current);
  const verdict = current === null ? null : completionVerdict(current, acknowledgements);
  const second = current === null ? null : secondPersonVerdict(current);
  const problems = scanProblems(draft);

  function postScan(): void {
    if (!canPostScan(draft) || addItem.isPending) return;
    addItem.mutate(draft);
  }

  const shortcuts: readonly Shortcut[] = useMemo(
    () => [
      {
        key: 'F3',
        label: 'Verify the patient at the counter',
        keys: ['F3'],
        enabled: selected !== null && !selected.identityVerified && canManageQueue,
        run: () => {
          if (selected !== null) arrive.mutate(selected);
        },
      },
      {
        key: 'F2',
        label: 'Open the dispense',
        keys: ['F2'],
        enabled: selected !== null && selected.identityVerified && dispenseId === null && !start.isPending,
        run: () => {
          if (selected !== null) start.mutate(selected);
        },
      },
      {
        key: 'F4',
        label: 'Jump to the scan field',
        keys: ['F4'],
        enabled: dispenseId !== null,
        run: focusScan,
      },
      {
        key: 'F7',
        label: 'Record a partial fill reason',
        keys: ['F7'],
        enabled: dispenseId !== null,
        run: () => {
          document.getElementById('scan-partial-reason')?.focus();
        },
      },
      {
        key: 'F8',
        label: 'Print the labels (English + one more)',
        keys: ['F8'],
        enabled: dispenseId !== null && canLabel && !label.isPending,
        run: () => {
          label.mutate();
        },
      },
      {
        key: 'F9',
        label: 'Ask a second pharmacist to countersign',
        keys: ['F9'],
        enabled: dispenseId !== null && canPrepareControlled,
        run: () => {
          setCoSignOpen(true);
        },
      },
      {
        key: 'F10',
        label: 'Complete the dispense',
        keys: ['F10'],
        enabled: verdict?.kind === 'permitted' && canComplete && !complete.isPending,
        run: () => {
          complete.mutate();
        },
      },
      {
        key: 'Escape',
        label: 'Back to the queue',
        keys: ['Esc'],
        enabled: dispenseId !== null,
        run: () => {
          setDispenseId(null);
          setSelected(null);
          setLabels([]);
        },
      },
    ],
    [
      selected,
      dispenseId,
      verdict,
      canManageQueue,
      canComplete,
      canLabel,
      canPrepareControlled,
      arrive,
      start,
      complete,
      label,
      focusScan,
    ],
  );
  useCounterShortcuts(shortcuts);

  return (
    <section className="flex flex-col gap-4" data-testid="dispense-counter-screen">
      <PageHeader
        eyebrow="OP-003 · the counter"
        title="Dispensing counter"
        description="Scan the patient, then scan each pack. The batch is validated at the scan, not at the till — nothing reaches the bag that has not been checked against the shelf."
        actions={<StorePicker storeType="pharmacy" value={storeId} onChange={setStoreId} label="Counter" />}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)]">
        {/* ── the queue ──────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
          <h2 className="font-display text-2xs uppercase tracking-[0.08em] text-fg-subtle">
            Waiting at this counter
          </h2>

          {!canQueue ? (
            <EmptyState
              cause="You cannot see the prescription queue."
              nextAction="The queue is a separate permission (pharmacy.queue.list) from dispensing. Ask your hospital administrator to grant it."
            />
          ) : storeId === '' ? (
            <EmptyState
              cause="No counter chosen yet."
              nextAction="Choose the counter you are working at. Everything on this screen — the queue, the shelf and the day close — is of one store."
            />
          ) : (
            <AsyncPanel
              loading={queue.isPending}
              error={queue.error}
              isEmpty={queue.items.length === 0}
              skeletonLabel="Loading the prescription queue"
              skeletonRows={6}
              onRetry={queue.refetch}
              empty={
                <EmptyState
                  cause="No prescriptions are waiting at this counter."
                  nextAction="A prescription appears here within a second of a doctor signing it. If one was expected, check the counter above is the one it was sent to."
                />
              }
            >
              <ul className="flex flex-col gap-2" data-testid="rx-queue">
                {queue.items.map((entry) => {
                  const active = selected?.id === entry.id;
                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        data-testid={`queue-entry-${entry.id}`}
                        aria-current={active}
                        onClick={() => {
                          setSelected(entry);
                          setDispenseId(null);
                          setLabels([]);
                        }}
                        className={`flex w-full flex-col gap-1 rounded-md border p-3 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                          active ? 'border-focus bg-layer-3' : 'border-default bg-layer-2 hover:bg-layer-3'
                        }`}
                      >
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm text-fg-default">
                            {patientRef(entry.patientId)}
                          </span>
                          <Badge tone={entry.priority > 0 ? 'danger' : 'neutral'}>
                            {entry.priority > 0 ? `Priority ${String(entry.priority)}` : 'Routine'}
                          </Badge>
                          {entry.hasAllergyFlag ? (
                            <Badge tone="danger" icon={<OctagonAlert aria-hidden="true" />}>
                              Allergy on file
                            </Badge>
                          ) : null}
                          {entry.hasControlled ? (
                            <Badge tone="violet" icon={<Lock aria-hidden="true" />}>
                              Controlled
                            </Badge>
                          ) : null}
                        </span>
                        <span className="text-2xs text-fg-muted">
                          {entry.itemCount} item{entry.itemCount === 1 ? '' : 's'} · {humanise(entry.status)}
                          {entry.identityVerified ? ' · identity verified' : ' · identity not verified'}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {queue.hasMore ? (
                <Button variant="secondary" size="sm" onClick={queue.loadMore} disabled={queue.isFetching}>
                  {queue.isFetching ? 'Loading the next page…' : 'Load the next page'}
                </Button>
              ) : null}
            </AsyncPanel>
          )}
        </section>

        {/* ── the workspace ─────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          {selected === null ? (
            <EmptyState
              icon={<ScanSearch aria-hidden="true" />}
              cause="No prescription selected."
              nextAction="Pick one from the queue beside this panel. Nothing can be scanned until a patient has been identified."
            />
          ) : (
            <>
              <PatientIdentityPanel patientId={selected.patientId} />

              {!selected.identityVerified ? (
                <div
                  className="flex flex-col gap-3 rounded-lg border border-warning-border bg-warning-surface p-4"
                  data-testid="identity-check"
                >
                  <p className="text-md font-medium text-warning-on-surface">
                    Confirm who is standing at the counter before anything is scanned.
                  </p>
                  <p className="text-sm text-warning-on-surface">
                    How you checked is recorded, not merely that you did. &ldquo;We checked&rdquo; is not
                    evidence, and a scanned wristband and a verbal answer are not the same fact.
                  </p>
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="flex min-w-72 flex-col gap-1">
                      <Label htmlFor="identity-method">How was the identity established?</Label>
                      <select
                        id="identity-method"
                        data-testid="identity-method"
                        className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                        value={identityMethod}
                        onChange={(event) => {
                          setIdentityMethod(event.target.value as IdentityMethod);
                        }}
                      >
                        {IDENTITY_METHODS.map((method) => (
                          <option key={method.value} value={method.value}>
                            {method.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <Button
                      variant="primary"
                      data-testid="confirm-identity"
                      disabled={!canManageQueue || arrive.isPending}
                      onClick={() => {
                        arrive.mutate(selected);
                      }}
                    >
                      {arrive.isPending ? 'Recording…' : 'Patient is at the counter (F3)'}
                    </Button>
                  </div>
                  {arrive.error === null ? null : <ProblemCard error={arrive.error} />}
                </div>
              ) : dispenseId === null ? (
                <div className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
                  <p className="text-md font-medium text-fg-default">
                    Identity verified — {humanise(selected.identityMethod)}
                  </p>
                  <Button
                    variant="primary"
                    data-testid="start-dispense"
                    disabled={start.isPending || storeId === ''}
                    onClick={() => {
                      start.mutate(selected);
                    }}
                  >
                    {start.isPending ? 'Opening…' : 'Start dispensing (F2)'}
                  </Button>
                  {start.error === null ? null : <ProblemCard error={start.error} />}
                </div>
              ) : null}

              {current === null ? null : (
                <>
                  {second?.kind === 'missing' || second?.kind === 'same_person' ? (
                    <div
                      role="alert"
                      data-testid="second-person-required"
                      className="flex flex-col gap-2 rounded-lg border-2 border-violet-border bg-violet-surface p-4"
                    >
                      <p className="flex items-center gap-2 text-md font-semibold text-violet-on-surface">
                        <Lock className="size-4 shrink-0" aria-hidden="true" />A second authorising pharmacist
                        is required
                      </p>
                      <p className="text-sm text-violet-on-surface">{second.message}</p>
                      <Button
                        variant="secondary"
                        className="self-start"
                        data-testid="open-cosign"
                        disabled={!canPrepareControlled}
                        onClick={() => {
                          setCoSignOpen(true);
                        }}
                      >
                        Second pharmacist signs in (F9)
                      </Button>
                    </div>
                  ) : null}

                  {second?.kind === 'satisfied' ? (
                    <p
                      data-testid="second-person-satisfied"
                      className="rounded-md border border-success-border bg-success-surface p-2 text-sm text-success-on-surface"
                    >
                      Countersigned by a second authorised pharmacist. Both signatures go on the register
                      entry.
                    </p>
                  ) : null}

                  <HardStopPanel
                    blocking={blocking}
                    advisory={advisory}
                    reasons={acknowledgements}
                    onReasonChange={(key, reason) => {
                      setAcknowledgements((previous) => {
                        const next = new Map(previous);
                        next.set(key, reason);
                        return next;
                      });
                    }}
                  />

                  <ScanRow
                    draft={draft}
                    onChange={setDraft}
                    problems={problems}
                    pending={addItem.isPending}
                    scanRef={scanRef}
                    qtyRef={qtyRef}
                    onPost={postScan}
                  />
                  {addItem.error === null ? null : <ProblemCard error={addItem.error} />}

                  <DispenseLines dispense={current} />

                  <div className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="flex min-w-56 flex-col gap-1">
                        <Label htmlFor="label-locale">Label language, beside English</Label>
                        <select
                          id="label-locale"
                          data-testid="label-locale"
                          className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                          value={secondLocale}
                          onChange={(event) => {
                            setSecondLocale(event.target.value);
                          }}
                        >
                          {LABEL_SECOND_LOCALES.map((locale) => (
                            <option key={locale.code} value={locale.code}>
                              {locale.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <Button
                        variant="secondary"
                        data-testid="print-labels"
                        disabled={!canLabel || label.isPending || current.items.length === 0}
                        onClick={() => {
                          label.mutate();
                        }}
                      >
                        {label.isPending ? 'Preparing…' : 'Labels — English + one more (F8)'}
                      </Button>
                      <label className="flex items-center gap-2 text-sm text-fg-default">
                        <Checkbox
                          checked={counselled}
                          data-testid="counselled"
                          onCheckedChange={(value) => {
                            setCounselled(value === true);
                          }}
                        />
                        Patient counselled in {secondLocale}
                      </label>
                    </div>
                    {label.error === null ? null : <ProblemCard error={label.error} />}
                    {labels.length === 0 ? null : (
                      <LabelPreview labels={labels} secondLocale={secondLocale} />
                    )}
                  </div>

                  <div className="flex flex-col gap-2 rounded-lg border border-strong bg-layer-1 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="text-md text-fg-default">
                        {current.items.length} line{current.items.length === 1 ? '' : 's'} ·{' '}
                        <span className="font-mono">{formatMoney(current.totalAmount)}</span> including{' '}
                        <span className="font-mono">{formatMoney(current.taxAmount)}</span> GST
                      </span>
                      <Button
                        variant="primary"
                        data-testid="complete-dispense"
                        disabled={verdict?.kind !== 'permitted' || !canComplete || complete.isPending}
                        onClick={() => {
                          complete.mutate();
                        }}
                      >
                        {complete.isPending ? 'Completing…' : 'Complete & hand over (F10)'}
                      </Button>
                    </div>

                    {verdict?.kind === 'blocked' ? (
                      <ul data-testid="completion-blockers" className="flex flex-col gap-1">
                        {verdict.reasons.map((reason) => (
                          <li key={reason} className="text-sm text-danger-fg">
                            {reason}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {!canComplete ? (
                      <p className="text-sm text-fg-muted">
                        Completing a dispense needs{' '}
                        <span className="font-mono">pharmacy.dispense.complete</span> and a registered
                        pharmacist profile. You can scan the bag; somebody else has to hand it over.
                      </p>
                    ) : null}
                    {complete.error === null ? null : <ProblemCard error={complete.error} />}
                  </div>
                </>
              )}
            </>
          )}
        </section>
      </div>

      <CoSignDialog
        open={coSignOpen}
        onOpenChange={setCoSignOpen}
        title="Second authorising pharmacist"
        purpose="This dispense contains a controlled drug, so two authorised pharmacists must sign it."
        actingUserName={displayName}
        pending={coSign.isPending}
        error={coSign.error}
        onConfirm={(coSigner) => {
          coSign.mutate(coSigner);
        }}
      />

      <ShortcutBar shortcuts={shortcuts} label="Dispensing counter shortcuts" />

      <p className="sr-only" data-testid="counter-operator">
        {displayName} ({userId})
      </p>

      {declineOpen && current !== null ? (
        <div className="rounded-lg border border-strong bg-layer-1 p-4">
          <Label htmlFor="decline-reason">Why is this line not being given?</Label>
          <Textarea
            id="decline-reason"
            value={declineReason}
            rows={2}
            onChange={(event) => {
              setDeclineReason(event.target.value);
            }}
          />
          <Button
            variant="secondary"
            className="mt-2"
            disabled={declineReason.trim().length < 8 || decline.isPending}
            onClick={() => {
              const first = current.items[0];
              if (first !== undefined) decline.mutate({ itemId: first.itemId, reason: declineReason.trim() });
            }}
          >
            Record as back-ordered
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The scan row.
 *
 * `Enter` in the scan field moves to the quantity; `Enter` in the quantity posts
 * the line. That is the entire keyboard loop for one item, and it is why the
 * partial-fill reason is a third field that only appears when the quantity says
 * it is needed — a field that is always there is a field somebody tabs through.
 */
function ScanRow({
  draft,
  onChange,
  problems,
  pending,
  scanRef,
  qtyRef,
  onPost,
}: {
  readonly draft: ScanLineDraft;
  readonly onChange: (draft: ScanLineDraft) => void;
  readonly problems: readonly string[];
  readonly pending: boolean;
  readonly scanRef: React.RefObject<HTMLInputElement | null>;
  readonly qtyRef: React.RefObject<HTMLInputElement | null>;
  readonly onPost: () => void;
}): React.JSX.Element {
  const partial = isPartialFill(draft);
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-strong bg-layer-1 p-4"
      data-testid="scan-row"
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-64 flex-1 flex-col gap-1">
          <Label htmlFor="scan-input">Scan the pack (GS1 DataMatrix, EAN-13 or item code)</Label>
          <Input
            id="scan-input"
            data-testid="scan-input"
            ref={scanRef}
            autoFocus
            autoComplete="off"
            inputMode="text"
            value={draft.scanned}
            placeholder="Scan or key the barcode"
            onChange={(event) => {
              onChange({ ...draft, scanned: event.target.value });
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              qtyRef.current?.focus();
              qtyRef.current?.select();
            }}
          />
          <p className="text-2xs text-fg-muted">
            The batch and expiry come from the scan and are checked against this counter&rsquo;s shelf before
            the line exists. Key one by hand only when the label will not read.
          </p>
        </div>
        <div className="flex w-28 flex-col gap-1">
          <Label htmlFor="scan-qty">Units</Label>
          <Input
            id="scan-qty"
            data-testid="scan-qty"
            ref={qtyRef}
            inputMode="decimal"
            value={draft.qtyEntered}
            onChange={(event) => {
              onChange({ ...draft, qtyEntered: event.target.value });
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              onPost();
            }}
          />
        </div>
        <div className="flex w-28 flex-col gap-1">
          <Label htmlFor="scan-ordered">Prescribed</Label>
          <Input
            id="scan-ordered"
            data-testid="scan-ordered"
            inputMode="decimal"
            value={draft.qtyOrderedBase}
            onChange={(event) => {
              onChange({ ...draft, qtyOrderedBase: event.target.value });
            }}
          />
        </div>
        <Button variant="primary" data-testid="post-scan" disabled={pending} onClick={onPost}>
          {pending ? 'Checking the shelf…' : 'Add line'}
        </Button>
      </div>

      {partial ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="scan-partial-reason">
            Partial fill — why is less being given than was prescribed? (F7)
          </Label>
          <Input
            id="scan-partial-reason"
            data-testid="scan-partial-reason"
            value={draft.partialReason}
            placeholder="e.g. only 6 in stock; balance ordered and the patient has been told"
            onChange={(event) => {
              onChange({ ...draft, partialReason: event.target.value });
            }}
          />
        </div>
      ) : null}

      {problems.length === 0 ? null : (
        <ul data-testid="scan-problems" className="flex flex-col gap-1">
          {problems.map((problem) => (
            <li key={problem} className="text-2xs text-fg-muted">
              {problem}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The lines, with the facts a pharmacist checks against the box in their hand. */
function DispenseLines({ dispense }: { readonly dispense: DispenseView }): React.JSX.Element {
  if (dispense.items.length === 0) {
    return (
      <EmptyState
        icon={<ScanSearch aria-hidden="true" />}
        cause="Nothing scanned onto this dispense yet."
        nextAction="Scan the first pack. The line appears once its batch has been checked against this counter's shelf — not before."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
      <table className="w-full text-sm" data-testid="dispense-lines">
        <caption className="sr-only">Lines on this dispense, with batch, expiry and price</caption>
        <thead>
          <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
            <th scope="col" className="px-3 py-2 text-start">
              Line
            </th>
            <th scope="col" className="px-3 py-2 text-start">
              Medicine
            </th>
            <th scope="col" className="px-3 py-2 text-start">
              Batch · expiry
            </th>
            <th scope="col" className="px-3 py-2 text-end">
              Qty
            </th>
            <th scope="col" className="px-3 py-2 text-end">
              Line total
            </th>
            <th scope="col" className="px-3 py-2 text-start">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {dispense.items.map((item) => (
            <tr key={item.id} className="border-b border-default last:border-0">
              <td className="px-3 py-2 font-mono text-2xs text-fg-subtle">{item.lineNo}</td>
              <td className="px-3 py-2">
                <span className="text-fg-default">{item.itemName}</span>
                <span className="ms-2 font-mono text-2xs text-fg-subtle">{item.itemCode}</span>
                {item.schedule === 'otc' || item.schedule === 'g' ? null : (
                  <Badge tone="violet" className="ms-2">
                    Schedule {item.schedule.toUpperCase()}
                  </Badge>
                )}
                {item.fefoOverride ? (
                  <Badge tone="warning" className="ms-2">
                    FEFO override
                  </Badge>
                ) : null}
              </td>
              <td className="px-3 py-2 font-mono text-2xs text-fg-muted">
                {item.batchNo ?? '—'} · {formatDate(item.expiryDate)}
              </td>
              <td className="px-3 py-2 text-end font-mono">{formatQty(item.qtyEntered)}</td>
              <td className="px-3 py-2 text-end font-mono">{formatMoney(item.lineTotal)}</td>
              <td className="px-3 py-2">
                <Badge tone={item.status === 'partial' ? 'warning' : 'neutral'}>
                  {humanise(item.status)}
                </Badge>
                {item.partialReason === null ? null : (
                  <p className="mt-1 text-2xs text-fg-muted">{item.partialReason}</p>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
