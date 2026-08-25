'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Checkbox, EmptyState, Input, Label, Textarea, useToast } from '@vims/ui';
import { useMemo, useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { ShortcutBar } from '@/features/frontoffice/components/keyboard-sheet';
import { useShortcuts, type Shortcut } from '@/features/frontoffice/lib/shortcuts';
import { Check, OctagonAlert } from '@/lib/icons';
import { useSession } from '@/lib/session-context';
import { getQcState, listLabTests, recordQcAction, recordQcRun, unlockQc } from '../api/client';
import { diagnosticsKeys } from '../api/keys';
import { QC_LEVELS, type LabQcRunView, type QcLevel } from '../api/types';
import { formatInstant, humanise } from '../lib/format';
import { QC_ACTION_CODES, QC_CAUSE_CODES, blocksRelease, describeRule, releaseVerdict } from '../lib/qc-gate';
import { LeveyJenningsChart } from './levey-jennings-chart';

/**
 * EN-031 §3.3 and §8 — the QC bench board.
 *
 * ## What the red banner is for
 *
 * EN-031 §8 bullet 1 asks for it literally: "a red banner listing analytes
 * currently blocking release, with the count of held patient results". A
 * technologist who cannot see *which* analyte is holding *what* will re-run
 * controls at random, and the mandated empty-state wording — "QC not run for
 * Sodium on ARCHITECT-1 this shift — patient results will be held after 08:30" —
 * exists for the same reason: "no data" tells nobody what is about to happen.
 *
 * ## `1-2s` is a warning and never a rejection
 *
 * EN-031 §3.3.2 and AC 3. A control beyond two standard deviations happens
 * roughly one run in twenty by chance; a laboratory that stops for it stops
 * constantly, and a laboratory that stops constantly stops looking.
 * `blocksRelease` refuses to treat it as a stopper, and the chart marks it as a
 * warning shape rather than a rejection shape.
 *
 * ## The one lawful way past a lockout
 *
 * There is deliberately **no "release anyway" button**. Release is
 * `POST /lab/results/verify` and `/authorise` on the bench screen, gated by the
 * database. What lives here is the *evidence* that changes the gate's answer: a
 * corrective action, a passing control, a lockout lifted against that run. The
 * single exception — `patient_impact = released_with_authorisation` — asserts
 * `labq.qc.release_override`, needs a written authorisation rather than a click,
 * and goes into the monthly management report. It is not a retry and it is not
 * shaped like one.
 */
export function LabQcScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = diagnosticsKeys(hospitalId);
  const queryClient = useQueryClient();
  const { publish } = useToast();

  const canEnter = granted.has('labq.qc.enter');
  const canAct = granted.has('labq.qc.action');
  const canOverride = granted.has('labq.qc.release_override');
  const canUnlock = granted.has('lab.qc.unlock');
  const canReadCatalogue = granted.has('mdm.read');

  const [instrumentId, setInstrumentId] = useState('');
  const [testKey, setTestKey] = useState('');
  const [qcMaterialId, setQcMaterialId] = useState('');
  const [level, setLevel] = useState<QcLevel>('l1');
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState('');
  const [recorded, setRecorded] = useState<readonly LabQcRunView[]>([]);

  const [causeCode, setCauseCode] = useState(QC_CAUSE_CODES[0]?.code ?? 'random_error');
  const [actionCode, setActionCode] = useState(QC_ACTION_CODES[0]?.code ?? 'repeat_qc');
  const [releaseUnderAuthorisation, setReleaseUnderAuthorisation] = useState(false);
  const [authorisationReason, setAuthorisationReason] = useState('');
  const [affectedCount, setAffectedCount] = useState('0');

  const state = useQuery({
    queryKey: keys.qcStateRoot(),
    queryFn: ({ signal }) => getQcState({}, { signal }),
    refetchInterval: 120_000,
  });

  const catalogue = useQuery({
    queryKey: keys.testCatalogue('', 'all'),
    queryFn: ({ signal }) => listLabTests({}, { signal }),
    enabled: canReadCatalogue,
    staleTime: 10 * 60_000,
  });

  const testNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const test of catalogue.data?.items ?? []) map.set(test.record_key, test.name);
    return map;
  }, [catalogue.data]);

  function nameOf(key: string): string {
    return testNames.get(key) ?? `analyte ${key.slice(-6)}`;
  }

  const blocked = (state.data?.items ?? []).filter((one) => !one.permits_release);
  const heldVerdict = releaseVerdict(blocked[0], state.isError);

  const runMutation = useMutation({
    mutationFn: () =>
      recordQcRun({
        instrumentId: instrumentId.trim(),
        testKey: testKey.trim(),
        qcMaterialId: qcMaterialId.trim(),
        level,
        value: Number.parseFloat(value),
        ...(unit.trim() === '' ? {} : { unit: unit.trim() }),
      }),
    onSuccess: (run) => {
      setRecorded((current) => [...current, run]);
      setValue('');
      void queryClient.invalidateQueries({ queryKey: keys.qcStateRoot() });
      publish({
        title: blocksRelease(run) ? 'Run rejected' : 'QC run recorded',
        description: blocksRelease(run)
          ? `${run.violated_rules.map((rule) => describeRule(rule)).join('; ')}. Patient results for this analyte are held until control is re-established.`
          : run.violated_rules.length > 0
            ? 'Beyond 2 SD — a warning, not a rejection. Inspect the trend; do not stop the run.'
            : 'In control.',
        severity: blocksRelease(run) ? 'danger' : 'success',
      });
    },
  });

  const actionMutation = useMutation({
    mutationFn: () =>
      recordQcAction({
        instrumentId: instrumentId.trim(),
        testKey: testKey.trim(),
        causeCode,
        actionCode,
        patientImpact: releaseUnderAuthorisation ? 'released_with_authorisation' : 'retest_all',
        affectedResultCount: Number.parseInt(affectedCount, 10) || 0,
        ...(releaseUnderAuthorisation ? { authorisationReason: authorisationReason.trim() } : {}),
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: keys.qcStateRoot() });
      publish({
        title: 'Corrective action recorded',
        description: releaseUnderAuthorisation
          ? `Action ${result.actionId} authorises release under an out-of-control QC. It appears in this month's management report.`
          : `Action ${result.actionId} recorded. Re-run the control to lift the hold.`,
        severity: releaseUnderAuthorisation ? 'warning' : 'success',
      });
    },
  });

  const unlockMutation = useMutation({
    mutationFn: (input: {
      readonly lockoutId: string;
      readonly runId: string;
      readonly actionId: string;
      readonly reason: string;
    }) =>
      unlockQc(input.lockoutId, {
        reason: input.reason,
        unlockQcRunId: input.runId,
        correctiveActionId: input.actionId,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.qcStateRoot() });
      publish({ title: 'Lockout lifted', severity: 'success' });
    },
  });

  const overrideIncomplete = releaseUnderAuthorisation && authorisationReason.trim().length < 8;

  const shortcuts: readonly Shortcut[] = useMemo(
    () => [
      {
        key: 'n',
        label: 'Focus the QC value field',
        keys: ['N'],
        run: () => {
          document.querySelector<HTMLInputElement>('[data-testid="qc-value"]')?.focus();
        },
      },
      {
        key: 'a',
        label: 'Focus the corrective action',
        keys: ['A'],
        enabled: canAct,
        run: () => {
          document.querySelector<HTMLSelectElement>('[data-testid="qc-cause"]')?.focus();
        },
      },
    ],
    [canAct],
  );
  useShortcuts(shortcuts);

  return (
    <section className="flex flex-col gap-4" data-testid="lab-qc-screen">
      <PageHeader
        eyebrow="EN-031 · quality control"
        title="Quality control"
        description="Which analytes are holding patient results, the control runs behind that verdict, and the corrective action that clears it. There is no button here that releases a held result."
      />

      <AsyncPanel
        loading={state.isPending}
        error={state.error}
        isEmpty={(state.data?.items.length ?? 0) === 0}
        skeletonLabel="Loading the QC state"
        onRetry={() => {
          void state.refetch();
        }}
        empty={
          <EmptyState
            cause="No analyte on any instrument has a quality-control state yet."
            nextAction="Record a control run below. Until an analyte has been evaluated it is not releasable, which is the fail-closed default rather than an error."
          />
        }
      >
        {heldVerdict.kind === 'blocked' ? (
          <div
            role="alert"
            data-testid="qc-hold-banner"
            className="rounded-lg border border-danger-border bg-danger-surface p-3 text-sm text-danger-on-surface"
          >
            <p className="flex items-center gap-2 font-medium">
              <OctagonAlert className="size-4 shrink-0" aria-hidden="true" />
              {blocked.length} analyte{blocked.length === 1 ? '' : 's'} currently holding patient results
            </p>
            <p className="mt-1">{heldVerdict.message}</p>
            <ul className="mt-2 flex flex-col gap-1" data-testid="held-analytes">
              {blocked.map((one) => (
                <li key={one.id} className="font-mono text-2xs">
                  {nameOf(one.test_key)} on instrument {one.instrument_id.slice(-6)} — {humanise(one.state)}
                  {one.reason === null ? '' : ` · ${one.reason}`}
                  {one.next_due_at === null ? '' : ` · next due ${formatInstant(one.next_due_at)}`}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div
            data-testid="qc-clear-banner"
            className="rounded-lg border border-success-border bg-success-surface p-3 text-sm text-success-on-surface"
          >
            <p className="flex items-center gap-2 font-medium">
              <Check className="size-4 shrink-0" aria-hidden="true" />
              No analyte is holding patient results.
            </p>
          </div>
        )}

        <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="qc-state-list">
          {(state.data?.items ?? []).map((one) => (
            <li key={one.id} className="flex flex-col gap-1 rounded-lg border border-strong bg-layer-1 p-3">
              <span className="text-sm font-medium text-fg-default">{nameOf(one.test_key)}</span>
              <span className="font-mono text-2xs text-fg-muted">
                instrument {one.instrument_id.slice(-6)}
              </span>
              <Badge
                tone={one.permits_release ? 'success' : 'danger'}
                icon={
                  one.permits_release ? <Check aria-hidden="true" /> : <OctagonAlert aria-hidden="true" />
                }
              >
                {humanise(one.state)}
              </Badge>
              <span className="text-2xs text-fg-subtle">
                Last evaluated {formatInstant(one.last_evaluated_at)}
              </span>
              {one.active_lockout_id === null || !canUnlock ? null : (
                <UnlockPanel
                  lockoutId={one.active_lockout_id}
                  pending={unlockMutation.isPending}
                  onUnlock={(input) => {
                    unlockMutation.mutate({ lockoutId: one.active_lockout_id ?? '', ...input });
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      </AsyncPanel>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
          <h2 className="text-md font-medium text-fg-default">Record a control run</h2>
          {!canEnter ? (
            <EmptyState
              cause="Your roles do not include entering a control run."
              nextAction="Entering QC is held by bench technologists. You can still read the state above."
            />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  id="qc-instrument"
                  label="Instrument id"
                  value={instrumentId}
                  onChange={setInstrumentId}
                />
                <Field id="qc-test" label="Test key" value={testKey} onChange={setTestKey} />
                <Field
                  id="qc-material"
                  label="Control material id"
                  value={qcMaterialId}
                  onChange={setQcMaterialId}
                />
                <div className="flex flex-col gap-1">
                  <Label htmlFor="qc-level">Level</Label>
                  <select
                    id="qc-level"
                    data-testid="qc-level"
                    className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    value={level}
                    onChange={(event) => {
                      setLevel(event.target.value as QcLevel);
                    }}
                  >
                    {QC_LEVELS.map((one) => (
                      <option key={one} value={one}>
                        {one.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="qc-value">Measured value</Label>
                  <Input
                    id="qc-value"
                    data-testid="qc-value"
                    inputMode="decimal"
                    className="font-mono tabular-nums"
                    value={value}
                    onChange={(event) => {
                      setValue(event.target.value);
                    }}
                  />
                </div>
                <Field id="qc-unit" label="Unit" value={unit} onChange={setUnit} />
              </div>
              <Button
                data-testid="record-qc-run"
                className="self-start"
                disabled={
                  runMutation.isPending ||
                  instrumentId.trim() === '' ||
                  testKey.trim() === '' ||
                  qcMaterialId.trim() === '' ||
                  !Number.isFinite(Number.parseFloat(value))
                }
                onClick={() => {
                  runMutation.mutate();
                }}
              >
                {runMutation.isPending ? 'Recording…' : 'Record the run'}
              </Button>
              {runMutation.error === null ? null : <ProblemCard error={runMutation.error} />}
            </>
          )}
        </section>

        <section className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
          <h2 className="text-md font-medium text-fg-default">Levey-Jennings</h2>
          <LeveyJenningsChart
            runs={recorded}
            analyteLabel={testKey.trim() === '' ? 'the selected analyte' : nameOf(testKey.trim())}
          />
        </section>
      </div>

      <section className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
        <h2 className="text-md font-medium text-fg-default">Corrective action</h2>
        {!canAct ? (
          <EmptyState
            cause="Your roles do not include recording a corrective action."
            nextAction="Recording the root cause is held by bench technologists and the quality officer."
          />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="qc-cause">What caused it?</Label>
                <select
                  id="qc-cause"
                  data-testid="qc-cause"
                  className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                  value={causeCode}
                  onChange={(event) => {
                    setCauseCode(event.target.value);
                  }}
                >
                  {QC_CAUSE_CODES.map((one) => (
                    <option key={one.code} value={one.code}>
                      {one.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="qc-action">What did you do?</Label>
                <select
                  id="qc-action"
                  data-testid="qc-action"
                  className="h-9 rounded-md border border-control bg-layer-1 px-2 text-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                  value={actionCode}
                  onChange={(event) => {
                    setActionCode(event.target.value);
                  }}
                >
                  {QC_ACTION_CODES.map((one) => (
                    <option key={one.code} value={one.code}>
                      {one.label}
                    </option>
                  ))}
                </select>
              </div>
              <Field
                id="qc-affected"
                label="Patient results affected"
                value={affectedCount}
                onChange={setAffectedCount}
              />
            </div>

            {canOverride ? (
              <div className="flex flex-col gap-2 rounded-md border border-warning-border bg-warning-surface p-3">
                <div className="flex items-start gap-2">
                  <Checkbox
                    id="release-authorised"
                    data-testid="release-authorised"
                    checked={releaseUnderAuthorisation}
                    onCheckedChange={(checked) => {
                      setReleaseUnderAuthorisation(checked === true);
                    }}
                  />
                  <Label htmlFor="release-authorised" className="font-normal text-warning-on-surface">
                    Authorise release of the affected patient results under this out-of-control QC
                    <span className="block text-2xs">
                      EN-031 §5’s single exception. It needs a written authorisation, not a click, and it is
                      reported to management every month.
                    </span>
                  </Label>
                </div>
                {releaseUnderAuthorisation ? (
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="authorisation-reason">Written authorisation</Label>
                    <Textarea
                      id="authorisation-reason"
                      data-testid="authorisation-reason"
                      rows={3}
                      value={authorisationReason}
                      onChange={(event) => {
                        setAuthorisationReason(event.target.value);
                      }}
                    />
                    {overrideIncomplete ? (
                      <p className="text-sm text-warning-fg" data-testid="override-incomplete">
                        Write at least eight characters somebody reading the monthly report can act on.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            <Button
              data-testid="record-qc-action"
              className="self-start"
              disabled={
                actionMutation.isPending ||
                instrumentId.trim() === '' ||
                testKey.trim() === '' ||
                overrideIncomplete
              }
              onClick={() => {
                actionMutation.mutate();
              }}
            >
              {actionMutation.isPending ? 'Recording…' : 'Record the corrective action'}
            </Button>
            {actionMutation.error === null ? null : <ProblemCard error={actionMutation.error} />}
          </>
        )}
      </section>

      {unlockMutation.error === null ? null : <ProblemCard error={unlockMutation.error} />}

      <ShortcutBar shortcuts={shortcuts} label="QC shortcuts" />
    </section>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        data-testid={id}
        autoComplete="off"
        className="font-mono text-xs"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </div>
  );
}

/**
 * A lockout is not cleared by opinion.
 *
 * `POST /lab/qc/lockouts/{id}/unlock` needs the **passing run** that
 * re-established control and the corrective action that explains it, plus a
 * reason. All three are required by the API, and asking for them here rather
 * than discovering them as a 400 is the difference between a form and a
 * guessing game.
 */
function UnlockPanel({
  lockoutId,
  pending,
  onUnlock,
}: {
  readonly lockoutId: string;
  readonly pending: boolean;
  readonly onUnlock: (input: {
    readonly runId: string;
    readonly actionId: string;
    readonly reason: string;
  }) => void;
}): React.JSX.Element {
  const [runId, setRunId] = useState('');
  const [actionId, setActionId] = useState('');
  const [reason, setReason] = useState('');
  const ready = runId.trim() !== '' && actionId.trim() !== '' && reason.trim().length >= 8;

  return (
    <details className="mt-1 rounded-md border border-default p-2">
      <summary className="cursor-pointer text-2xs text-fg-default">Lift this lockout</summary>
      <div className="mt-2 flex flex-col gap-2">
        <Field id={`unlock-run-${lockoutId}`} label="Passing QC run id" value={runId} onChange={setRunId} />
        <Field
          id={`unlock-action-${lockoutId}`}
          label="Corrective action id"
          value={actionId}
          onChange={setActionId}
        />
        <div className="flex flex-col gap-1">
          <Label htmlFor={`unlock-reason-${lockoutId}`}>Reason</Label>
          <Textarea
            id={`unlock-reason-${lockoutId}`}
            data-testid={`unlock-reason-${lockoutId}`}
            rows={2}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        </div>
        <Button
          size="sm"
          data-testid={`unlock-${lockoutId}`}
          disabled={!ready || pending}
          onClick={() => {
            onUnlock({ runId: runId.trim(), actionId: actionId.trim(), reason: reason.trim() });
          }}
        >
          Lift the lockout
        </Button>
      </div>
    </details>
  );
}
