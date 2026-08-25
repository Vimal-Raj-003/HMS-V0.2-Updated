'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Label,
  Tabs,
  TabsList,
  TabsTrigger,
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
import { FileSearch, OctagonAlert, TriangleAlert } from '@/lib/icons';
import { useSession } from '@/lib/session-context';
import {
  authoriseResults,
  enterResults,
  getQcState,
  listBenchWorklist,
  listCriticalValues,
  listLabTests,
  listPatientResults,
  verifyResults,
} from '../api/client';
import { diagnosticsKeys } from '../api/keys';
import { LAB_DISCIPLINES, type LabDiscipline, type LabWorklistItem } from '../api/types';
import { authorisationVerdict } from '../lib/critical';
import { formatInstant, humanise, priorityTone, tatVerdict } from '../lib/format';
import { releaseVerdict, type ReleaseVerdict } from '../lib/qc-gate';
import { patientRef, worklistLabels } from '../lib/worklist-labels';
import { ResultFlagCell } from './result-flag';

/**
 * OP-004 §3.3–§3.4 — the bench: enter, verify, authorise.
 *
 * ## Three gates, and the direction each one points
 *
 * **The QC gate (EN-031 §3.3.3, §5 bullet 1).** An analyte whose control is out
 * of range holds patient results. `lib/qc-gate.ts` implements the *stricter* of
 * the two specs — EN-031 blocks manual release too, and puts the only exception
 * at Lab Director level — and it **fails closed**: when the QC state cannot be
 * read, release is disabled with a message rather than allowed. The natural
 * shortcut (`state?.permits_release ?? true`) is exactly the bug and reads as
 * reasonable, which is why it is a named function with a test rather than an
 * inline `??`.
 *
 * **The critical-value gate (OP-004 §5, D-10).** A critical value's *result* is
 * never withheld — it is on this screen, flagged, the moment it exists, and the
 * alert has already gone to the ordering clinician. What is gated is
 * **authorisation**: it needs a read-back from a named clinician, or a
 * documented "clinician unreachable — escalated to <tier>". The button is
 * disabled with that sentence and a link to the board, rather than enabled into
 * a 409.
 *
 * **Segregation of duty (OP-004 §5 bullet 4).** Entering, verifying and
 * authorising are three different permission keys, and the API additionally
 * refuses a verifier who was the enterer — a rule no route decorator can express
 * because it depends on the row. This screen offers the actions the session
 * holds keys for and lets the API refuse the rest, with the refusal rendered
 * rather than swallowed.
 *
 * ## What is missing, and why
 *
 * `GET /lab/worklists/bench` returns `test_code` and `test_name` but **no
 * `test_key`**, and it returns no result ids. So:
 *
 *  - the QC gate is applied per *screen* (a banner naming every analyte
 *    currently holding results, plus a hard disable on the release buttons)
 *    rather than per row, because the row cannot be joined to a QC state;
 *  - **batch verification is not offered.** OP-004 §8 asks for `F5` "verify
 *    selected"; resolving a page of selected rows to their result ids would take
 *    one request per patient, and a bulk release built on a fan-out that can
 *    partially fail is worse than no bulk release. One row at a time, with the
 *    results for that row loaded explicitly.
 *
 * Both are reported as API gaps rather than worked around silently.
 */
export function LabBenchScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = diagnosticsKeys(hospitalId);
  const queryClient = useQueryClient();
  const { publish } = useToast();

  const [discipline, setDiscipline] = useState<LabDiscipline>('biochemistry');
  const [stage, setStage] = useState<'pending' | 'awaiting_release'>('pending');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [focused, setFocused] = useState<LabWorklistItem | null>(null);
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState('');
  const [comment, setComment] = useState('');

  const canVerify = granted.has('lab.result.verify');
  const canAuthorise = granted.has('lab.result.validate');
  const canReadResults = granted.has('lab.result.read');
  const canReadQc = granted.has('labq.qc.read');
  const canReadCriticals = granted.has('lab.critical.read');
  const canReadCatalogue = granted.has('mdm.read');

  const worklist = useQuery({
    queryKey: keys.bench(discipline, stage),
    queryFn: ({ signal }) => listBenchWorklist({ discipline, stage, cursor }, { signal }),
  });

  /**
   * The QC state for the whole laboratory, not for one analyte.
   *
   * `GET /lab/qc/state` takes an optional `testKey`, and the worklist does not
   * carry one — so the screen reads the state list and derives the blocked set
   * from it. That is also what EN-031 §8 bullet 1 asks for: "a red banner
   * listing analytes currently blocking release".
   */
  const qc = useQuery({
    queryKey: keys.qcStateRoot(),
    queryFn: ({ signal }) => getQcState({}, { signal }),
    enabled: canReadQc,
    staleTime: 30_000,
  });

  const catalogue = useQuery({
    queryKey: keys.testCatalogue('', discipline),
    queryFn: ({ signal }) => listLabTests({ discipline }, { signal }),
    enabled: canReadCatalogue,
    staleTime: 10 * 60_000,
  });

  const criticals = useQuery({
    queryKey: keys.criticalValues(true),
    queryFn: ({ signal }) => listCriticalValues({ open: true }, { signal }),
    enabled: canReadCriticals,
    refetchInterval: 60_000,
  });

  const focusedResults = useQuery({
    queryKey: keys.patientResults(focused?.patient_id ?? 'none'),
    queryFn: ({ signal }) =>
      focused === null
        ? Promise.resolve({ items: [], nextCursor: null, hasMore: false })
        : listPatientResults(focused.patient_id, {}, { signal }),
    enabled: focused !== null && canReadResults,
  });

  const testNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const test of catalogue.data?.items ?? []) map.set(test.record_key, test.name);
    return map;
  }, [catalogue.data]);

  const blockedAnalytes = useMemo(
    () => (qc.data?.items ?? []).filter((state) => !state.permits_release),
    [qc.data],
  );

  /**
   * The screen-level release verdict.
   *
   * `stateUnavailable` is true whenever the QC state could not be read at all —
   * an error, or a session without `labq.qc.read`. EN-031 §13 and AC 17: the
   * gate fails closed. A technologist who cannot see the QC state does not get a
   * release button that works anyway.
   */
  const qcUnavailable = !canReadQc || qc.isError;
  const qcVerdict: ReleaseVerdict = qcUnavailable
    ? releaseVerdict(undefined, true)
    : blockedAnalytes.length > 0
      ? releaseVerdict(blockedAnalytes[0], false)
      : { kind: 'permitted' };

  const openAlertsForFocus = useMemo(() => {
    if (focused === null) return [];
    return (criticals.data?.items ?? []).filter((alert) => alert.order_test_id === focused.order_test_id);
  }, [criticals.data, focused]);

  const criticalVerdict = authorisationVerdict(openAlertsForFocus);

  const rowResults = useMemo(() => {
    if (focused === null) return [];
    return (focusedResults.data?.items ?? []).filter(
      (result) => result.order_test_id === focused.order_test_id,
    );
  }, [focusedResults.data, focused]);

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: keys.benchRoot() });
    void queryClient.invalidateQueries({ queryKey: keys.labResults() });
    void queryClient.invalidateQueries({ queryKey: keys.criticalValuesRoot() });
  }

  const save = useMutation({
    mutationFn: () => {
      if (focused === null) throw new Error('No worklist row is selected.');
      const numeric = Number.parseFloat(value);
      const trimmedUnit = unit.trim();
      const trimmedComment = comment.trim();
      return enterResults([
        {
          orderTestId: focused.order_test_id,
          resultType: Number.isFinite(numeric) ? 'numeric' : 'text',
          ...(Number.isFinite(numeric) ? { valueNumeric: numeric } : { valueText: value.trim() }),
          valueMulti: [],
          instrumentFlags: [],
          ...(trimmedUnit === '' ? {} : { unit: trimmedUnit }),
          ...(trimmedComment === '' ? {} : { comment: trimmedComment }),
        },
      ]);
    },
    onSuccess: (entered) => {
      refresh();
      setValue('');
      setComment('');
      const critical = entered.results.some((result) => result.ever_critical);
      publish({
        title: critical ? 'Saved — critical value' : 'Result saved',
        description: critical
          ? 'The alert has already gone to the ordering clinician. Record the call-back on the critical-value board before you authorise.'
          : 'Verification is a separate key, and the API refuses a verifier who was the enterer.',
        severity: critical ? 'danger' : 'success',
      });
    },
  });

  const verify = useMutation({
    mutationFn: (resultIds: readonly string[]) => verifyResults({ resultIds, signMethod: 'system' }),
    onSuccess: () => {
      refresh();
      publish({ title: 'Technically verified', severity: 'success' });
    },
  });

  const authorise = useMutation({
    mutationFn: (resultIds: readonly string[]) => authoriseResults({ resultIds, signMethod: 'system' }),
    onSuccess: () => {
      refresh();
      publish({
        title: 'Authorised',
        description: 'The result is released to the report and to the ordering doctor’s timeline.',
        severity: 'success',
      });
    },
  });

  const unreleasedIds = rowResults
    .filter((result) => result.current_status !== 'authorised')
    .map((result) => result.id);
  const verifiedIds = rowResults
    .filter((result) => result.current_status === 'verified')
    .map((result) => result.id);

  const releaseBlocked = qcVerdict.kind === 'blocked';
  const criticalBlocked = criticalVerdict.kind === 'blocked';

  const shortcuts: readonly Shortcut[] = useMemo(
    () => [
      {
        key: 'Enter',
        ctrl: true,
        label: 'Save the result',
        keys: ['Ctrl', '↵'],
        enabled: focused !== null && value.trim() !== '' && !save.isPending,
        run: () => {
          save.mutate();
        },
      },
      {
        key: 'F5',
        label: 'Verify this row',
        keys: ['F5'],
        enabled: canVerify && unreleasedIds.length > 0 && !releaseBlocked,
        run: () => {
          verify.mutate(unreleasedIds);
        },
      },
      {
        key: 'F9',
        label: 'Authorise this row',
        keys: ['F9'],
        enabled: canAuthorise && verifiedIds.length > 0 && !releaseBlocked && !criticalBlocked,
        run: () => {
          authorise.mutate(verifiedIds);
        },
      },
    ],
    [
      focused,
      value,
      save,
      verify,
      authorise,
      canVerify,
      canAuthorise,
      unreleasedIds,
      verifiedIds,
      releaseBlocked,
      criticalBlocked,
    ],
  );
  useShortcuts(shortcuts);

  const now = new Date();

  return (
    <section className="flex flex-col gap-4" data-testid="lab-bench-screen">
      <PageHeader
        eyebrow="OP-004 · analytical"
        title="Bench worklist"
        description="Work to do, and work waiting to be released. Entering, verifying and authorising are three different keys, and no one person holds the whole path by accident."
        actions={
          <Tabs
            value={stage}
            onValueChange={(next) => {
              setStage(next === 'awaiting_release' ? 'awaiting_release' : 'pending');
              setCursor(undefined);
              setFocused(null);
            }}
          >
            <TabsList>
              <TabsTrigger value="pending">Work to do</TabsTrigger>
              <TabsTrigger value="awaiting_release">Awaiting release</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      {releaseBlocked ? (
        <div
          role="alert"
          data-testid="qc-block-banner"
          className="rounded-lg border border-danger-border bg-danger-surface p-3 text-sm text-danger-on-surface"
        >
          <p className="flex items-center gap-2 font-medium">
            <OctagonAlert className="size-4 shrink-0" aria-hidden="true" />
            Release is held
          </p>
          <p className="mt-1">{qcVerdict.message}</p>
          {qcVerdict.qcStateRef === null ? null : (
            <p className="mt-1 font-mono text-2xs">QC reference: {qcVerdict.qcStateRef}</p>
          )}
          {blockedAnalytes.length === 0 ? null : (
            <ul className="mt-2 flex flex-wrap gap-2" data-testid="blocked-analytes">
              {blockedAnalytes.map((state) => (
                <li key={state.id}>
                  <Badge tone="danger" icon={<TriangleAlert aria-hidden="true" />}>
                    {testNames.get(state.test_key) ?? `analyte ${state.test_key.slice(-6)}`} —{' '}
                    {humanise(state.state)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-56 flex-col gap-1">
          <Label htmlFor="bench-discipline">Sub-department</Label>
          <select
            id="bench-discipline"
            data-testid="bench-discipline"
            className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            value={discipline}
            onChange={(event) => {
              setDiscipline(event.target.value as LabDiscipline);
              setCursor(undefined);
              setFocused(null);
            }}
          >
            {LAB_DISCIPLINES.map((one) => (
              <option key={one} value={one}>
                {humanise(one)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <AsyncPanel
          loading={worklist.isPending}
          error={worklist.error}
          isEmpty={(worklist.data?.items.length ?? 0) === 0}
          skeletonLabel="Loading the bench worklist"
          onRetry={() => {
            void worklist.refetch();
          }}
          empty={
            <EmptyState
              icon={<FileSearch aria-hidden="true" />}
              cause={`Nothing is ${stage === 'pending' ? 'waiting to be resulted' : 'waiting to be released'} in ${humanise(discipline)}.`}
              nextAction={
                stage === 'pending'
                  ? 'Try another sub-department, or check the collection screen — a specimen that has not been accessioned never reaches this list.'
                  : 'Switch to “Work to do” to enter results, or try another sub-department.'
              }
            />
          }
        >
          <WorklistTable
            rows={worklist.data?.items ?? []}
            getRowId={(row) => row.id}
            labels={worklistLabels(`${humanise(discipline)} bench worklist`)}
            empty={{
              cause: 'Nothing on this bench right now.',
              nextAction: 'Try another sub-department.',
            }}
            onRowOpen={(row) => {
              setFocused(row);
              setValue('');
              setUnit('');
              setComment('');
            }}
            criticalRowIds={
              new Set(
                (worklist.data?.items ?? []).filter((row) => row.priority === 'stat').map((row) => row.id),
              )
            }
            hasMore={worklist.data?.hasMore ?? false}
            loading={worklist.isFetching}
            onLoadMore={() => {
              setCursor(worklist.data?.nextCursor ?? undefined);
            }}
            columns={[
              {
                key: 'accession',
                header: 'Accession',
                hideable: false,
                render: (row) => <span className="font-mono text-xs">{row.accession_no}</span>,
              },
              {
                key: 'patient',
                header: 'Patient ref',
                hideable: false,
                render: (row) => <span className="font-mono text-xs">{patientRef(row.patient_id)}</span>,
              },
              {
                key: 'test',
                header: 'Test',
                hideable: false,
                render: (row) => (
                  <span className="text-sm">
                    <span className="font-mono text-xs text-fg-muted">{row.test_code}</span> {row.test_name}
                  </span>
                ),
              },
              {
                key: 'priority',
                header: 'Priority',
                render: (row) => (
                  <span className={`text-xs font-medium ${priorityTone(row.priority)}`}>
                    {humanise(row.priority)}
                  </span>
                ),
              },
              {
                key: 'tat',
                header: 'Turnaround',
                render: (row) => {
                  const verdict = tatVerdict(row.tat_due_at, row.received_at, now);
                  return (
                    <span className={`text-xs ${verdict.toneClass}`} data-testid={`tat-${row.id}`}>
                      {verdict.label}
                    </span>
                  );
                },
              },
              {
                key: 'barcode',
                header: 'Specimen',
                importance: 'secondary',
                render: (row) => (
                  <span className="font-mono text-2xs text-fg-muted">
                    {row.sample_no ?? '—'} {row.barcode === null ? '' : `· ${row.barcode}`}
                  </span>
                ),
              },
              {
                key: 'received',
                header: 'Received',
                importance: 'secondary',
                render: (row) => <span className="font-mono text-2xs">{formatInstant(row.received_at)}</span>,
              },
            ]}
          />
        </AsyncPanel>

        <section className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
          {focused === null ? (
            <EmptyState
              cause="No test line is open."
              nextAction="Open a row from the worklist to enter, verify or authorise its result."
            />
          ) : (
            <>
              <header className="flex flex-col gap-1 border-b border-default pb-2">
                <p className="text-md font-medium text-fg-default">{focused.test_name}</p>
                <p className="font-mono text-2xs text-fg-muted">
                  {focused.accession_no} · {patientRef(focused.patient_id)} · {humanise(focused.status)}
                </p>
              </header>

              {stage === 'pending' ? (
                <div className="flex flex-col gap-3" data-testid="result-entry">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="result-value">Result</Label>
                      <Input
                        id="result-value"
                        data-testid="result-value"
                        autoComplete="off"
                        className="font-mono tabular-nums"
                        value={value}
                        onChange={(event) => {
                          setValue(event.target.value);
                        }}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="result-unit">Unit</Label>
                      <Input
                        id="result-unit"
                        data-testid="result-unit"
                        autoComplete="off"
                        value={unit}
                        onChange={(event) => {
                          setUnit(event.target.value);
                        }}
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="result-comment">Comment</Label>
                    <Textarea
                      id="result-comment"
                      data-testid="result-comment"
                      rows={2}
                      value={comment}
                      onChange={(event) => {
                        setComment(event.target.value);
                      }}
                    />
                  </div>
                  <Button
                    data-testid="save-result"
                    className="self-start"
                    disabled={value.trim() === '' || save.isPending}
                    onClick={() => {
                      save.mutate();
                    }}
                  >
                    {save.isPending ? 'Saving…' : 'Save result'}
                  </Button>
                  {save.error === null ? null : <ProblemCard error={save.error} />}
                </div>
              ) : null}

              <AsyncPanel
                loading={focusedResults.isPending}
                error={focusedResults.error}
                isEmpty={rowResults.length === 0}
                skeletonLabel="Loading the results for this line"
                skeletonRows={3}
                onRetry={() => {
                  void focusedResults.refetch();
                }}
                empty={
                  <EmptyState
                    cause="No result has been entered against this test line yet."
                    nextAction={
                      stage === 'pending'
                        ? 'Enter the value above. It will appear here with the laboratory’s own flag on it.'
                        : 'Switch to “Work to do” and enter the result first.'
                    }
                  />
                }
              >
                <ul className="flex flex-col gap-3" data-testid="row-results">
                  {rowResults.map((result) => (
                    <li key={result.id} className="flex flex-col gap-1">
                      <span className="text-sm font-medium text-fg-default">{result.analyte_name}</span>
                      <ResultFlagCell result={result} announce />
                      <span className="font-mono text-2xs text-fg-subtle">
                        v{result.current_version} · {humanise(result.current_status)} ·{' '}
                        {formatInstant(result.recorded_at)}
                        {result.qc_state_at_release === ''
                          ? ''
                          : ` · QC ${humanise(result.qc_state_at_release)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </AsyncPanel>

              {criticalBlocked ? (
                <p
                  role="status"
                  data-testid="critical-block"
                  className="rounded-md border border-danger-border bg-danger-surface p-3 text-sm text-danger-on-surface"
                >
                  {criticalVerdict.message}
                </p>
              ) : null}

              <div className="flex flex-wrap gap-2 border-t border-default pt-3">
                <Button
                  variant="secondary"
                  data-testid="verify-button"
                  disabled={!canVerify || unreleasedIds.length === 0 || releaseBlocked || verify.isPending}
                  onClick={() => {
                    verify.mutate(unreleasedIds);
                  }}
                >
                  Verify (technical)
                </Button>
                <Button
                  data-testid="authorise-button"
                  disabled={
                    !canAuthorise ||
                    verifiedIds.length === 0 ||
                    releaseBlocked ||
                    criticalBlocked ||
                    authorise.isPending
                  }
                  onClick={() => {
                    authorise.mutate(verifiedIds);
                  }}
                >
                  Authorise (medical)
                </Button>
              </div>
              {verify.error === null ? null : <ProblemCard error={verify.error} />}
              {authorise.error === null ? null : <ProblemCard error={authorise.error} />}
            </>
          )}
        </section>
      </div>

      <ShortcutBar shortcuts={shortcuts} label="Bench shortcuts" />
    </section>
  );
}
