'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarcodeScanInput,
  Badge,
  Button,
  Checkbox,
  ConfirmWithReasonDialog,
  EmptyState,
  Input,
  Label,
  Textarea,
  WorklistTable,
  useToast,
} from '@vims/ui';
import { useMemo, useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { ShortcutBar } from '@/features/frontoffice/components/keyboard-sheet';
import { useShortcuts, type Shortcut } from '@/features/frontoffice/lib/shortcuts';
import { ScanSearch } from '@/lib/icons';
import { useSession } from '@/lib/session-context';
import {
  accessionSample,
  collectSample,
  getSampleByBarcode,
  issueLabels,
  listLabOrders,
  listRejectionReasons,
  receiveSample,
  rejectSample,
} from '../api/client';
import { diagnosticsKeys } from '../api/keys';
import { LAB_COLLECTION_SITES, LAB_SAMPLE_CONDITIONS, type LabSampleCondition } from '../api/types';
import { formatInstant, humanise } from '../lib/format';
import {
  EMPTY_COLLECTION_FORM,
  canCollect,
  identityVerdict,
  isRejected,
  mayReprintLabel,
  stageIndex,
  toCollectRequest,
  type CollectionFormState,
} from '../lib/collection';
import { patientRef, worklistLabels } from '../lib/worklist-labels';

/**
 * OP-004 §3.2 — the pre-analytical bench: collect, receive, accession, reject.
 *
 * ## Why this screen is driven by a scanner and not by a list
 *
 * OP-004 §8 puts the scan field first and keeps it focused, and EN-013 §3.3.1
 * makes the scan arrive through a **global keyboard-wedge listener** rather than
 * into whichever field happens to have focus. The reason is physical: the person
 * using this screen has a tube in one hand and a scanner in the other, and the
 * moment they have to click into a field first is the moment somebody starts
 * typing barcodes from memory.
 *
 * The API agrees and keys every specimen action on the barcode rather than on a
 * UUID, precisely so that no lookup screen sits between the scan and the action
 * — a lookup screen is where somebody picks the wrong patient.
 *
 * ## The two-identifier check, and the one lawful way past it
 *
 * OP-004 §5 bullet 1: a collection is confirmed by scanning the patient **and**
 * the container, or by recording why that was impossible. `lib/collection.ts`
 * holds that rule; this screen renders its verdict as a disabled button with a
 * sentence rather than as a 400. The override is deliberately reachable — a
 * wristband that will not scan and a neonate with no band are real, and a
 * product that made the documented path unreachable would only move the
 * workaround out of the audit trail.
 *
 * ## What this screen refuses to do
 *
 * - **It will not reprint a collected tube's label.** EN-013 §5 bullet 6 sends
 *   that through a relabel workflow this build does not have, so the action is
 *   offered only before collection and explains itself after.
 * - **It will not offer bench actions on a rejected specimen.** OP-004 §3.2.3:
 *   a specimen the laboratory has declared unfit does not then produce a number.
 * - **It will not let a rejection be recorded without a coded reason.** The
 *   reason is a NABL indicator, and free text cannot be counted.
 */
export function LabCollectionScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = diagnosticsKeys(hospitalId);
  const queryClient = useQueryClient();
  const { publish } = useToast();

  const [barcode, setBarcode] = useState('');
  const [form, setForm] = useState<CollectionFormState>(EMPTY_COLLECTION_FORM);
  const [condition, setCondition] = useState<LabSampleCondition>('satisfactory');
  const [storageLocation, setStorageLocation] = useState('');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const canRead = granted.has('lab.order.read');
  const canList = granted.has('lab.order.list');
  const canLabel = granted.has('lab.sample.label');
  const canReceive = granted.has('lab.sample.receive');
  const canReject = granted.has('lab.sample.reject');
  const canReadReasons = granted.has('mdm.read');

  const pending = useQuery({
    queryKey: keys.labOrders('awaiting_collection', 'all'),
    queryFn: ({ signal }) => listLabOrders({ status: 'awaiting_collection', cursor }, { signal }),
    enabled: canList,
  });

  const sample = useQuery({
    queryKey: keys.labSample(barcode),
    queryFn: ({ signal }) => getSampleByBarcode(barcode, { signal }),
    enabled: barcode !== '' && canRead,
  });

  const reasons = useQuery({
    queryKey: keys.rejectionReasons(),
    queryFn: ({ signal }) => listRejectionReasons({ signal }),
    enabled: canReadReasons,
    staleTime: 10 * 60_000,
  });

  const specimen = sample.data ?? null;
  const verdict = identityVerdict(form);
  const rejected = specimen !== null && isRejected(specimen.status);

  function refreshSpecimen(): void {
    void queryClient.invalidateQueries({ queryKey: keys.labSamples() });
    void queryClient.invalidateQueries({ queryKey: keys.labRoot });
  }

  const collect = useMutation({
    mutationFn: () => collectSample(barcode, toCollectRequest(form)),
    onSuccess: (updated) => {
      refreshSpecimen();
      setForm(EMPTY_COLLECTION_FORM);
      publish({
        title: 'Collection confirmed',
        description:
          updated.identity_override_reason === null
            ? 'Both identifiers were scanned. The patient has been told when to expect the report.'
            : 'Recorded against a documented identity override — it appears on the NABL exception report.',
        severity: 'success',
      });
    },
  });

  const receive = useMutation({
    mutationFn: () => receiveSample(barcode, { conditionOnReceipt: condition }),
    onSuccess: () => {
      refreshSpecimen();
      publish({ title: 'Specimen received', severity: 'success' });
    },
  });

  const accession = useMutation({
    mutationFn: () =>
      accessionSample(
        barcode,
        storageLocation.trim() === '' ? {} : { storageLocation: storageLocation.trim() },
      ),
    onSuccess: () => {
      refreshSpecimen();
      publish({
        title: 'Accessioned',
        description: 'The routine turnaround clock starts now.',
        severity: 'success',
      });
    },
  });

  const reject = useMutation({
    mutationFn: (input: { readonly reasonKey: string; readonly reasonText: string }) =>
      rejectSample(
        barcode,
        { rejectionReasonKey: input.reasonKey, recollect: true, note: input.reasonText },
        input.reasonText,
      ),
    onSuccess: () => {
      refreshSpecimen();
      publish({
        title: 'Specimen rejected',
        description:
          'A recollection has been raised against the same order at no charge, and the ward and the patient have been told.',
        severity: 'warning',
      });
    },
  });

  const labels = useMutation({
    mutationFn: (orderId: string) => issueLabels(orderId, { copies: 1 }),
    onSuccess: (issued) => {
      publish({
        title: `${issued.labels.length} label${issued.labels.length === 1 ? '' : 's'} sent to the printer`,
        severity: 'success',
      });
    },
  });

  const shortcuts: readonly Shortcut[] = useMemo(
    () => [
      {
        key: 'F4',
        label: 'Confirm the collection',
        keys: ['F4'],
        enabled: specimen !== null && canCollect(form) && !collect.isPending,
        run: () => {
          collect.mutate();
        },
      },
      {
        key: 'F6',
        label: 'Reject this specimen',
        keys: ['F6'],
        enabled: specimen !== null && canReject && !rejected,
        run: () => {
          setRejectOpen(true);
        },
      },
    ],
    [specimen, form, collect, canReject, rejected],
  );
  useShortcuts(shortcuts);

  const reasonOptions = (reasons.data?.items ?? []).map((reason) => ({
    code: reason.record_key,
    label: `${reason.label} (${reason.code})`,
  }));

  return (
    <section className="flex flex-col gap-4" data-testid="lab-collection-screen">
      <PageHeader
        eyebrow="OP-004 · pre-analytical"
        title="Sample collection"
        description="Scan the patient, scan the tube. Everything on this screen keys on the barcode, because the alternative is a lookup screen between the scan and the act."
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <section className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
          <BarcodeScanInput
            labels={{
              fieldLabel: 'Scan or type a specimen barcode',
              placeholder: 'Scan the tube label',
              resolving: 'Looking the specimen up…',
              unresolved: (raw) =>
                `No specimen in this hospital carries the barcode "${raw}". Check the label, or use the order list beside this field.`,
              manualEntryHint:
                'A scanner types for you. Only key a barcode by hand when the label will not read, and check a second identifier before you do.',
            }}
            resolve={async (payload) => {
              const trimmed = payload.trim();
              if (trimmed === '') return null;
              try {
                const found = await getSampleByBarcode(trimmed);
                return {
                  entityId: found.barcode,
                  entityKind: 'lab_sample',
                  display: `${found.sample_no} · ${found.specimen_type_name} · ${humanise(found.status)}`,
                };
              } catch {
                return null;
              }
            }}
            onResolved={(resolution) => {
              setBarcode(resolution.entityId);
              setForm(EMPTY_COLLECTION_FORM);
            }}
          />

          {barcode === '' ? (
            <EmptyState
              icon={<ScanSearch aria-hidden="true" />}
              cause="No specimen selected."
              nextAction="Scan a tube, or pick an order from the collection list and print its labels first."
            />
          ) : (
            <AsyncPanel
              loading={sample.isPending}
              error={sample.error}
              isEmpty={specimen === null}
              skeletonLabel="Loading the specimen"
              skeletonRows={4}
              onRetry={() => {
                void sample.refetch();
              }}
              empty={
                <EmptyState
                  cause={`Barcode ${barcode} does not resolve to a specimen in this hospital.`}
                  nextAction="Check the label. A barcode from another branch resolves to nothing here, which is the tenancy boundary doing its job."
                />
              }
            >
              {specimen === null ? null : (
                <div className="flex flex-col gap-3" data-testid="specimen-panel">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-md font-medium text-fg-default">
                      {specimen.sample_no}
                    </span>
                    <Badge tone={rejected ? 'danger' : 'neutral'} data-testid="specimen-status">
                      {humanise(specimen.status)}
                    </Badge>
                    {specimen.cap_colour === null ? null : (
                      <Badge tone="neutral">{specimen.cap_colour} cap</Badge>
                    )}
                    <span className="text-sm text-fg-muted">
                      {specimen.specimen_type_name}
                      {specimen.container_name === null ? '' : ` · ${specimen.container_name}`}
                    </span>
                  </div>

                  <dl className="grid grid-cols-2 gap-2 text-2xs text-fg-muted">
                    <div>
                      <dt className="text-fg-subtle">Collected</dt>
                      <dd className="font-mono">{formatInstant(specimen.collected_at)}</dd>
                    </div>
                    <div>
                      <dt className="text-fg-subtle">Received</dt>
                      <dd className="font-mono">{formatInstant(specimen.received_at)}</dd>
                    </div>
                    <div>
                      <dt className="text-fg-subtle">Accessioned</dt>
                      <dd className="font-mono">{formatInstant(specimen.accessioned_at)}</dd>
                    </div>
                    <div>
                      <dt className="text-fg-subtle">Condition on receipt</dt>
                      <dd className="font-mono">{humanise(specimen.condition_on_receipt)}</dd>
                    </div>
                  </dl>

                  {specimen.identity_override_reason === null ? null : (
                    <p
                      data-testid="identity-override-note"
                      className="rounded-md border border-warning-border bg-warning-surface p-2 text-sm text-warning-on-surface"
                    >
                      Collected under a documented identity override: {specimen.identity_override_reason}
                    </p>
                  )}

                  {rejected ? (
                    <div
                      role="alert"
                      data-testid="rejected-banner"
                      className="rounded-md border border-danger-border bg-danger-surface p-3 text-sm text-danger-on-surface"
                    >
                      <p className="font-medium">
                        This specimen was rejected
                        {specimen.rejection_reason_code === null
                          ? ''
                          : ` — ${specimen.rejection_reason_code}`}
                        .
                      </p>
                      <p className="mt-1">
                        A rejected specimen is never resulted. A recollection has been raised against the same
                        order; scan the replacement tube when it arrives.
                      </p>
                    </div>
                  ) : (
                    <CollectionPanel
                      form={form}
                      onChange={setForm}
                      verdictMessage={verdict.kind === 'blocked' ? verdict.message : null}
                      overrideActive={verdict.kind === 'documented_override'}
                      stage={stageIndex(specimen.status)}
                      pending={collect.isPending}
                      onCollect={() => {
                        collect.mutate();
                      }}
                    />
                  )}

                  {collect.error === null ? null : <ProblemCard error={collect.error} />}

                  {!rejected && canReceive ? (
                    <div className="flex flex-col gap-3 border-t border-default pt-3">
                      <div className="flex flex-wrap items-end gap-3">
                        <div className="flex min-w-56 flex-col gap-1">
                          <Label htmlFor="condition-on-receipt">Condition on receipt</Label>
                          <select
                            id="condition-on-receipt"
                            data-testid="condition-on-receipt"
                            className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                            value={condition}
                            onChange={(event) => {
                              setCondition(event.target.value as LabSampleCondition);
                            }}
                          >
                            {LAB_SAMPLE_CONDITIONS.map((value) => (
                              <option key={value} value={value}>
                                {humanise(value)}
                              </option>
                            ))}
                          </select>
                        </div>
                        <Button
                          variant="secondary"
                          data-testid="receive-button"
                          disabled={receive.isPending}
                          onClick={() => {
                            receive.mutate();
                          }}
                        >
                          Receive at the laboratory
                        </Button>
                      </div>

                      <div className="flex flex-wrap items-end gap-3">
                        <div className="flex min-w-56 flex-col gap-1">
                          <Label htmlFor="storage-location">Storage location (optional)</Label>
                          <Input
                            id="storage-location"
                            data-testid="storage-location"
                            value={storageLocation}
                            onChange={(event) => {
                              setStorageLocation(event.target.value);
                            }}
                          />
                        </div>
                        <Button
                          variant="secondary"
                          data-testid="accession-button"
                          disabled={accession.isPending}
                          onClick={() => {
                            accession.mutate();
                          }}
                        >
                          Accession
                        </Button>
                      </div>
                      {receive.error === null ? null : <ProblemCard error={receive.error} />}
                      {accession.error === null ? null : <ProblemCard error={accession.error} />}
                    </div>
                  ) : null}

                  {rejected || !canReject ? null : (
                    <div className="flex flex-col gap-1 border-t border-default pt-3">
                      <Button
                        variant="danger"
                        data-testid="open-reject"
                        disabled={!canReadReasons || reasonOptions.length === 0}
                        onClick={() => {
                          setRejectOpen(true);
                        }}
                      >
                        Reject this specimen
                      </Button>
                      {canReadReasons && reasonOptions.length > 0 ? null : (
                        <p className="text-2xs text-fg-subtle">
                          The coded NABL rejection reasons could not be read, so a rejection cannot be
                          recorded from here. A rejection reason is an indicator and cannot be free text.
                        </p>
                      )}
                      {reject.error === null ? null : <ProblemCard error={reject.error} />}
                    </div>
                  )}
                </div>
              )}
            </AsyncPanel>
          )}
        </section>

        <section className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
          <h2 className="text-md font-medium text-fg-default">Awaiting collection</h2>
          {!canList ? (
            <EmptyState
              cause="Your roles do not include listing laboratory orders."
              nextAction="Scan a tube instead — the collection actions on the left need only the collection permission."
            />
          ) : (
            <AsyncPanel
              loading={pending.isPending}
              error={pending.error}
              isEmpty={(pending.data?.items.length ?? 0) === 0}
              skeletonLabel="Loading the collection list"
              onRetry={() => {
                void pending.refetch();
              }}
              empty={
                <EmptyState
                  cause="No orders are awaiting collection at this branch."
                  nextAction="Scan a tube that has already been drawn, or wait for the next order to reach the round."
                />
              }
            >
              <WorklistTable
                rows={pending.data?.items ?? []}
                getRowId={(row) => row.id}
                labels={worklistLabels('Orders awaiting collection')}
                empty={{
                  cause: 'No orders are awaiting collection at this branch.',
                  nextAction: 'Scan a tube that has already been drawn.',
                }}
                criticalRowIds={
                  new Set(
                    (pending.data?.items ?? [])
                      .filter((order) => order.priority === 'stat')
                      .map((order) => order.id),
                  )
                }
                hasMore={pending.data?.hasMore ?? false}
                loading={pending.isFetching}
                onLoadMore={() => {
                  setCursor(pending.data?.nextCursor ?? undefined);
                }}
                columns={[
                  {
                    key: 'accession',
                    header: 'Accession',
                    render: (row) => <span className="font-mono text-xs">{row.accession_no}</span>,
                  },
                  {
                    key: 'patient',
                    header: 'Patient ref',
                    render: (row) => <span className="font-mono text-xs">{patientRef(row.patient_id)}</span>,
                  },
                  {
                    key: 'priority',
                    header: 'Priority',
                    render: (row) => (
                      <Badge tone={row.priority === 'stat' ? 'danger' : 'neutral'}>
                        {humanise(row.priority)}
                      </Badge>
                    ),
                  },
                  {
                    key: 'tests',
                    header: 'Tests',
                    importance: 'secondary',
                    render: (row) => (
                      <span className="text-xs text-fg-muted">
                        {row.tests.map((test) => test.test_code).join(', ')}
                      </span>
                    ),
                  },
                  {
                    key: 'labels',
                    header: 'Labels',
                    render: (row) => {
                      const printable = row.samples.every((one) => mayReprintLabel(one.status));
                      if (!canLabel) return <span className="text-2xs text-fg-subtle">no permission</span>;
                      if (!printable) {
                        return (
                          <span className="text-2xs text-fg-subtle" title="EN-013 §5: relabel workflow only">
                            already collected
                          </span>
                        );
                      }
                      return (
                        <Button
                          size="sm"
                          variant="ghost"
                          data-testid={`print-${row.id}`}
                          onClick={() => {
                            labels.mutate(row.id);
                          }}
                        >
                          Print
                        </Button>
                      );
                    },
                  },
                ]}
              />
            </AsyncPanel>
          )}
        </section>
      </div>

      <ConfirmWithReasonDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        reasonOptions={reasonOptions}
        labels={{
          title: 'Reject this specimen',
          description:
            'A rejection raises a recollection against the same order at no charge, and tells the ward and the patient. The coded reason is a NABL indicator, so it is counted rather than read.',
          reasonLabel: 'Coded rejection reason',
          reasonPlaceholder: 'Choose the reason',
          notePlaceholder: 'Anything the person recollecting needs to know',
          confirm: 'Reject and raise a recollection',
          cancel: 'Keep the specimen',
          typedValuePrompt: (expected) => `Type ${expected} to confirm`,
          reasonRequired: 'Choose a coded reason.',
          typedValueMismatch: 'That does not match.',
        }}
        onConfirm={(result) => {
          const reasonKey = result.reasonCode ?? '';
          if (reasonKey === '') return;
          const label = reasonOptions.find((option) => option.code === reasonKey)?.label ?? 'Rejected';
          reject.mutate({
            reasonKey,
            reasonText: result.reasonText.trim() === '' ? label : result.reasonText.trim(),
          });
          setRejectOpen(false);
        }}
      />

      <ShortcutBar shortcuts={shortcuts} label="Collection shortcuts" />
    </section>
  );
}

/**
 * The identity check itself.
 *
 * Two checkboxes rather than two scan fields is a deliberate simplification with
 * a cost, and the cost is worth stating: EN-013 §3.4.2 wants the wristband and
 * the label each scanned into the verification step, with a mismatch blocking.
 * `POST /lab/samples/{barcode}/collect` accepts only two booleans and an override
 * reason — there is nowhere on the wire to send the wristband payload, so the
 * comparison the API could make, it cannot. That is an API gap, reported as one;
 * what this screen can honestly claim is that the two confirmations were made,
 * and it claims exactly that.
 */
function CollectionPanel({
  form,
  onChange,
  verdictMessage,
  overrideActive,
  stage,
  pending,
  onCollect,
}: {
  readonly form: CollectionFormState;
  readonly onChange: (next: CollectionFormState) => void;
  readonly verdictMessage: string | null;
  readonly overrideActive: boolean;
  readonly stage: number;
  readonly pending: boolean;
  readonly onCollect: () => void;
}): React.JSX.Element {
  const alreadyCollected = stage >= 2;

  if (alreadyCollected) {
    return (
      <p className="rounded-md border border-default bg-layer-2 p-3 text-sm text-fg-muted">
        This specimen has already been collected. The next step is receipt at the laboratory.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 border-t border-default pt-3" data-testid="collection-panel">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-fg-default">Two-identifier check</legend>
        <div className="flex items-start gap-2">
          <Checkbox
            id="patient-scan"
            data-testid="patient-scan"
            checked={form.patientScanVerified}
            onCheckedChange={(checked) => {
              onChange({ ...form, patientScanVerified: checked === true });
            }}
          />
          <Label htmlFor="patient-scan" className="font-normal">
            I scanned the patient’s wristband
          </Label>
        </div>
        <div className="flex items-start gap-2">
          <Checkbox
            id="container-scan"
            data-testid="container-scan"
            checked={form.containerScanVerified}
            onCheckedChange={(checked) => {
              onChange({ ...form, containerScanVerified: checked === true });
            }}
          />
          <Label htmlFor="container-scan" className="font-normal">
            I scanned the container label
          </Label>
        </div>
      </fieldset>

      <div className="flex flex-col gap-1">
        <Label htmlFor="identity-override">If you could not scan both, say why</Label>
        <Textarea
          id="identity-override"
          data-testid="identity-override"
          rows={2}
          value={form.identityOverrideReason}
          onChange={(event) => {
            onChange({ ...form, identityOverrideReason: event.target.value });
          }}
        />
        <p className="text-2xs text-fg-subtle">
          A wristband that will not read, a printer that is down, a neonate with no band. It is audited and it
          appears on the NABL exception report — which is what makes it a decision rather than a gap.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="collection-site">Where was it drawn?</Label>
          <select
            id="collection-site"
            data-testid="collection-site"
            className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            value={form.collectionSite}
            onChange={(event) => {
              onChange({
                ...form,
                collectionSite: event.target.value as CollectionFormState['collectionSite'],
              });
            }}
          >
            {LAB_COLLECTION_SITES.map((site) => (
              <option key={site} value={site}>
                {humanise(site)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="fasting-hours">Fasting hours (optional)</Label>
          <Input
            id="fasting-hours"
            data-testid="fasting-hours"
            inputMode="decimal"
            value={form.fastingHours}
            onChange={(event) => {
              onChange({ ...form, fastingHours: event.target.value, fasting: event.target.value !== '' });
            }}
          />
        </div>
      </div>

      {overrideActive ? (
        <p
          data-testid="override-notice"
          className="rounded-md border border-warning-border bg-warning-surface p-2 text-sm text-warning-on-surface"
        >
          This collection will be recorded against a documented override rather than two scans.
        </p>
      ) : null}

      {verdictMessage === null ? null : (
        <p data-testid="identity-block" role="status" className="text-sm text-warning-fg">
          {verdictMessage}
        </p>
      )}

      <Button
        data-testid="collect-button"
        disabled={verdictMessage !== null || pending}
        onClick={onCollect}
        className="self-start"
      >
        {pending ? 'Confirming…' : 'Confirm collection'}
      </Button>
    </div>
  );
}
