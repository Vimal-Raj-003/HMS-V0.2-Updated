'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { ESI_TARGET_MINUTES, scoreEsi, scoreGcs } from '@vims/contracts';
import { Badge, Button, EmptyState, Input, Label, useToast } from '@vims/ui';
import { useMemo, useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { getBoard } from '../api/client';
import { erKeys } from '../api/keys';
import { activate, getTriageHistory, triage, type TriageBody } from '../api/trauma-client';
import type { TriageRecordView, TriageResultView } from '../api/trauma-types';
import type { ErVisitView } from '../api/types';

/**
 * The ESI palette, and why the numeral is always beside it.
 *
 * Roughly one man in twelve has a colour vision deficiency. A red/green board in
 * a resus bay misleads exactly the people who are moving fastest, so every badge
 * on this screen carries the number and the word as well as the tone —
 * `phase-06` §6.2.
 */
const ESI_TONE: Readonly<Record<number, 'danger' | 'warning' | 'neutral' | 'success'>> = {
  1: 'danger',
  2: 'danger',
  3: 'warning',
  4: 'neutral',
  5: 'success',
};
const ESI_LABEL: Readonly<Record<number, string>> = {
  1: 'Resuscitation',
  2: 'Emergent',
  3: 'Urgent',
  4: 'Less urgent',
  5: 'Non-urgent',
};

const START_TONE: Readonly<Record<string, 'danger' | 'warning' | 'success' | 'neutral'>> = {
  red: 'danger',
  yellow: 'warning',
  green: 'success',
  black: 'neutral',
};
const START_LABEL: Readonly<Record<string, string>> = {
  red: 'Immediate',
  yellow: 'Delayed',
  green: 'Minor',
  black: 'Expectant',
};

const GCS_EYE = [
  { score: 4, label: 'Spontaneous' },
  { score: 3, label: 'To speech' },
  { score: 2, label: 'To pressure' },
  { score: 1, label: 'None' },
] as const;
const GCS_VERBAL = [
  { score: 5, label: 'Orientated' },
  { score: 4, label: 'Confused' },
  { score: 3, label: 'Words' },
  { score: 2, label: 'Sounds' },
  { score: 1, label: 'None' },
] as const;
const GCS_MOTOR = [
  { score: 6, label: 'Obeys commands' },
  { score: 5, label: 'Localises' },
  { score: 4, label: 'Withdraws' },
  { score: 3, label: 'Abnormal flexion' },
  { score: 2, label: 'Extension' },
  { score: 1, label: 'None' },
] as const;

const selectClass = 'h-10 rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

function num(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Adds a key only when it has a value — `exactOptionalPropertyTypes` is on. */
function when<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function triageBadge(record: {
  readonly esiLevel: number | null;
  readonly tag: string | null;
}): React.JSX.Element {
  if (record.esiLevel !== null) {
    return (
      <Badge tone={ESI_TONE[record.esiLevel] ?? 'neutral'}>
        {`ESI ${String(record.esiLevel)} · ${ESI_LABEL[record.esiLevel] ?? ''}`}
      </Badge>
    );
  }
  if (record.tag !== null) {
    return (
      <Badge tone={START_TONE[record.tag] ?? 'neutral'}>
        {`${START_LABEL[record.tag] ?? record.tag} (${record.tag})`}
      </Badge>
    );
  }
  return <Badge tone="warning">not triaged</Badge>;
}

/**
 * TR-001 — the triage desk.
 *
 * ── The level appears before you finish typing ──────────────────────────────
 *
 * The same `scoreEsi` and `scoreGcs` the server runs are imported here from
 * `@vims/contracts`, so the level updates as the observations go in. That is a
 * rendering convenience, not a shortcut: nothing computed is sent, and the badge
 * is replaced by the server's answer as soon as it returns. If the two ever
 * disagreed, the record would hold the server's, and this screen would show it.
 *
 * ── Overriding is one field, not a workflow ─────────────────────────────────
 *
 * The nurse standing in front of the patient is usually right when they disagree
 * with the algorithm. Making them find a supervisor produces the level nobody
 * corrected, so the override is a level and a sentence, on this screen, now. The
 * sentence is required — that is the whole of the ceremony.
 *
 * ── Re-triage is the same button ────────────────────────────────────────────
 *
 * There is no "edit triage". Triaging a patient who already has one writes a
 * second record and the history below shows both. The first record is the only
 * evidence of whether the wait that followed was reasonable.
 */
export function TriageDeskScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = erKeys(hospitalId);
  const { publish } = useToast();

  const [selected, setSelected] = useState<ErVisitView | null>(null);
  const [system, setSystem] = useState<'esi' | 'start'>('esi');
  const [tag, setTag] = useState<'red' | 'yellow' | 'green' | 'black'>('red');

  const [lifeSaving, setLifeSaving] = useState(false);
  const [highRisk, setHighRisk] = useState(false);
  const [resources, setResources] = useState('2');
  const [age, setAge] = useState('');
  const [hr, setHr] = useState('');
  const [rr, setRr] = useState('');
  const [sbp, setSbp] = useState('');
  const [dbp, setDbp] = useState('');
  const [spo2, setSpo2] = useState('');
  const [pain, setPain] = useState('');
  const [eye, setEye] = useState('');
  const [verbal, setVerbal] = useState('');
  const [motor, setMotor] = useState('');
  const [intubated, setIntubated] = useState(false);
  const [complaint, setComplaint] = useState('');
  const [overrideLevel, setOverrideLevel] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [result, setResult] = useState<TriageResultView | null>(null);

  const canTriage = granted.has('triage.record.create');
  const canOverride = granted.has('triage.level.override');
  const canActivate = granted.has('trauma.activation.create');

  const board = useQuery({
    queryKey: keys.board('triage-desk'),
    queryFn: ({ signal }) => getBoard({}, { signal }),
    refetchInterval: 15_000,
  });
  const visits: readonly ErVisitView[] = board.data?.visits ?? [];

  const history = useQuery({
    queryKey: keys.triageHistory(selected?.id ?? 'none'),
    queryFn: ({ signal }) => getTriageHistory(selected?.id ?? '', { signal }),
    enabled: selected !== null,
  });
  const records: readonly TriageRecordView[] = history.data?.items ?? [];

  // ── The live preview ───────────────────────────────────────────────────────
  const gcs = useMemo(() => {
    const e = num(eye);
    const m = num(motor);
    if (e === undefined || m === undefined) return null;
    try {
      return scoreGcs({
        eye: e,
        motor: m,
        verbal: intubated ? undefined : num(verbal),
        intubated,
        ageYears: num(age),
      });
    } catch {
      // A half-filled GCS is the normal state of this form. Showing nothing is
      // correct; showing an error while somebody types is noise.
      return null;
    }
  }, [eye, motor, verbal, intubated, age]);

  const preview = useMemo(() => {
    if (system !== 'esi') return null;
    const ageYears = num(age);
    if (ageYears === undefined) return null;
    return scoreEsi({
      needsLifeSavingIntervention: lifeSaving,
      highRisk,
      resourceCount: num(resources) ?? 0,
      ageYears,
      vitals: { heartRate: num(hr), respiratoryRate: num(rr), spo2: num(spo2) },
      painScore: num(pain),
    });
  }, [system, age, lifeSaving, highRisk, resources, hr, rr, spo2, pain]);

  const submit = useMutation({
    mutationFn: () => {
      if (selected === null) throw new Error('Choose a patient first.');
      const ageYears = num(age);
      if (ageYears === undefined) {
        throw new Error('An age is needed — the danger-zone vitals are banded by age.');
      }
      const overriding = overrideLevel.trim() !== '' && overrideReason.trim() !== '';
      const body: TriageBody = {
        system,
        ageYears,
        gcsIntubated: intubated,
        ...(system === 'esi'
          ? {
              needsLifeSavingIntervention: lifeSaving,
              highRisk,
              resourceCount: num(resources) ?? 0,
            }
          : { tag }),
        ...when('heartRate', num(hr)),
        ...when('respiratoryRate', num(rr)),
        ...when('systolicBp', num(sbp)),
        ...when('diastolicBp', num(dbp)),
        ...when('spo2', num(spo2)),
        ...when('painScore', num(pain)),
        ...when('gcsEye', num(eye)),
        ...(intubated ? {} : when('gcsVerbal', num(verbal))),
        ...when('gcsMotor', num(motor)),
        ...when('chiefComplaint', complaint.trim() === '' ? undefined : complaint.trim()),
        ...(overriding
          ? { assignedLevel: Number(overrideLevel), overrideReason: overrideReason.trim() }
          : {}),
      };
      return triage(selected.id, body);
    },
    onSuccess: (triaged) => {
      setResult(triaged);
      void board.refetch();
      void history.refetch();
      setOverrideLevel('');
      setOverrideReason('');
      const level = triaged.record.esiLevel;
      publish({
        title:
          level === null
            ? `Tagged ${String(triaged.record.tag ?? '')}`
            : `ESI ${String(level)} — ${ESI_LABEL[level] ?? ''}`,
        ...(triaged.deterioratedFrom === null
          ? {}
          : {
              description: `Deteriorated from ESI ${String(
                triaged.deterioratedFrom,
              )}. The earlier record is unchanged.`,
            }),
        severity: triaged.deterioratedFrom === null ? 'success' : 'warning',
      });
    },
  });

  const callTeam = useMutation({
    mutationFn: (tier: 'level_1' | 'level_2') => {
      if (selected === null) throw new Error('Choose a patient first.');
      const criteria = result?.suggestedActivation?.criteria ?? [];
      return activate({
        erVisitId: selected.id,
        tier,
        ...(result === null ? {} : { triageRecordId: result.record.id }),
        criteriaFired: criteria,
        clinicalJudgement: criteria.length === 0,
      });
    },
    onSuccess: (activation) => {
      publish({
        title: `${activation.tier === 'level_1' ? 'Level 1' : 'Level 2'} trauma team called`,
        description: `${String(activation.pagedCount)} roles paged. A level-1 page cannot be silenced.`,
        severity: 'success',
      });
    },
  });

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Triage"
        description="ESI four-decision-point triage, or START under a declared incident. Re-triage never overwrites — it writes a second record, and the first one stays."
      />

      <div className="grid gap-5 lg:grid-cols-[20rem_1fr]">
        {/* ── Who is here ────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">In the department</h2>
          <AsyncPanel
            loading={board.isPending}
            error={board.error}
            isEmpty={visits.length === 0}
            skeletonLabel="Loading the department"
            skeletonRows={6}
            onRetry={() => {
              void board.refetch();
            }}
            empty={
              <EmptyState
                cause="Nobody is in the department."
                nextAction="Arrivals appear here the moment they are registered at the door."
              />
            }
          >
            <ul className="flex flex-col gap-1" data-testid="triage-queue">
              {visits.map((visit) => (
                <li key={visit.id}>
                  <button
                    type="button"
                    data-testid={`triage-pick-${visit.erNo}`}
                    aria-pressed={selected?.id === visit.id}
                    className={`min-h-12 w-full rounded-lg border px-3 py-2 text-start text-sm ${
                      selected?.id === visit.id
                        ? 'border-accent-border bg-layer-2 text-fg-default'
                        : 'border-default text-fg-muted hover:text-fg-default'
                    }`}
                    onClick={() => {
                      setSelected(visit);
                      setResult(null);
                      setAge(visit.approximateAge === null ? '' : String(visit.approximateAge));
                      setComplaint(visit.chiefComplaint ?? '');
                    }}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-fg-default">
                        {visit.displayName ?? visit.tempIdentity ?? visit.erNo}
                      </span>
                      {triageBadge({ esiLevel: visit.esiLevel, tag: visit.triageTag })}
                    </span>
                    <span className="mt-1 block truncate text-2xs text-fg-subtle">
                      <span className="font-mono">{visit.erNo}</span> · waiting {visit.erLosMinutes ?? 0} min
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </AsyncPanel>
        </div>

        {/* ── The form ───────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-4">
          {selected === null ? (
            <EmptyState
              cause="No patient is selected."
              nextAction="Choose somebody from the list to triage or re-triage them."
            />
          ) : (
            <>
              <div className="rounded-lg border border-strong bg-layer-1 p-4">
                <p className="text-base font-medium">
                  {selected.displayName ?? selected.tempIdentity ?? selected.erNo}
                </p>
                <p className="text-2xs text-fg-muted">
                  <span className="font-mono">{selected.erNo}</span> · arrived by{' '}
                  {selected.arrivalMode.replace('_', ' ')}
                  {selected.mlcSuspected ? ' · MLC suspected' : ''}
                </p>
              </div>

              <fieldset className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
                <legend className="text-sm font-medium">Ladder</legend>
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      { value: 'esi', label: 'ESI (everyday)' },
                      { value: 'start', label: 'START (mass casualty)' },
                    ] as const
                  ).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={system === option.value}
                      className={`min-h-12 rounded-lg border px-4 text-sm ${
                        system === option.value
                          ? 'border-accent-border bg-layer-2 text-fg-default'
                          : 'border-default text-fg-muted hover:text-fg-default'
                      }`}
                      onClick={() => {
                        setSystem(option.value);
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {system === 'start' ? (
                  <div className="flex flex-wrap gap-2">
                    {(['red', 'yellow', 'green', 'black'] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={tag === value}
                        className={`min-h-12 rounded-lg border px-4 text-sm ${
                          tag === value
                            ? 'border-accent-border bg-layer-2 text-fg-default'
                            : 'border-default text-fg-muted hover:text-fg-default'
                        }`}
                        onClick={() => {
                          setTag(value);
                        }}
                      >
                        {`${START_LABEL[value] ?? value} (${value})`}
                      </button>
                    ))}
                  </div>
                ) : null}
              </fieldset>

              {system === 'esi' ? (
                <fieldset className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
                  <legend className="text-sm font-medium">Decision points</legend>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 size-5"
                      data-testid="esi-a"
                      checked={lifeSaving}
                      onChange={(event) => {
                        setLifeSaving(event.target.checked);
                      }}
                    />
                    <span>
                      <strong>A.</strong> Needs an immediate life-saving intervention — intubated, apnoeic,
                      pulseless, unresponsive, SpO₂ under 90.
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 size-5"
                      data-testid="esi-b"
                      checked={highRisk}
                      onChange={(event) => {
                        setHighRisk(event.target.checked);
                      }}
                    />
                    <span>
                      <strong>B.</strong> High risk, new confusion or lethargy, or severe pain. &ldquo;Would I
                      give this patient my last open bed?&rdquo;
                    </span>
                  </label>
                  <div className="flex max-w-56 flex-col gap-1">
                    <Label htmlFor="resources">C. Distinct resources anticipated</Label>
                    <Input
                      id="resources"
                      inputMode="numeric"
                      autoComplete="off"
                      value={resources}
                      onChange={(event) => {
                        setResources(event.target.value);
                      }}
                    />
                    <p className="text-2xs text-fg-subtle">
                      Labs, imaging, IV fluids, a consult, a procedure. Not history, examination, a
                      point-of-care test or a dressing.
                    </p>
                  </div>
                </fieldset>
              ) : null}

              <fieldset className="flex flex-wrap gap-3 rounded-lg border border-strong bg-layer-1 p-4">
                <legend className="text-sm font-medium">Observations</legend>
                {(
                  [
                    { id: 'age', label: 'Age (years)', value: age, set: setAge },
                    { id: 'hr', label: 'Heart rate', value: hr, set: setHr },
                    { id: 'rr', label: 'Resp. rate', value: rr, set: setRr },
                    { id: 'sbp', label: 'Systolic BP', value: sbp, set: setSbp },
                    { id: 'dbp', label: 'Diastolic BP', value: dbp, set: setDbp },
                    { id: 'spo2', label: 'SpO₂ (%)', value: spo2, set: setSpo2 },
                    { id: 'pain', label: 'Pain (0–10)', value: pain, set: setPain },
                  ] as const
                ).map((field) => (
                  <div key={field.id} className="flex w-32 flex-col gap-1">
                    <Label htmlFor={field.id}>{field.label}</Label>
                    <Input
                      id={field.id}
                      data-testid={`obs-${field.id}`}
                      inputMode="numeric"
                      autoComplete="off"
                      value={field.value}
                      onChange={(event) => {
                        field.set(event.target.value);
                      }}
                    />
                  </div>
                ))}
              </fieldset>

              <fieldset className="flex flex-col gap-3 rounded-lg border border-strong bg-layer-1 p-4">
                <legend className="text-sm font-medium">
                  {gcs === null
                    ? 'Glasgow Coma Scale'
                    : `Glasgow Coma Scale — ${gcs.display} (${gcs.severity.replace('_', ' ')})`}
                </legend>
                <div className="flex flex-wrap gap-3">
                  {(
                    [
                      {
                        id: 'eye',
                        label: 'Eye opening',
                        options: GCS_EYE,
                        value: eye,
                        set: setEye,
                        off: false,
                      },
                      {
                        id: 'verbal',
                        label: 'Verbal response',
                        options: GCS_VERBAL,
                        value: verbal,
                        set: setVerbal,
                        off: intubated,
                      },
                      {
                        id: 'motor',
                        label: 'Motor response',
                        options: GCS_MOTOR,
                        value: motor,
                        set: setMotor,
                        off: false,
                      },
                    ] as const
                  ).map((group) => (
                    <div key={group.id} className="flex min-w-52 flex-col gap-1">
                      <Label htmlFor={group.id}>{group.label}</Label>
                      <select
                        id={group.id}
                        className={selectClass}
                        value={group.value}
                        disabled={group.off}
                        onChange={(event) => {
                          group.set(event.target.value);
                        }}
                      >
                        <option value="">—</option>
                        {group.options.map((option) => (
                          <option key={option.score} value={String(option.score)}>
                            {`${String(option.score)} · ${option.label}`}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 size-5"
                    checked={intubated}
                    onChange={(event) => {
                      setIntubated(event.target.checked);
                    }}
                  />
                  <span>
                    Intubated — the total is reported as <code>nT</code>. A verbal score cannot be observed
                    through a tube, and inventing one inflates the GCS.
                  </span>
                </label>
              </fieldset>

              <div className="flex min-w-72 flex-col gap-1">
                <Label htmlFor="complaint">Presenting complaint</Label>
                <Input
                  id="complaint"
                  autoComplete="off"
                  value={complaint}
                  onChange={(event) => {
                    setComplaint(event.target.value);
                  }}
                />
              </div>

              {/* ── What the algorithm says ─────────────────────────────── */}
              {preview === null ? null : (
                <div className="rounded-lg border border-strong bg-layer-2 p-4" data-testid="esi-preview">
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge tone={ESI_TONE[preview.level] ?? 'neutral'}>
                      {`ESI ${String(preview.level)} · ${ESI_LABEL[preview.level] ?? ''}`}
                    </Badge>
                    <span className="text-2xs text-fg-muted">
                      {`decision point ${preview.decisionPoint} · seen within ${String(
                        ESI_TARGET_MINUTES[preview.level],
                      )} min`}
                    </span>
                  </p>
                  <p className="mt-2 text-sm">{preview.rationale}</p>
                  {preview.dangerZoneVitals.length === 0 ? null : (
                    <ul className="mt-2 list-disc ps-5 text-2xs text-fg-muted">
                      {preview.dangerZoneVitals.map((vital) => (
                        <li key={vital}>{vital}</li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-2 text-2xs text-fg-subtle">
                    Computed on this device so you see it immediately. What gets recorded is what the server
                    computes from the same function.
                  </p>
                </div>
              )}

              {canOverride && system === 'esi' ? (
                <fieldset className="flex flex-wrap items-end gap-3 rounded-lg border border-dashed border-strong p-4">
                  <legend className="text-sm font-medium">Disagree with it</legend>
                  <p className="w-full text-2xs text-fg-subtle">
                    You are usually right when you do. The record just has to say why — both fields, or
                    neither.
                  </p>
                  <div className="flex w-36 flex-col gap-1">
                    <Label htmlFor="override-level">Assign level</Label>
                    <select
                      id="override-level"
                      className={selectClass}
                      value={overrideLevel}
                      onChange={(event) => {
                        setOverrideLevel(event.target.value);
                      }}
                    >
                      <option value="">—</option>
                      {[1, 2, 3, 4, 5].map((level) => (
                        <option key={level} value={String(level)}>
                          {`ESI ${String(level)}`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex min-w-80 flex-1 flex-col gap-1">
                    <Label htmlFor="override-reason">Why</Label>
                    <Input
                      id="override-reason"
                      autoComplete="off"
                      placeholder="Looks unwell out of proportion to the numbers"
                      value={overrideReason}
                      onChange={(event) => {
                        setOverrideReason(event.target.value);
                      }}
                    />
                  </div>
                </fieldset>
              ) : null}

              {submit.error === null ? null : <ProblemCard error={submit.error} />}
              {callTeam.error === null ? null : <ProblemCard error={callTeam.error} />}

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  data-testid="record-triage"
                  disabled={!canTriage || submit.isPending}
                  onClick={() => {
                    submit.mutate();
                  }}
                >
                  {submit.isPending ? 'Recording…' : 'Record triage'}
                </Button>
                {canActivate ? (
                  <>
                    <Button
                      type="button"
                      variant="danger"
                      data-testid="call-level-1"
                      disabled={callTeam.isPending}
                      onClick={() => {
                        callTeam.mutate('level_1');
                      }}
                    >
                      Call level 1 trauma
                    </Button>
                    <Button
                      type="button"
                      disabled={callTeam.isPending}
                      onClick={() => {
                        callTeam.mutate('level_2');
                      }}
                    >
                      Call level 2
                    </Button>
                  </>
                ) : null}
              </div>

              {result === null || result.suggestedActivation === null ? null : (
                <div
                  className="rounded-lg border-2 border-danger-border bg-danger-subtle p-4"
                  data-testid="activation-suggestion"
                >
                  <p className="text-sm font-medium">
                    {`This triage meets ${result.suggestedActivation.tier.replace('_', ' ')} activation criteria`}
                  </p>
                  <ul className="mt-1 list-disc ps-5 text-sm">
                    {result.suggestedActivation.criteria.map((criterion) => (
                      <li key={criterion}>{criterion.replace(/_/gu, ' ')}</li>
                    ))}
                  </ul>
                  <p className="mt-2 text-2xs text-fg-muted">
                    A suggestion, never an automatic call. An activation nobody placed is an activation nobody
                    owns, and a page with no owner is the page a night shift learns to ignore.
                  </p>
                </div>
              )}

              {/* ── The history ─────────────────────────────────────────── */}
              <div className="flex flex-col gap-2">
                <h2 className="text-sm font-medium">Triage history</h2>
                <AsyncPanel
                  loading={history.isPending}
                  error={history.error}
                  isEmpty={records.length === 0}
                  skeletonLabel="Loading the triage history"
                  skeletonRows={2}
                  onRetry={() => {
                    void history.refetch();
                  }}
                  empty={
                    <EmptyState
                      cause="This patient has not been triaged."
                      nextAction="The triage you record above will be the first record, and it stays even if they are re-triaged later."
                    />
                  }
                >
                  <ol className="flex flex-col gap-2" data-testid="triage-history">
                    {records.map((record) => (
                      <li key={record.id} className="rounded-lg border border-strong bg-layer-1 p-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone="neutral">{`#${String(record.sequenceNo)}`}</Badge>
                          {triageBadge(record)}
                          {record.overridden ? <Badge tone="warning">overridden</Badge> : null}
                          <span className="text-2xs text-fg-subtle">
                            {new Date(record.triagedAt).toLocaleString()}
                          </span>
                        </div>
                        <p className="mt-1 font-mono text-2xs text-fg-muted">
                          {`HR ${String(record.heartRate ?? '—')} · RR ${String(
                            record.respiratoryRate ?? '—',
                          )} · SBP ${String(record.systolicBp ?? '—')} · SpO₂ ${String(
                            record.spo2 ?? '—',
                          )} · GCS ${record.gcsDisplay ?? '—'}`}
                        </p>
                        {record.overrideReason === null ? null : (
                          <p className="mt-1">
                            {`Algorithm said ${String(record.suggestedLevel ?? '—')}. `}
                            {record.overrideReason}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                </AsyncPanel>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
