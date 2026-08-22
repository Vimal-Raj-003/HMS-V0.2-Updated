'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  ConfirmWithReasonDialog,
  EmptyState,
  Kbd,
  OfflineBadge,
  useToast,
  type ConfirmWithReasonLabels,
} from '@vims/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiProblem } from '@/lib/api';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { ActionUnavailable } from '@/features/frontoffice/components/frontoffice-gate';
import { ContextField, isIdentifier } from '@/features/frontoffice/components/context-field';
import { ShortcutBar } from '@/features/frontoffice/components/keyboard-sheet';
import { useShortcuts, type Shortcut } from '@/features/frontoffice/lib/shortcuts';
import { useSession } from '@/lib/session-context';
import { clinicalKeys } from '../api/keys';
import {
  amendEncounter,
  completeEncounter,
  getAllergies,
  getEncounter,
  getMedications,
  getNoteVersions,
  getProblems,
  getTimeline,
  recordDiagnoses,
  updateEncounter,
} from '../api/client';
import type {
  DiagnosisCertainty,
  DiagnosisInput,
  DiagnosisRow,
  EncounterDetail,
  Laterality,
} from '../api/types';
import { isVersionConflict } from '../lib/problems';
import { formatInstant } from '../lib/numbers';
import {
  conflictedSections,
  draftFromEncounter,
  draftsDiffer,
  EMPTY_DRAFT,
  toNoteBody,
  toUpdateRequest,
  type ConflictedSection,
  type NoteDraft,
} from '../lib/note';
import {
  markOutboxError,
  queueDraft,
  readCache,
  readOutbox,
  removeFromOutbox,
  stalenessLabel,
  writeCache,
  type CacheScope,
  type QueuedDraft,
} from '../lib/offline';
import { ClinicalPatientHeader } from './patient-header';
import { MedicationsPanel, ProblemsPanel, TimelinePanel } from './context-rail';
import { CountersignPanel } from './countersign-panel';
import { DiagnosisPanel } from './diagnosis-panel';
import { NoteEditor, type AutosaveState } from './note-editor';
import { NoteVersionsPanel } from './note-versions-panel';

/**
 * OP-002 — the consultation workspace, and OP-019's offline half.
 *
 * ## The four things this screen guarantees
 *
 * 1. **The note autosaves, and says whether it saved.** Every five seconds while
 *    the text differs from what the server has. The indicator is never
 *    optimistic: "Saved 14:03" appears only after the API answered.
 * 2. **A signed note is amended, never edited.** Signing makes the editor
 *    read-only; amending opens a copy, demands a reason, and produces a new
 *    version with both versions visible afterwards.
 * 3. **A losing save is told, not absorbed.** A `409` from the encounter's
 *    optimistic lock renders both texts and asks the doctor. Nothing is merged
 *    and nothing is dropped.
 * 4. **Offline, it degrades to a labelled read.** With no network the chart is
 *    served from an explicit local cache stamped with when it was captured, and
 *    the note is queued on the device with the version it was written against.
 *    See `lib/offline.ts` for why this is not the service worker.
 *
 * ## The gap
 *
 * OP-002 §8 opens with a **doctor's live queue** ("token, name, age/sex, vitals
 * with abnormal flags, wait time … one-key start consultation"). There is no API
 * for it in this build: `GET /encounters` lists encounters that already exist,
 * `GET /visits` is Phase 1's and carries no vitals, and there is no
 * `GET /opd/queue`. Building a "queue" from the encounter list would show
 * consultations already started and miss every patient waiting — worse than
 * absent. So the console opens on an encounter identifier, and the queue is
 * reported as missing.
 */

const AMEND_LABELS: ConfirmWithReasonLabels = {
  title: 'Amend this signed note?',
  description:
    'The signed version is kept exactly as it is. This creates a new version carrying your reason, and both are readable afterwards. Amendments are audited and are visible to medical records.',
  reasonLabel: 'Why is it being amended',
  reasonPlaceholder: 'Choose a reason',
  notePlaceholder: 'What was wrong, and what you have corrected',
  confirm: 'Create the amended version',
  cancel: 'Leave the note as signed',
  typedValuePrompt: (expected) => `Type ${expected} to confirm`,
  reasonRequired: 'A reason is required — an amendment without one is an overwrite wearing a version number.',
  typedValueMismatch: 'That does not match.',
};

const AUTOSAVE_INTERVAL_MS = 5_000;

/**
 * `docs/06` §5.2 — the offline badge is `role="status"` and it never says
 * "saved". "Held on this device" is the honest phrasing for a note that exists
 * in one place and would be lost with the tablet.
 */
const OFFLINE_LABELS = {
  online: 'Online',
  degraded: 'Network is slow — saves may be delayed',
  offline: (queued: number) =>
    queued === 0
      ? 'Offline — this chart is the copy held on this device'
      : `Offline — ${String(queued)} note held on this device, not on the server`,
  syncing: (done: number, total: number) => `Syncing ${String(done)} of ${String(total)}`,
  conflict: (conflicts: number) => `${String(conflicts)} to resolve`,
  openQueue: 'Show what is waiting to sync',
};

export function DoctorConsoleScreen(): React.JSX.Element {
  const { hospitalId, userId, granted } = useSession();
  const keys = clinicalKeys(hospitalId);
  const queryClient = useQueryClient();
  const { publish } = useToast();

  const scope = useMemo<CacheScope>(() => ({ hospitalId, userId }), [hospitalId, userId]);

  const [encounterId, setEncounterId] = useState('');
  const [draft, setDraft] = useState<NoteDraft>(EMPTY_DRAFT);
  const [serverDraft, setServerDraft] = useState<NoteDraft>(EMPTY_DRAFT);
  const [autosave, setAutosave] = useState<AutosaveState>({ kind: 'idle' });
  const [conflicts, setConflicts] = useState<readonly ConflictedSection[]>([]);
  const [amending, setAmending] = useState(false);
  const [confirmAmend, setConfirmAmend] = useState(false);
  const [online, setOnline] = useState(true);
  const [queued, setQueued] = useState<readonly QueuedDraft[]>([]);
  const loadedFor = useRef<string>('');

  const canSign = granted.has('opd.encounter.sign');
  const canAmend = granted.has('opd.encounter.amend');
  const canUpdate = granted.has('opd.encounter.update');
  const canDiagnose = granted.has('opd.diagnosis.update');
  const canReadPatient = granted.has('patient.record.read');

  const ready = isIdentifier(encounterId);

  useEffect(() => {
    const update = (): void => {
      setOnline(navigator.onLine);
    };
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    setQueued(readOutbox(scope));
  }, [scope]);

  const encounterQuery = useQuery({
    queryKey: keys.encounter(encounterId),
    queryFn: ({ signal }) => getEncounter(encounterId, { signal }),
    enabled: ready,
  });

  const encounter = encounterQuery.data;
  const patientId = encounter?.patient_id ?? '';

  // The explicit offline copy. Written on every successful read, and read only
  // when the network read has failed — never in front of it.
  useEffect(() => {
    if (encounter !== undefined) writeCache(scope, `encounter.${encounter.id}`, encounter, new Date());
  }, [encounter, scope]);

  const cached = useMemo(
    () =>
      ready && encounterQuery.isError
        ? readCache<EncounterDetail>(scope, `encounter.${encounterId}`, new Date())
        : null,
    [ready, encounterQuery.isError, scope, encounterId],
  );

  const shown = encounter ?? cached?.value;
  const isStale = encounter === undefined && cached !== null;
  const signed = shown?.status === 'completed' || shown?.status === 'amended';
  const readOnly = signed && !amending;

  // Load the draft once per encounter. Re-running on every fetch would discard
  // whatever the doctor typed in the last five seconds, which is precisely the
  // silent loss the phase forbids.
  useEffect(() => {
    if (shown === undefined) return;
    if (loadedFor.current === shown.id) return;
    loadedFor.current = shown.id;
    const fromServer = draftFromEncounter(shown);
    const pending = readOutbox(scope).find((entry) => entry.encounterId === shown.id);
    setServerDraft(fromServer);
    setDraft(pending?.draft ?? fromServer);
    setAutosave(
      pending === undefined ? { kind: 'idle' } : { kind: 'queued', at: formatInstant(pending.queuedAt) },
    );
  }, [shown, scope]);

  const allergiesQuery = useQuery({
    queryKey: keys.allergies(patientId),
    queryFn: ({ signal }) => getAllergies(patientId, { signal }),
    enabled: patientId !== '' && canReadPatient,
  });

  const timelineQuery = useQuery({
    queryKey: keys.timeline(patientId, 'all'),
    queryFn: ({ signal }) => getTimeline(patientId, { limit: 50 }, { signal }),
    enabled: patientId !== '' && canReadPatient,
  });

  const problemsQuery = useQuery({
    queryKey: keys.problems(patientId),
    queryFn: ({ signal }) => getProblems(patientId, { signal }),
    enabled: patientId !== '' && canReadPatient,
  });

  const medicationsQuery = useQuery({
    queryKey: keys.medications(patientId),
    queryFn: ({ signal }) => getMedications(patientId, { signal }),
    enabled: patientId !== '' && canReadPatient,
  });

  const versionsQuery = useQuery({
    queryKey: keys.noteVersions(encounterId),
    queryFn: ({ signal }) => getNoteVersions(encounterId, { signal }),
    enabled: ready && signed,
  });

  const refreshEncounter = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: keys.encounter(encounterId) });
  }, [queryClient, keys, encounterId]);

  const autosaveMutation = useMutation({
    mutationFn: (input: { readonly draft: NoteDraft; readonly version: number }) =>
      updateEncounter(encounterId, toUpdateRequest(input.draft, input.version)),
    onSuccess: (updated) => {
      setServerDraft(draftFromEncounter(updated));
      setConflicts([]);
      setAutosave({ kind: 'saved', at: formatInstant(new Date().toISOString()) });
      removeFromOutbox(scope, updated.id);
      setQueued(readOutbox(scope));
      queryClient.setQueryData(keys.encounter(encounterId), updated);
    },
    onError: (error, variables) => {
      if (isVersionConflict(error)) {
        // Somebody else saved first. Show both, decide nothing.
        setConflicts(conflictedSections(variables.draft, serverDraft));
        setAutosave({ kind: 'failed', message: 'Changed elsewhere — nothing overwritten' });
        refreshEncounter();
        return;
      }
      if (!(error instanceof ApiProblem)) {
        // No network. The draft is kept on the device with the version it was
        // written against, and the indicator says so — it never claims "saved".
        const at = new Date().toISOString();
        queueDraft(scope, {
          id: `${encounterId}-${at}`,
          encounterId,
          patientId,
          draft: variables.draft,
          baseVersion: variables.version,
          queuedAt: at,
        });
        setQueued(readOutbox(scope));
        setAutosave({ kind: 'queued', at: formatInstant(at) });
        return;
      }
      markOutboxError(scope, encounterId, error.message);
      setQueued(readOutbox(scope));
      setAutosave({ kind: 'failed', message: error.problem.title });
    },
  });

  const dirty = draftsDiffer(draft, serverDraft);

  // The five-second autosave. A timer rather than an effect on every keystroke:
  // a save per character is a save the network cannot keep up with, and the
  // doctor's typing is what would suffer.
  useEffect(() => {
    if (!ready || readOnly || !canUpdate || shown === undefined) return undefined;
    if (!dirty || autosaveMutation.isPending) return undefined;

    const timer = setTimeout(() => {
      setAutosave({ kind: 'pending' });
      autosaveMutation.mutate({ draft, version: shown.version });
    }, AUTOSAVE_INTERVAL_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [ready, readOnly, canUpdate, shown, dirty, draft, autosaveMutation]);

  // Flush the outbox when the network returns. One attempt per entry; a refusal
  // keeps the entry and records why, so nothing disappears quietly.
  useEffect(() => {
    if (!online || queued.length === 0 || !canUpdate) return;
    const pending = queued.find((entry) => entry.encounterId === encounterId);
    if (pending === undefined || autosaveMutation.isPending) return;
    autosaveMutation.mutate({ draft: pending.draft, version: pending.baseVersion });
  }, [online, queued, encounterId, canUpdate, autosaveMutation]);

  const sign = useMutation({
    mutationFn: () => completeEncounter(encounterId, { note: toNoteBody(draft), signMethod: 'system' }),
    onSuccess: (updated) => {
      queryClient.setQueryData(keys.encounter(encounterId), updated);
      setServerDraft(draftFromEncounter(updated));
      void queryClient.invalidateQueries({ queryKey: keys.noteVersions(encounterId) });
      publish({
        title: 'Consultation signed',
        description: 'The note is now immutable. Changing it creates an amended version with a reason.',
        severity: 'success',
      });
    },
  });

  const amend = useMutation({
    mutationFn: (reason: string) =>
      amendEncounter(encounterId, { reason, note: toNoteBody(draft), signMethod: 'system' }),
    onSuccess: (updated) => {
      setAmending(false);
      setConfirmAmend(false);
      queryClient.setQueryData(keys.encounter(encounterId), updated);
      setServerDraft(draftFromEncounter(updated));
      void queryClient.invalidateQueries({ queryKey: keys.noteVersions(encounterId) });
      publish({
        title: 'Amended',
        description: 'A new version was created. The signed version it replaces is still on the record.',
        severity: 'success',
      });
    },
  });

  const diagnose = useMutation({
    mutationFn: (diagnosis: DiagnosisInput) =>
      // The endpoint replaces the whole set, so the existing rows travel with
      // the new one. Sending only the new diagnosis would silently delete the
      // rest — the kind of data loss that is invisible until an audit.
      recordDiagnoses(encounterId, [...(shown?.diagnoses ?? []).map(toDiagnosisInput), diagnosis]),
    onSuccess: (updated) => {
      queryClient.setQueryData(keys.encounter(encounterId), updated);
      publish({ title: 'Diagnosis recorded', severity: 'success' });
    },
  });

  const shortcuts: readonly Shortcut[] = useMemo(
    () => [
      {
        key: 's',
        ctrl: true,
        label: 'Save the note now',
        keys: ['Ctrl', 'S'],
        enabled: canUpdate && !readOnly,
        run: () => {
          if (shown !== undefined) {
            setAutosave({ kind: 'pending' });
            autosaveMutation.mutate({ draft, version: shown.version });
          }
        },
      },
      {
        key: 'Enter',
        ctrl: true,
        label: 'Sign and complete',
        keys: ['Ctrl', 'Enter'],
        enabled: canSign && !signed,
        run: () => {
          sign.mutate();
        },
      },
      {
        key: 'a',
        alt: true,
        label: 'Amend the signed note',
        keys: ['Alt', 'A'],
        enabled: canAmend && signed,
        run: () => {
          setAmending(true);
        },
      },
    ],
    [canUpdate, readOnly, canSign, canAmend, signed, shown, draft, autosaveMutation, sign],
  );

  useShortcuts(shortcuts);

  return (
    <section className="flex flex-col gap-4" data-testid="doctor-console">
      <PageHeader
        eyebrow="OPD clinical"
        title="Consultation"
        description="The chart, the note and the signature. The note saves every five seconds and tells you when it did; once signed it is amended, never edited."
        primaryAction={
          signed ? (
            canAmend ? (
              amending ? (
                <Button
                  variant="primary"
                  data-testid="amend-save"
                  onClick={() => {
                    setConfirmAmend(true);
                  }}
                >
                  Save the amendment
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  data-testid="amend-open"
                  onClick={() => {
                    setAmending(true);
                  }}
                >
                  Amend <Kbd>Alt</Kbd>
                  <Kbd>A</Kbd>
                </Button>
              )
            ) : undefined
          ) : canSign ? (
            <Button
              variant="primary"
              data-testid="sign-note"
              disabled={!ready || sign.isPending}
              onClick={() => {
                sign.mutate();
              }}
            >
              Sign and complete <Kbd>Ctrl</Kbd>
              <Kbd>↵</Kbd>
            </Button>
          ) : undefined
        }
        meta={
          <>
            {online ? null : (
              <OfflineBadge state={{ kind: 'offline', queued: queued.length }} labels={OFFLINE_LABELS} />
            )}
            {shown === undefined ? null : <Badge tone="neutral">{shown.status}</Badge>}
            {isStale && cached !== null ? (
              <Badge tone="warning" data-testid="stale-badge">
                From this device — {stalenessLabel(cached.capturedAt, new Date())}
              </Badge>
            ) : null}
          </>
        }
      />

      <div className="flex flex-wrap items-end gap-4">
        <ContextField
          label="Consultation"
          testId="console-encounter"
          hint="The encounter to open. There is no doctor's queue endpoint in this build, so the console opens on an identifier."
          value={encounterId}
          onChange={(next) => {
            setEncounterId(next);
            loadedFor.current = '';
            setConflicts([]);
          }}
        />
      </div>

      {!ready ? (
        <EmptyState
          cause="No consultation opened."
          nextAction="Paste the encounter identifier above. Nothing is read from the server until then, so no record is opened by accident."
        />
      ) : shown === undefined ? (
        <AsyncPanel
          loading={encounterQuery.isLoading}
          error={encounterQuery.error}
          isEmpty={false}
          skeletonLabel="Opening the consultation"
          onRetry={() => void encounterQuery.refetch()}
          empty={null}
        >
          {null}
        </AsyncPanel>
      ) : (
        <>
          {isStale ? (
            <p
              role="status"
              data-testid="offline-notice"
              className="rounded-md border border-warning-border bg-warning-surface p-3 text-sm text-warning-on-surface"
            >
              This is the copy held on this device, not a live read. Treat every value as of the time above,
              and do not prescribe from it without checking.
            </p>
          ) : null}

          {canReadPatient ? (
            <ClinicalPatientHeader
              patientId={shown.patient_id}
              allergies={allergiesQuery.data ?? null}
              allergiesFailed={allergiesQuery.isError}
            />
          ) : null}

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,280px)_minmax(0,2fr)_minmax(0,320px)]">
            <div className="order-2 xl:order-1">
              <TimelinePanel
                items={timelineQuery.data?.items ?? []}
                loading={timelineQuery.isLoading}
                error={timelineQuery.error}
                onRetry={() => void timelineQuery.refetch()}
              />
            </div>

            <div className="order-1 flex flex-col gap-4 xl:order-2">
              {canUpdate || readOnly ? null : (
                <ActionUnavailable
                  title="You can read this consultation but not write to it"
                  because="Writing a consultation note is the treating doctor's key. Nursing and medical records read the same note without it."
                  permission="opd.encounter.update"
                />
              )}

              <NoteEditor
                draft={draft}
                onChange={setDraft}
                readOnly={readOnly || !canUpdate}
                autosave={autosave}
                conflicts={conflicts}
                onKeepMine={() => {
                  setConflicts([]);
                  if (shown !== undefined) {
                    setAutosave({ kind: 'pending' });
                    autosaveMutation.mutate({ draft, version: shown.version });
                  }
                }}
                onTakeTheirs={() => {
                  setConflicts([]);
                  setDraft(serverDraft);
                  setAutosave({ kind: 'idle' });
                }}
              />

              {sign.isError ? <ProblemCard error={sign.error} /> : null}
              {amend.isError ? <ProblemCard error={amend.error} /> : null}

              <DiagnosisPanel
                diagnoses={shown.diagnoses}
                canEdit={canDiagnose}
                readOnly={readOnly}
                saving={diagnose.isPending}
                onAdd={(diagnosis) => {
                  diagnose.mutate(diagnosis);
                }}
              />
              {diagnose.isError ? <ProblemCard error={diagnose.error} /> : null}

              {signed ? (
                <NoteVersionsPanel
                  history={versionsQuery.data}
                  loading={versionsQuery.isLoading}
                  error={versionsQuery.error}
                  onRetry={() => void versionsQuery.refetch()}
                />
              ) : null}
            </div>

            <aside className="order-3 flex flex-col gap-4">
              <ProblemsPanel
                items={problemsQuery.data ?? []}
                loading={problemsQuery.isLoading}
                error={problemsQuery.error}
                onRetry={() => void problemsQuery.refetch()}
              />
              <MedicationsPanel
                items={medicationsQuery.data ?? []}
                loading={medicationsQuery.isLoading}
                error={medicationsQuery.error}
                onRetry={() => void medicationsQuery.refetch()}
              />
              <CountersignPanel encounterId={encounterId} />
            </aside>
          </div>
        </>
      )}

      <ConfirmWithReasonDialog
        open={confirmAmend}
        onOpenChange={setConfirmAmend}
        labels={AMEND_LABELS}
        onConfirm={(result) => {
          amend.mutate(result.reasonText);
        }}
      />

      <ShortcutBar shortcuts={shortcuts} label="Consultation shortcuts" />
    </section>
  );
}

/**
 * An existing diagnosis row, back in request shape.
 *
 * The row's `certainty` and `laterality` are `string` on the wire because the
 * API projects a Postgres enum through `::text`. They are narrowed rather than
 * cast: an unrecognised value falls back to the safest arm — `provisional`
 * rather than `confirmed`, `not_applicable` rather than a side — because a
 * client that upgrades a doctor's provisional diagnosis to confirmed, or invents
 * a laterality, is worse than one that loses a nuance.
 */
function toDiagnosisInput(row: DiagnosisRow): DiagnosisInput {
  const certainty: DiagnosisCertainty =
    row.certainty === 'confirmed' || row.certainty === 'rule_out' || row.certainty === 'chronic'
      ? row.certainty
      : 'provisional';
  const laterality: Laterality =
    row.laterality === 'left' || row.laterality === 'right' || row.laterality === 'bilateral'
      ? row.laterality
      : 'not_applicable';

  return {
    codeSystemKey: 'ICD10',
    code: row.code,
    description: row.description,
    rank: row.rank === 'primary' ? 'primary' : 'secondary',
    certainty,
    laterality,
  };
}
