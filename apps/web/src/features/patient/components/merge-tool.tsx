'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  ConfirmWithReasonDialog,
  Label,
  RadioGroup,
  RadioGroupItem,
  Textarea,
  WorklistTable,
  useToast,
  type WorklistColumn,
  type WorklistTableLabels,
} from '@vims/ui';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Copy, Info, TriangleAlert, Users } from '@/lib/icons';
import { useSession } from '@/lib/session-context';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { commitMerge, getPatient, listDedupeCandidates, prepareMerge, unmerge } from '../api/client';
import { newIdempotencyKey } from '../api/http';
import { patientKeys } from '../api/keys';
import type { DedupeCandidateItem, MergePreview, MergeResult, PatientDetail } from '../api/types';
import { isUsableReason, MIN_REASON_LENGTH } from '../lib/duplicates';
import { formatTimestamp } from '../lib/format';
import {
  assessMerge,
  compareForMerge,
  decidableRows,
  defaultFieldChoices,
  describeImpact,
  type SurvivorChoice,
} from '../lib/merge';
import { PatientLookup } from './patient-lookup';

/**
 * The merge tool (OP-001 §3.8, §8 "Dedupe/Merge", §5 "2-step confirm").
 *
 * Merging is the most consequential thing anyone does to a patient record short
 * of a clinical order: it joins two clinical histories, retires a UHID and makes
 * every downstream module re-point its rows. `docs/06` §6.9 puts it at friction
 * level 5 — confirm, reason, and a typed value — and the API adds two more
 * defences that this screen exists to expose rather than to hide:
 *
 *  1. **Two steps, and the second names the first.** `step: 'prepare'` writes a
 *     pending merge and returns the impact without touching a row; `step:
 *     'commit'` executes *that* merge by id. The officer therefore confirms the
 *     exact comparison they were shown, and a record that changed in between
 *     cannot be merged unseen. The preview panel below is that first step's
 *     answer, and it is not skippable.
 *  2. **The impact is stated before the decision, in words.** "3 × Visits, 1 ×
 *     Identifiers" is what will move inside this module; the sentence under it
 *     says what happens outside it, because `patient.merged` fans out to billing,
 *     lab, pharmacy and the rest, and the officer is deciding for all of them.
 *
 * Unmerge stays on screen afterwards for the same reason: OP-001 §3.8 gives a
 * thirty-day window, and a window nobody can find is not a window.
 */

type Step =
  | { readonly kind: 'choosing' }
  | { readonly kind: 'prepared'; readonly preview: MergePreview }
  | { readonly kind: 'merged'; readonly result: MergeResult };

export function MergeTool(): React.JSX.Element {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { publish } = useToast();
  const { hospitalId, granted } = useSession();
  const keys = patientKeys(hospitalId);

  const canExecute = granted.has('patient.merge.execute');

  const [survivorId, setSurvivorId] = useState<string | null>(null);
  const [victimId, setVictimId] = useState<string | null>(null);
  const [choices, setChoices] = useState<Readonly<Record<string, SurvivorChoice>>>({});
  const [touchedChoices, setTouchedChoices] = useState(false);
  const [reason, setReason] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'choosing' });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [unmergeOpen, setUnmergeOpen] = useState(false);

  const queue = useQuery({
    queryKey: keys.dedupe('open', 0),
    queryFn: ({ signal }) => listDedupeCandidates({ status: 'open', minScore: 0 }, undefined, { signal }),
  });

  // Two `useQuery` calls rather than one `useQueries`: with neither record chosen
  // the two would share the same placeholder key, and TanStack refuses to observe
  // one key twice. They also cache under `keys.detail(id)`, which is the same
  // entry Patient 360 reads — opening a record after a merge is a cache hit.
  const survivor = useQuery({
    queryKey: keys.detail(survivorId ?? 'unchosen-survivor'),
    queryFn: ({ signal }) => getPatient(survivorId ?? '', { signal }),
    enabled: survivorId !== null,
  });
  const victim = useQuery({
    queryKey: keys.detail(victimId ?? 'unchosen-victim'),
    queryFn: ({ signal }) => getPatient(victimId ?? '', { signal }),
    enabled: victimId !== null,
  });

  const survivorRecord = survivor.data;
  const victimRecord = victim.data;

  const rows = useMemo(
    () =>
      survivorRecord === undefined || victimRecord === undefined
        ? []
        : compareForMerge(survivorRecord, victimRecord),
    [survivorRecord, victimRecord],
  );
  const decidable = useMemo(() => decidableRows(rows), [rows]);
  const eligibility = assessMerge(survivorRecord, victimRecord);

  // The default picks are recomputed from the comparison until the officer makes
  // their first choice; after that their decisions win, because a background
  // refetch must never silently reselect a field they had changed.
  const effectiveChoices = touchedChoices ? choices : defaultFieldChoices(rows);

  const prepare = useMutation({
    mutationFn: () =>
      prepareMerge(
        {
          survivorId: survivorId ?? '',
          victimId: victimId ?? '',
          reason: reason.trim(),
          fieldChoices: effectiveChoices,
        },
        newIdempotencyKey(),
      ),
    onSuccess: (preview) => {
      setStep({ kind: 'prepared', preview });
    },
  });

  const commit = useMutation({
    mutationFn: (input: { readonly mergeId: string }) =>
      commitMerge(input.mergeId, reason.trim(), newIdempotencyKey()),
    onSuccess: (result) => {
      setStep({ kind: 'merged', result });
      void queryClient.invalidateQueries({ queryKey: [...keys.root, 'dedupe'] });
      void queryClient.invalidateQueries({ queryKey: keys.detail(result.survivorId) });
      void queryClient.invalidateQueries({ queryKey: keys.detail(result.victimId) });
      publish({
        title: 'Records merged',
        description: `${result.victimUhid} now resolves to ${result.survivorUhid}.`,
        severity: 'success',
      });
    },
  });

  const reverse = useMutation({
    mutationFn: (input: { readonly mergeId: string; readonly reason: string }) =>
      unmerge(input.mergeId, input.reason, newIdempotencyKey()),
    onSuccess: (result) => {
      setStep({ kind: 'choosing' });
      void queryClient.invalidateQueries({ queryKey: [...keys.root] });
      publish({
        title: 'Merge reversed',
        description: `${result.victimUhid} is a separate record again.`,
        severity: 'success',
      });
    },
  });

  const reset = (): void => {
    setStep({ kind: 'choosing' });
    setSurvivorId(null);
    setVictimId(null);
    setChoices({});
    setTouchedChoices(false);
    setReason('');
  };

  const bothChosen = survivorId !== null && victimId !== null;
  const canPrepare =
    canExecute && bothChosen && eligibility.allowed && isUsableReason(reason) && !prepare.isPending;

  return (
    <div className="flex flex-col gap-4" data-testid="merge-tool">
      <PageHeader
        eyebrow="OP-001 §3.8"
        title="Duplicate &amp; merge"
        description="Two records for one person split their clinical history in half. Merging joins them permanently — the losing UHID stays searchable as an alias and never gets reissued."
        actions={
          step.kind === 'choosing' ? undefined : (
            <Button variant="secondary" onClick={reset}>
              Start another
            </Button>
          )
        }
      />

      {prepare.isError ? <ProblemCard error={prepare.error} /> : null}
      {commit.isError ? <ProblemCard error={commit.error} /> : null}
      {reverse.isError ? <ProblemCard error={reverse.error} /> : null}

      {step.kind === 'merged' ? (
        <MergedPanel
          result={step.result}
          canReverse={canExecute}
          reversing={reverse.isPending}
          onOpenSurvivor={() => {
            router.push(`/patients/${step.result.survivorId}`);
          }}
          onReverse={() => {
            setUnmergeOpen(true);
          }}
        />
      ) : (
        <>
          <DedupeQueue
            queue={queue.data?.items ?? []}
            loading={queue.isPending}
            error={queue.error}
            onRetry={() => void queue.refetch()}
            onPick={(row) => {
              // The queue does not know which of a pair should survive; the officer
              // decides. `patient_a` is offered as the survivor only because
              // something has to be, and the swap button is one keystroke away.
              setSurvivorId(row.patient_a_id);
              setVictimId(row.patient_b_id);
              setTouchedChoices(false);
              setChoices({});
            }}
          />

          <section
            aria-labelledby="merge-pick-heading"
            className="rounded-lg border border-default bg-layer-1 p-3"
          >
            <h2 id="merge-pick-heading" className="text-md font-semibold text-fg-default">
              Choose the two records
            </h2>
            <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
              <div>
                <p className="mb-1 text-sm font-medium text-fg-default">
                  The record that survives
                  <Badge tone="success" size="sm" className="ms-2">
                    Keeps its UHID
                  </Badge>
                </p>
                {survivorRecord === undefined ? (
                  <PatientLookup
                    showRecent={false}
                    onSelect={(result) => {
                      setSurvivorId(result.patientId);
                    }}
                    labels={{ fieldLabel: 'Find the surviving record' }}
                  />
                ) : (
                  <ChosenRecord
                    patient={survivorRecord}
                    onClear={() => {
                      setSurvivorId(null);
                    }}
                  />
                )}
              </div>

              <div className="flex items-center justify-center">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!bothChosen}
                  data-testid="merge-swap"
                  onClick={() => {
                    setSurvivorId(victimId);
                    setVictimId(survivorId);
                    setTouchedChoices(false);
                    setChoices({});
                  }}
                >
                  <Copy aria-hidden="true" />
                  Swap
                </Button>
              </div>

              <div>
                <p className="mb-1 text-sm font-medium text-fg-default">
                  The record that is retired
                  <Badge tone="warning" size="sm" className="ms-2">
                    UHID becomes an alias
                  </Badge>
                </p>
                {victimRecord === undefined ? (
                  <PatientLookup
                    showRecent={false}
                    onSelect={(result) => {
                      setVictimId(result.patientId);
                    }}
                    labels={{ fieldLabel: 'Find the record to retire' }}
                  />
                ) : (
                  <ChosenRecord
                    patient={victimRecord}
                    onClear={() => {
                      setVictimId(null);
                    }}
                  />
                )}
              </div>
            </div>

            {eligibility.refusals.length === 0 || !bothChosen ? null : (
              <ul
                role="alert"
                data-testid="merge-refusals"
                className="mt-3 flex list-inside list-disc flex-col gap-1 rounded-md border border-danger-border bg-danger-surface p-3 text-sm text-danger-on-surface"
              >
                {eligibility.refusals.map((refusal) => (
                  <li key={refusal}>{refusal}</li>
                ))}
              </ul>
            )}
          </section>

          {survivorRecord === undefined || victimRecord === undefined ? null : (
            <section
              aria-labelledby="merge-compare-heading"
              className="rounded-lg border border-default bg-layer-1 p-3"
            >
              <h2 id="merge-compare-heading" className="text-md font-semibold text-fg-default">
                What differs, and which value is kept
              </h2>
              {decidable.length === 0 ? (
                <p className="mt-2 text-sm text-fg-muted">
                  The two records hold the same demographics. Nothing has to be chosen — the merge is about
                  joining their histories.
                </p>
              ) : (
                <ul className="mt-3 flex flex-col gap-3" data-testid="merge-comparison">
                  {decidable.map((row) => (
                    <li key={row.field} className="rounded-md border border-default p-3">
                      <RadioGroup
                        value={effectiveChoices[row.field] ?? 'survivor'}
                        aria-label={`Which ${row.label} to keep`}
                        onValueChange={(value) => {
                          setTouchedChoices(true);
                          setChoices({ ...effectiveChoices, [row.field]: value as SurvivorChoice });
                        }}
                      >
                        <p className="text-sm font-medium text-fg-default">{row.label}</p>
                        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <ChoiceOption
                            id={`${row.field}-survivor`}
                            value="survivor"
                            uhid={survivorRecord.uhid}
                            text={row.survivorValue}
                          />
                          <ChoiceOption
                            id={`${row.field}-victim`}
                            value="victim"
                            uhid={victimRecord.uhid}
                            text={row.victimValue}
                          />
                        </div>
                      </RadioGroup>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {step.kind === 'prepared' ? (
            <PreparedPanel
              preview={step.preview}
              committing={commit.isPending}
              onConfirm={() => {
                setConfirmOpen(true);
              }}
              onDiscard={() => {
                setStep({ kind: 'choosing' });
              }}
            />
          ) : (
            <section
              aria-labelledby="merge-reason-heading"
              className="rounded-lg border border-default bg-layer-1 p-3"
            >
              <h2 id="merge-reason-heading" className="text-md font-semibold text-fg-default">
                Why these are the same person
              </h2>
              <div className="mt-2">
                <Label htmlFor="merge-reason" required>
                  Reason
                </Label>
                <Textarea
                  id="merge-reason"
                  rows={2}
                  value={reason}
                  data-testid="merge-reason"
                  aria-required="true"
                  aria-describedby="merge-reason-hint"
                  placeholder="e.g. Same person; second record created at the ER counter on 14-08-2026 with a misspelled surname. Confirmed against the passport and the attendant."
                  onChange={(event) => {
                    setReason(event.target.value);
                  }}
                />
                <p id="merge-reason-hint" className="mt-1 text-xs text-fg-muted">
                  At least {MIN_REASON_LENGTH} characters. It is stored on the merge, sent as the authority
                  for the request, and is what an unmerge request thirty days from now will be judged against.
                </p>
              </div>

              {!canExecute ? (
                <p className="mt-3 text-sm text-fg-muted" data-testid="merge-not-permitted">
                  Executing a merge needs the <span className="font-mono text-xs">patient.merge.execute</span>{' '}
                  permission, which is held by medical records. You can review the queue and prepare the
                  comparison for them.
                </p>
              ) : null}

              <div className="mt-3 flex justify-end">
                <Button
                  variant="primary"
                  disabled={!canPrepare}
                  aria-busy={prepare.isPending}
                  data-testid="merge-prepare"
                  onClick={() => {
                    prepare.mutate();
                  }}
                >
                  {prepare.isPending ? 'Preparing…' : 'Preview the merge'}
                </Button>
              </div>
            </section>
          )}
        </>
      )}

      {step.kind === 'prepared' ? (
        <ConfirmWithReasonDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          confirmationValue={step.preview.victimUhid}
          labels={{
            title: `Merge ${step.preview.victimUhid} into ${step.preview.survivorUhid}`,
            description:
              'Every visit, identifier, contact and alert on the retired record moves to the surviving one, and every other module re-points its rows when it receives the event. The retired UHID stays searchable and is never reissued. This can be reversed for thirty days and not after.',
            reasonLabel: 'Reason',
            reasonPlaceholder: 'Choose a reason',
            notePlaceholder: 'The reason is sent with the request and stored on the merge.',
            confirm: 'Merge the records',
            cancel: 'Do not merge',
            typedValuePrompt: (expected) => `Type the retiring UHID ${expected} to confirm`,
            reasonRequired: 'A reason is required. It is stored on the merge and in the audit register.',
            typedValueMismatch: 'The UHID must match exactly.',
          }}
          onConfirm={(result) => {
            setConfirmOpen(false);
            setReason(result.reasonText);
            commit.mutate({ mergeId: step.preview.mergeId });
          }}
        />
      ) : null}

      {step.kind === 'merged' ? (
        <ConfirmWithReasonDialog
          open={unmergeOpen}
          onOpenChange={setUnmergeOpen}
          confirmationValue={step.result.victimUhid}
          labels={{
            title: `Reverse the merge of ${step.result.victimUhid}`,
            description:
              'The retired record is restored and everything moved by the merge goes back to it. Anything recorded against the surviving record since the merge stays where it is.',
            reasonLabel: 'Reason',
            reasonPlaceholder: 'Choose a reason',
            notePlaceholder: 'e.g. Two different patients with the same name and date of birth.',
            confirm: 'Reverse the merge',
            cancel: 'Leave it merged',
            typedValuePrompt: (expected) => `Type ${expected} to confirm`,
            reasonRequired: 'A reason is required and is stored on the merge.',
            typedValueMismatch: 'The UHID must match exactly.',
          }}
          onConfirm={(result) => {
            setUnmergeOpen(false);
            reverse.mutate({ mergeId: step.result.mergeId, reason: result.reasonText });
          }}
        />
      ) : null}
    </div>
  );
}

// ── the queue ────────────────────────────────────────────────────────────────

const QUEUE_LABELS: WorklistTableLabels = {
  caption: 'Suspected duplicate pairs awaiting review',
  scrollRegion: 'Duplicate queue',
  selectAll: 'Select every pair',
  selectRow: 'Select this pair',
  sortAscending: 'Sorted lowest first',
  sortDescending: 'Sorted highest first',
  notSorted: 'Not sorted',
  density: 'Row height',
  densityOption: { compact: 'Compact', default: 'Default', touch: 'Touch' },
  columns: 'Columns',
  savedView: 'Saved view',
  savedViewPlaceholder: 'Choose a view',
  saveView: 'Save this view',
  loadMore: 'Load more',
  loading: 'Loading',
  selectedCount: (count) => `${String(count)} selected`,
  clearSelection: 'Clear the selection',
  rowCount: (count) => `${String(count)} pairs`,
  expandRow: 'Show the rest of this row',
  rowActions: 'Actions for this pair',
};

function DedupeQueue({
  queue,
  loading,
  error,
  onRetry,
  onPick,
}: {
  readonly queue: readonly DedupeCandidateItem[];
  readonly loading: boolean;
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly onPick: (row: DedupeCandidateItem) => void;
}): React.JSX.Element {
  const columns: readonly WorklistColumn<DedupeCandidateItem>[] = [
    {
      key: 'score',
      header: 'Match',
      numeric: true,
      importance: 'always',
      render: (row) => {
        const score = Number.parseFloat(row.score);
        return (
          <Badge tone={score >= 0.9 ? 'danger' : 'warning'} size="sm">
            {Number.isNaN(score) ? row.score : `${String(Math.round(score * 100))}%`}
          </Badge>
        );
      },
    },
    {
      key: 'a',
      header: 'One record',
      importance: 'always',
      render: (row) => (
        <span className="flex flex-col">
          <span className="font-medium">{row.patient_a_name}</span>
          <span className="font-mono text-xs text-fg-muted">{row.patient_a_uhid}</span>
        </span>
      ),
    },
    {
      key: 'b',
      header: 'The other',
      importance: 'always',
      render: (row) => (
        <span className="flex flex-col">
          <span className="font-medium">{row.patient_b_name}</span>
          <span className="font-mono text-xs text-fg-muted">{row.patient_b_uhid}</span>
        </span>
      ),
    },
    {
      key: 'detected',
      header: 'Flagged by',
      importance: 'secondary',
      render: (row) => row.detected_by,
    },
    {
      key: 'created',
      header: 'Flagged',
      importance: 'secondary',
      render: (row) => <span className="font-mono text-xs">{formatTimestamp(row.created_at)}</span>,
    },
  ];

  return (
    <section aria-labelledby="dedupe-queue-heading" className="flex flex-col gap-2">
      <h2 id="dedupe-queue-heading" className="text-md font-semibold text-fg-default">
        Flagged as possible duplicates
      </h2>
      <AsyncPanel
        loading={loading}
        error={error}
        isEmpty={queue.length === 0}
        onRetry={onRetry}
        skeletonLabel="Loading the duplicate queue"
        skeletonRows={5}
        skeletonColumns={[1, 3, 3, 2]}
        empty={
          <div className="rounded-lg border border-dashed border-strong bg-layer-1 p-6 text-center">
            <Users className="mx-auto size-6 text-fg-subtle" aria-hidden="true" />
            <p className="mt-2 text-md font-medium text-fg-default">No pair is waiting to be reviewed.</p>
            <p className="mt-1 text-sm text-fg-muted">
              Pairs appear here when registration finds a close match. You can still merge two records you
              know about by finding them below.
            </p>
          </div>
        }
      >
        <div className="rounded-lg border border-default bg-layer-1">
          <WorklistTable
            rows={queue}
            getRowId={(row) => row.id}
            columns={columns}
            labels={QUEUE_LABELS}
            onRowOpen={onPick}
            empty={{
              cause: 'No pair is waiting to be reviewed.',
              nextAction: 'Find two records below if you know of a duplicate.',
            }}
          />
        </div>
      </AsyncPanel>
    </section>
  );
}

// ── panels ───────────────────────────────────────────────────────────────────

function ChosenRecord({
  patient,
  onClear,
}: {
  readonly patient: PatientDetail;
  readonly onClear: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-2 rounded-md border border-default p-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-fg-default">{patient.full_name}</p>
        <p className="font-mono text-xs text-fg-muted">{patient.uhid}</p>
        <p className="text-xs text-fg-muted">
          {patient.gender} · registered {formatTimestamp(patient.registered_at)}
        </p>
      </div>
      <Button variant="ghost" size="sm" onClick={onClear}>
        Change
      </Button>
    </div>
  );
}

function ChoiceOption({
  id,
  value,
  uhid,
  text,
}: {
  readonly id: string;
  readonly value: SurvivorChoice;
  readonly uhid: string;
  readonly text: string | null;
}): React.JSX.Element {
  return (
    <span className="flex items-start gap-2 rounded-md border border-default p-2">
      <RadioGroupItem id={id} value={value} className="mt-1" />
      <Label htmlFor={id} className="flex min-w-0 flex-col items-start gap-0.5 font-normal">
        <span className="font-mono text-2xs text-fg-muted">{uhid}</span>
        <span className="text-sm text-fg-default">{text ?? 'Not recorded'}</span>
      </Label>
    </span>
  );
}

function PreparedPanel({
  preview,
  committing,
  onConfirm,
  onDiscard,
}: {
  readonly preview: MergePreview;
  readonly committing: boolean;
  readonly onConfirm: () => void;
  readonly onDiscard: () => void;
}): React.JSX.Element {
  const impact = describeImpact(preview.impact);

  return (
    <section
      aria-labelledby="merge-preview-heading"
      data-testid="merge-preview"
      className="rounded-lg border-2 border-warning-border bg-layer-1 p-4"
    >
      <h2
        id="merge-preview-heading"
        className="flex items-center gap-2 text-md font-semibold text-fg-default"
      >
        <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
        Nothing has changed yet. This is what will change.
      </h2>

      <p className="mt-2 text-sm text-fg-default">
        <strong className="font-mono">{preview.victimUhid}</strong> will be retired into{' '}
        <strong className="font-mono">{preview.survivorUhid}</strong>.
      </p>

      <h3 className="mt-3 text-sm font-medium text-fg-default">Re-pointed by this module</h3>
      {impact.length === 0 ? (
        <p className="mt-1 text-sm text-fg-muted">
          The retiring record holds no visits, identifiers, contacts or alerts of its own — only its identity
          moves.
        </p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-2" data-testid="merge-impact">
          {impact.map((line) => (
            <li key={line}>
              <Badge tone="info" size="sm">
                {line}
              </Badge>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-3 text-sm font-medium text-fg-default">Re-pointed by every other module</h3>
      <p className="mt-1 flex items-start gap-2 text-sm text-fg-muted">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>
          Committing emits <span className="font-mono text-xs">patient.merged</span>. Billing, the laboratory,
          pharmacy, appointments and every other module that holds this patient&rsquo;s id re-point their own
          rows when they receive it — OP-001 §5 gives them five minutes. Until they have, the two
          records&rsquo; documents may briefly appear in different places.
        </span>
      </p>

      <p className="mt-3 text-sm text-fg-muted">
        Reversible until <strong>{formatTimestamp(preview.unmergeDeadline)}</strong>, and not after.
      </p>

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onDiscard} data-testid="merge-discard">
          Go back and change something
        </Button>
        <Button
          variant="danger"
          onClick={onConfirm}
          aria-busy={committing}
          disabled={committing}
          data-testid="merge-commit"
        >
          {committing ? 'Merging…' : 'Confirm the merge'}
        </Button>
      </div>
    </section>
  );
}

function MergedPanel({
  result,
  canReverse,
  reversing,
  onOpenSurvivor,
  onReverse,
}: {
  readonly result: MergeResult;
  readonly canReverse: boolean;
  readonly reversing: boolean;
  readonly onOpenSurvivor: () => void;
  readonly onReverse: () => void;
}): React.JSX.Element {
  const repointed = describeImpact(result.repointed);

  return (
    <section
      aria-labelledby="merge-done-heading"
      data-testid="merge-result"
      className="rounded-lg border border-success-border bg-layer-1 p-4"
    >
      <h2 id="merge-done-heading" className="text-md font-semibold text-fg-default">
        Merged at {formatTimestamp(result.mergedAt)}
      </h2>
      <p className="mt-1 text-sm text-fg-default">
        <span className="font-mono">{result.victimUhid}</span> now resolves to{' '}
        <span className="font-mono">{result.survivorUhid}</span>. A card printed with the old UHID still works
        at the desk.
      </p>
      {repointed.length === 0 ? null : (
        <ul className="mt-2 flex flex-wrap gap-2">
          {repointed.map((line) => (
            <li key={line}>
              <Badge tone="success" size="sm">
                {line} moved
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-sm text-fg-muted">
        Reversible until {formatTimestamp(result.unmergeDeadline)}.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="primary" onClick={onOpenSurvivor} data-testid="open-merged-record">
          Open the surviving record
        </Button>
        {canReverse ? (
          <Button variant="secondary" onClick={onReverse} disabled={reversing} data-testid="merge-reverse">
            This was wrong — reverse it
          </Button>
        ) : null}
      </div>
    </section>
  );
}
