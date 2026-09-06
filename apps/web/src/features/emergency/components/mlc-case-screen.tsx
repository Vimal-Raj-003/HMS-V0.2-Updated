'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, useToast } from '@vims/ui';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { erKeys } from '../api/keys';
import {
  acknowledgeIntimation,
  captureEvidence,
  createIntimation,
  dispatchIntimation,
  getCase,
  overrideGate,
  recordCustody,
  recordInjury,
} from '../api/mlc-client';

const INJURY_KINDS = [
  'abrasion',
  'contusion',
  'laceration',
  'incised',
  'stab',
  'chop',
  'firearm_entry',
  'firearm_exit',
  'burn',
  'fracture',
  'bite',
  'ligature',
  'defence_wound',
  'other',
] as const;

const BODY_VIEWS = ['front', 'back', 'left', 'right', 'head', 'palms', 'soles'] as const;

/** BNS 2023 §116 replaced IPC §320. The grounds are a closed list for a reason. */
const GRIEVOUS_GROUNDS = [
  { value: 'emasculation', label: 'Emasculation' },
  { value: 'permanent_privation_of_sight', label: 'Permanent privation of sight' },
  { value: 'permanent_privation_of_hearing', label: 'Permanent privation of hearing' },
  { value: 'privation_of_member_or_joint', label: 'Privation of a member or joint' },
  { value: 'destruction_or_impairment_of_powers', label: 'Destruction or impairment of powers' },
  { value: 'permanent_disfiguration_of_head_or_face', label: 'Permanent disfiguration of head or face' },
  { value: 'fracture_or_dislocation', label: 'Fracture or dislocation' },
  { value: 'endangers_life_or_severe_pain_20_days', label: 'Endangers life, or severe pain ≥ 20 days' },
] as const;

const WEAPONS = [
  'blunt',
  'sharp',
  'pointed',
  'firearm',
  'thermal',
  'chemical',
  'animal',
  'ligature',
  'other',
  'undetermined',
] as const;

const EVIDENCE_KINDS = [
  'clothing',
  'belonging',
  'sample',
  'foreign_body',
  'document',
  'photo',
  'video',
] as const;

const LOCATIONS = ['er', 'evidence_locker', 'lab', 'mrd', 'police', 'court'] as const;

const BNS_TONE: Readonly<Record<string, 'neutral' | 'warning' | 'danger'>> = {
  simple: 'neutral',
  grievous: 'warning',
  dangerous_to_life: 'danger',
  not_assessed: 'warning',
};

const selectClass = 'h-10 rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

function num(v: string): number | undefined {
  if (v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function when<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * TR-008 — one medico-legal case.
 *
 * ── The gate banner is the first thing on the page ──────────────────────────
 *
 * Not because it is the most important clinical fact — it is not — but because
 * it is the one the desk will otherwise discover by pressing "discharge" and
 * being refused. The list it shows is the same three conditions the database
 * trigger checks; the trigger decides, this only explains.
 *
 * ── The body map is a numbered list, not a picture ──────────────────────────
 *
 * Each injury carries an x/y percentage so an SVG overlay can place a numbered
 * pin, and the numbers are what the certificate and the photographs refer to.
 * The percentages are recorded here even though this build renders the list
 * rather than the diagram: the data a court needs is the measurement and the
 * classification, and a diagram that arrives in a later release must not
 * require the cases already recorded to be re-examined.
 *
 * ── Every chain is shown with its verification ──────────────────────────────
 *
 * `chainIntact` is recomputed on the server on every read. A chain rendered
 * without saying whether it verifies is a list of rows being called a chain.
 */
export function MlcCaseScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = erKeys(hospitalId);
  const { publish } = useToast();
  const caseId = useSearchParams().get('id') ?? '';

  const [injuryOpen, setInjuryOpen] = useState(false);
  const [kind, setKind] = useState<string>('abrasion');
  const [bodyView, setBodyView] = useState<string>('front');
  const [xPct, setXPct] = useState('50');
  const [yPct, setYPct] = useState('50');
  const [site, setSite] = useState('');
  const [lengthCm, setLengthCm] = useState('');
  const [breadthCm, setBreadthCm] = useState('');
  const [bnsClass, setBnsClass] = useState('not_assessed');
  const [grievousGround, setGrievousGround] = useState('');
  const [weapon, setWeapon] = useState('undetermined');
  const [consistent, setConsistent] = useState('cannot_say');

  const [psName, setPsName] = useState('');
  const [officerName, setOfficerName] = useState('');
  const [officerBadge, setOfficerBadge] = useState('');

  const [evidenceKind, setEvidenceKind] = useState<string>('clothing');
  const [evidenceDesc, setEvidenceDesc] = useState('');
  const [sealNo, setSealNo] = useState('');

  const [transferOf, setTransferOf] = useState<string | null>(null);
  const [transferTo, setTransferTo] = useState<string>('evidence_locker');
  const [transferWhy, setTransferWhy] = useState('');

  const [overrideReason, setOverrideReason] = useState('');

  const canInjury = granted.has('mlc.injury.write');
  const canIntimate = granted.has('mlc.intimation.create');
  const canDispatch = granted.has('mlc.intimation.dispatch');
  const canEvidence = granted.has('mlc.evidence.capture');
  const canCustody = granted.has('mlc.custody.transfer');
  const canOverride = granted.has('mlc.discharge.override');

  const detail = useQuery({
    queryKey: keys.mlcCase(caseId),
    queryFn: ({ signal }) => getCase(caseId, { signal }),
    enabled: caseId !== '',
  });
  const data = detail.data ?? null;

  const refresh = (): void => {
    void detail.refetch();
  };

  const addInjury = useMutation({
    mutationFn: () =>
      recordInjury(caseId, {
        kind,
        bodyView,
        xPct: num(xPct) ?? 50,
        yPct: num(yPct) ?? 50,
        siteDescription: site.trim(),
        ...when('lengthCm', num(lengthCm)),
        ...when('breadthCm', num(breadthCm)),
        bnsClass,
        ...(bnsClass === 'grievous' && grievousGround !== '' ? { grievousGround } : {}),
        weaponOpinion: weapon,
        consistentWithHistory: consistent,
      }),
    onSuccess: () => {
      setSite('');
      setLengthCm('');
      setBreadthCm('');
      setInjuryOpen(false);
      refresh();
    },
  });

  const generate = useMutation({
    mutationFn: () => createIntimation(caseId, { type: 'initial', psName: psName.trim() }),
    onSuccess: () => {
      setPsName('');
      refresh();
    },
  });

  const dispatchOne = useMutation({
    mutationFn: (id: string) =>
      dispatchIntimation(id, [{ channel: 'printed', to: 'Carried to the station by security' }]),
    onSuccess: refresh,
  });

  const acknowledge = useMutation({
    mutationFn: (id: string) =>
      acknowledgeIntimation(id, {
        officerName: officerName.trim(),
        ...(officerBadge.trim() === '' ? {} : { officerBadge: officerBadge.trim() }),
      }),
    onSuccess: () => {
      setOfficerName('');
      setOfficerBadge('');
      refresh();
    },
  });

  const addEvidence = useMutation({
    mutationFn: () =>
      captureEvidence(caseId, {
        kind: evidenceKind,
        description: evidenceDesc.trim(),
        ...(sealNo.trim() === '' ? {} : { sealNo: sealNo.trim() }),
      }),
    onSuccess: () => {
      setEvidenceDesc('');
      setSealNo('');
      refresh();
    },
  });

  const transfer = useMutation({
    mutationFn: (evidenceId: string) =>
      recordCustody(evidenceId, {
        locationTo: transferTo,
        purpose: transferWhy.trim(),
        sealIntact: true,
      }),
    onSuccess: () => {
      setTransferOf(null);
      setTransferWhy('');
      refresh();
      publish({
        title: 'Custody recorded',
        description: 'The entry cannot be edited afterwards.',
        severity: 'success',
      });
    },
  });

  const override = useMutation({
    mutationFn: () => overrideGate(caseId, overrideReason.trim()),
    onSuccess: () => {
      setOverrideReason('');
      refresh();
      publish({
        title: 'Discharge gate overridden',
        description: 'The reason is on the case, where the register shows it.',
        severity: 'warning',
      });
    },
  });

  if (caseId === '') {
    return (
      <section className="flex flex-col gap-5">
        <PageHeader title="Medico-legal case" description="Open a case from the register." />
        <EmptyState
          cause="No case was named in the address."
          nextAction="Choose a case from the medico-legal register."
        />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title={data === null ? 'Medico-legal case' : data.mlcCase.mlcNo}
        description="Injuries, police intimation, the evidence chain and the discharge gate."
      />

      <AsyncPanel
        loading={detail.isPending}
        error={detail.error}
        isEmpty={false}
        skeletonLabel="Loading the case"
        skeletonRows={6}
        onRetry={refresh}
        empty={null}
      >
        {data === null ? null : (
          <div className="flex flex-col gap-5">
            {/* ── The gate ──────────────────────────────────────────────── */}
            <div
              className={`rounded-lg p-4 ${
                data.gate.blocked
                  ? 'border-2 border-danger-border bg-danger-subtle'
                  : 'border border-strong bg-layer-1'
              }`}
              data-testid="mlc-gate"
            >
              <p className="text-base font-medium">
                {data.gate.blocked
                  ? 'This patient cannot be discharged yet'
                  : 'The medico-legal set is complete'}
              </p>
              {data.gate.outstanding.length === 0 ? null : (
                <ul className="mt-1 list-disc ps-5 text-sm">
                  {data.gate.outstanding.map((o) => (
                    <li key={o}>{o}</li>
                  ))}
                </ul>
              )}
              {data.gate.overriddenBy === null ? null : (
                <p className="mt-2 text-sm">
                  <Badge tone="warning">overridden</Badge> {data.gate.overrideReason}
                </p>
              )}
              <p className="mt-2 text-2xs text-fg-subtle">
                Only discharge, transfer and body release wait for this. Nothing here gates treatment, and
                there is no column in the medico-legal schema that could.
              </p>

              {canOverride && data.gate.blocked ? (
                <form
                  className="mt-3 flex flex-wrap items-end gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    override.mutate();
                  }}
                >
                  <div className="flex min-w-80 flex-1 flex-col gap-1">
                    <Label htmlFor="override-reason">Override, on the record</Label>
                    <Input
                      id="override-reason"
                      value={overrideReason}
                      autoComplete="off"
                      placeholder="Patient absconded before the intimation could be carried; police informed by phone"
                      onChange={(event) => {
                        setOverrideReason(event.target.value);
                      }}
                    />
                  </div>
                  <Button
                    type="submit"
                    variant="danger"
                    disabled={overrideReason.trim().length < 8 || override.isPending}
                  >
                    Override
                  </Button>
                </form>
              ) : null}
              {override.error === null ? null : <ProblemCard error={override.error} />}
            </div>

            {/* ── The case ──────────────────────────────────────────────── */}
            <div className="rounded-lg border border-strong bg-layer-1 p-4">
              <p className="flex flex-wrap items-center gap-2 text-base font-medium">
                {data.mlcCase.displayName ?? data.mlcCase.tempTagId ?? 'Unidentified'}
                <Badge tone="neutral">{data.mlcCase.category.replace(/_/gu, ' ')}</Badge>
                <Badge tone={data.mlcCase.status === 'cancelled' ? 'danger' : 'neutral'}>
                  {data.mlcCase.status.replace('_', ' ')}
                </Badge>
                {data.mlcCase.isSensitive ? <Badge tone="danger">restricted</Badge> : null}
              </p>
              <p className="mt-1 text-2xs text-fg-muted">
                Opened {new Date(data.mlcCase.openedAt).toLocaleString()}
                {data.mlcCase.erNo === null ? '' : ` · ${data.mlcCase.erNo}`}
                {data.mlcCase.incidentPlace === null ? '' : ` · ${data.mlcCase.incidentPlace}`}
              </p>
              {data.mlcCase.historyAsStated === null ? null : (
                <p className="mt-2 text-sm">
                  <span className="text-fg-subtle">History as stated: </span>
                  {data.mlcCase.historyAsStated}
                </p>
              )}
              {data.mlcCase.unflagReason === null ? null : (
                <p className="mt-2 text-sm">
                  <span className="text-fg-subtle">Cancelled: </span>
                  {data.mlcCase.unflagReason}
                </p>
              )}
            </div>

            {/* ── Injuries ──────────────────────────────────────────────── */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-medium">Injuries</h2>
                {canInjury ? (
                  <Button
                    type="button"
                    data-testid="open-injury"
                    onClick={() => {
                      setInjuryOpen(!injuryOpen);
                    }}
                  >
                    {injuryOpen ? 'Close' : 'Document an injury'}
                  </Button>
                ) : null}
              </div>
              {addInjury.error === null ? null : <ProblemCard error={addInjury.error} />}

              {injuryOpen ? (
                <form
                  className="flex flex-wrap items-end gap-3 rounded-lg border border-dashed border-strong p-4"
                  data-testid="injury-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    addInjury.mutate();
                  }}
                >
                  <div className="flex w-40 flex-col gap-1">
                    <Label htmlFor="injury-kind">Type</Label>
                    <select
                      id="injury-kind"
                      className={selectClass}
                      value={kind}
                      onChange={(e) => {
                        setKind(e.target.value);
                      }}
                    >
                      {INJURY_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {k.replace(/_/gu, ' ')}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex w-32 flex-col gap-1">
                    <Label htmlFor="injury-view">View</Label>
                    <select
                      id="injury-view"
                      className={selectClass}
                      value={bodyView}
                      onChange={(e) => {
                        setBodyView(e.target.value);
                      }}
                    >
                      {BODY_VIEWS.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex w-24 flex-col gap-1">
                    <Label htmlFor="injury-x">x %</Label>
                    <Input
                      id="injury-x"
                      inputMode="numeric"
                      value={xPct}
                      onChange={(e) => {
                        setXPct(e.target.value);
                      }}
                    />
                  </div>
                  <div className="flex w-24 flex-col gap-1">
                    <Label htmlFor="injury-y">y %</Label>
                    <Input
                      id="injury-y"
                      inputMode="numeric"
                      value={yPct}
                      onChange={(e) => {
                        setYPct(e.target.value);
                      }}
                    />
                  </div>
                  <div className="flex min-w-80 flex-1 flex-col gap-1">
                    <Label htmlFor="injury-site">Site</Label>
                    <Input
                      id="injury-site"
                      value={site}
                      autoComplete="off"
                      placeholder="Left anterior chest, 6 cm below the clavicle"
                      onChange={(e) => {
                        setSite(e.target.value);
                      }}
                    />
                  </div>
                  <div className="flex w-28 flex-col gap-1">
                    <Label htmlFor="injury-length">Length cm</Label>
                    <Input
                      id="injury-length"
                      inputMode="decimal"
                      value={lengthCm}
                      onChange={(e) => {
                        setLengthCm(e.target.value);
                      }}
                    />
                  </div>
                  <div className="flex w-28 flex-col gap-1">
                    <Label htmlFor="injury-breadth">Breadth cm</Label>
                    <Input
                      id="injury-breadth"
                      inputMode="decimal"
                      value={breadthCm}
                      onChange={(e) => {
                        setBreadthCm(e.target.value);
                      }}
                    />
                  </div>
                  <div className="flex w-44 flex-col gap-1">
                    <Label htmlFor="injury-bns">BNS §116 class</Label>
                    <select
                      id="injury-bns"
                      className={selectClass}
                      value={bnsClass}
                      onChange={(e) => {
                        setBnsClass(e.target.value);
                      }}
                    >
                      <option value="not_assessed">Not assessed</option>
                      <option value="simple">Simple</option>
                      <option value="grievous">Grievous</option>
                      <option value="dangerous_to_life">Dangerous to life</option>
                    </select>
                  </div>
                  {bnsClass === 'grievous' ? (
                    <div className="flex min-w-72 flex-1 flex-col gap-1">
                      <Label htmlFor="injury-ground">Which limb of §116</Label>
                      <select
                        id="injury-ground"
                        className={selectClass}
                        value={grievousGround}
                        onChange={(e) => {
                          setGrievousGround(e.target.value);
                        }}
                      >
                        <option value="">—</option>
                        {GRIEVOUS_GROUNDS.map((g) => (
                          <option key={g.value} value={g.value}>
                            {g.label}
                          </option>
                        ))}
                      </select>
                      <p className="text-2xs text-fg-subtle">
                        Required. &ldquo;Grievous&rdquo; with no ground is an opinion a court cannot test.
                      </p>
                    </div>
                  ) : null}
                  <div className="flex w-40 flex-col gap-1">
                    <Label htmlFor="injury-weapon">Weapon opinion</Label>
                    <select
                      id="injury-weapon"
                      className={selectClass}
                      value={weapon}
                      onChange={(e) => {
                        setWeapon(e.target.value);
                      }}
                    >
                      {WEAPONS.map((w) => (
                        <option key={w} value={w}>
                          {w}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex w-44 flex-col gap-1">
                    <Label htmlFor="injury-consistent">Consistent with history</Label>
                    <select
                      id="injury-consistent"
                      className={selectClass}
                      value={consistent}
                      onChange={(e) => {
                        setConsistent(e.target.value);
                      }}
                    >
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                      <option value="cannot_say">Cannot say</option>
                    </select>
                  </div>
                  <Button
                    type="submit"
                    data-testid="save-injury"
                    disabled={site.trim().length < 3 || addInjury.isPending}
                  >
                    Record
                  </Button>
                </form>
              ) : null}

              {data.injuries.length === 0 ? (
                <EmptyState
                  cause="No injuries are documented on this case."
                  nextAction='Record each injury, or record "no external injury" if that is the finding — the discharge gate waits for one or the other.'
                />
              ) : (
                <ol className="flex flex-col gap-2" data-testid="mlc-injuries">
                  {data.injuries.map((i) => (
                    <li key={i.id} className="rounded-lg border border-strong bg-layer-1 p-3 text-sm">
                      <p className="flex flex-wrap items-center gap-2">
                        <Badge tone="neutral">{`#${String(i.seq)}`}</Badge>
                        <span className="capitalize">{i.kind.replace(/_/gu, ' ')}</span>
                        <Badge tone={BNS_TONE[i.bnsClass] ?? 'neutral'}>
                          {i.bnsClass.replace(/_/gu, ' ')}
                        </Badge>
                        <span className="text-2xs text-fg-subtle">
                          {i.weaponOpinion} · {i.consistentWithHistory.replace('_', ' ')}
                        </span>
                      </p>
                      <p className="mt-1">{i.siteDescription}</p>
                      <p className="mt-1 font-mono text-2xs text-fg-muted">
                        {[i.lengthCm, i.breadthCm, i.depthCm].filter((d) => d !== null).join(' × ') || '—'} cm
                        {i.grievousReason === null ? '' : ` · ${i.grievousReason.replace(/_/gu, ' ')}`}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            {/* ── Police intimation ─────────────────────────────────────── */}
            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">Police intimation</h2>
              {generate.error === null ? null : <ProblemCard error={generate.error} />}
              {dispatchOne.error === null ? null : <ProblemCard error={dispatchOne.error} />}
              {acknowledge.error === null ? null : <ProblemCard error={acknowledge.error} />}

              {canIntimate ? (
                <form
                  className="flex flex-wrap items-end gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    generate.mutate();
                  }}
                >
                  <div className="flex min-w-72 flex-col gap-1">
                    <Label htmlFor="ps-name">Police station</Label>
                    <Input
                      id="ps-name"
                      value={psName}
                      autoComplete="off"
                      placeholder="Bommanahalli PS"
                      onChange={(e) => {
                        setPsName(e.target.value);
                      }}
                    />
                  </div>
                  <Button type="submit" disabled={psName.trim().length < 2 || generate.isPending}>
                    Generate
                  </Button>
                </form>
              ) : null}

              {data.intimations.length === 0 ? (
                <EmptyState
                  cause="No intimation has been generated."
                  nextAction="The target is one hour from the case opening, and the discharge gate waits for a dispatched intimation."
                />
              ) : (
                <ul className="flex flex-col gap-2" data-testid="mlc-intimations">
                  {data.intimations.map((i) => (
                    <li key={i.id} className="rounded-lg border border-strong bg-layer-1 p-3 text-sm">
                      <p className="flex flex-wrap items-center gap-2">
                        <Badge
                          tone={
                            i.status === 'acknowledged'
                              ? 'success'
                              : i.status === 'failed'
                                ? 'danger'
                                : 'warning'
                          }
                        >
                          {i.status}
                        </Badge>
                        <span>{i.psName}</span>
                        <span className="text-2xs text-fg-subtle">{i.type.replace(/_/gu, ' ')}</span>
                        <Badge
                          tone={i.minutesOverdue !== null && i.minutesOverdue > 0 ? 'danger' : 'neutral'}
                        >
                          {i.minutesOverdue === null
                            ? '—'
                            : i.minutesOverdue > 0
                              ? `${String(i.minutesOverdue)} min over target`
                              : `${String(Math.abs(i.minutesOverdue))} min inside target`}
                        </Badge>
                      </p>
                      {i.ackOfficerName === null ? null : (
                        <p className="mt-1 text-2xs text-fg-muted">
                          Signed for by {i.ackOfficerName}
                          {i.ackOfficerBadge === null ? '' : ` (${i.ackOfficerBadge})`} at{' '}
                          {new Date(i.ackAt ?? '').toLocaleTimeString()}
                        </p>
                      )}

                      {canDispatch && i.status === 'generated' ? (
                        <div className="mt-2">
                          <Button
                            type="button"
                            size="sm"
                            disabled={dispatchOne.isPending}
                            onClick={() => {
                              dispatchOne.mutate(i.id);
                            }}
                          >
                            Mark dispatched
                          </Button>
                        </div>
                      ) : null}

                      {canDispatch && i.status === 'dispatched' ? (
                        <form
                          className="mt-2 flex flex-wrap items-end gap-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            acknowledge.mutate(i.id);
                          }}
                        >
                          <div className="flex w-56 flex-col gap-1">
                            <Label htmlFor={`officer-${i.id}`}>Receiving officer</Label>
                            <Input
                              id={`officer-${i.id}`}
                              value={officerName}
                              autoComplete="off"
                              placeholder="HC Ramesh Kumar"
                              onChange={(e) => {
                                setOfficerName(e.target.value);
                              }}
                            />
                          </div>
                          <div className="flex w-32 flex-col gap-1">
                            <Label htmlFor={`badge-${i.id}`}>Badge</Label>
                            <Input
                              id={`badge-${i.id}`}
                              value={officerBadge}
                              autoComplete="off"
                              onChange={(e) => {
                                setOfficerBadge(e.target.value);
                              }}
                            />
                          </div>
                          <Button
                            type="submit"
                            size="sm"
                            disabled={officerName.trim().length < 2 || acknowledge.isPending}
                          >
                            Record the signature
                          </Button>
                        </form>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* ── Evidence ──────────────────────────────────────────────── */}
            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">Evidence and custody</h2>
              {addEvidence.error === null ? null : <ProblemCard error={addEvidence.error} />}
              {transfer.error === null ? null : <ProblemCard error={transfer.error} />}

              {canEvidence ? (
                <form
                  className="flex flex-wrap items-end gap-3"
                  data-testid="evidence-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    addEvidence.mutate();
                  }}
                >
                  <div className="flex w-40 flex-col gap-1">
                    <Label htmlFor="ev-kind">Item</Label>
                    <select
                      id="ev-kind"
                      className={selectClass}
                      value={evidenceKind}
                      onChange={(e) => {
                        setEvidenceKind(e.target.value);
                      }}
                    >
                      {EVIDENCE_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {k.replace(/_/gu, ' ')}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex min-w-80 flex-1 flex-col gap-1">
                    <Label htmlFor="ev-desc">Description</Label>
                    <Input
                      id="ev-desc"
                      value={evidenceDesc}
                      autoComplete="off"
                      placeholder="Blue check shirt, cut through the left chest, dried before packing"
                      onChange={(e) => {
                        setEvidenceDesc(e.target.value);
                      }}
                    />
                  </div>
                  <div className="flex w-40 flex-col gap-1">
                    <Label htmlFor="ev-seal">Seal no</Label>
                    <Input
                      id="ev-seal"
                      value={sealNo}
                      autoComplete="off"
                      onChange={(e) => {
                        setSealNo(e.target.value);
                      }}
                    />
                  </div>
                  <Button type="submit" disabled={evidenceDesc.trim().length < 3 || addEvidence.isPending}>
                    Register
                  </Button>
                </form>
              ) : null}

              {data.evidence.length === 0 ? (
                <EmptyState
                  cause="No evidence has been registered on this case."
                  nextAction="Clothing, samples and photographs are sealed, labelled and entered into the chain here."
                />
              ) : (
                <ul className="flex flex-col gap-3" data-testid="mlc-evidence">
                  {data.evidence.map((e) => (
                    <li key={e.id} className="rounded-lg border border-strong bg-layer-1 p-3 text-sm">
                      <p className="flex flex-wrap items-center gap-2">
                        <Badge tone="neutral">{`item ${String(e.itemNo)}`}</Badge>
                        <span className="capitalize">{e.kind.replace(/_/gu, ' ')}</span>
                        <Badge tone={e.status === 'handed_over' ? 'success' : 'neutral'}>
                          {e.status.replace('_', ' ')}
                        </Badge>
                        <span className="text-2xs text-fg-subtle">{e.currentLocation.replace('_', ' ')}</span>
                        <Badge tone={e.chainIntact ? 'success' : 'danger'}>
                          {e.chainIntact ? 'chain verifies' : 'CHAIN BROKEN'}
                        </Badge>
                      </p>
                      <p className="mt-1">{e.description}</p>
                      <p className="mt-1 font-mono text-2xs text-fg-muted">
                        {e.sealNo === null ? 'unsealed' : `seal ${e.sealNo}`}
                        {e.sha256 === null ? '' : ` · sha256 ${e.sha256.slice(0, 16)}…`}
                      </p>

                      <ol className="mt-2 flex flex-col gap-1">
                        {e.custody.map((c) => (
                          <li key={`${e.id}-${String(c.seq)}`} className="font-mono text-2xs text-fg-muted">
                            {String(c.seq).padStart(2, '0')}. {c.locationFrom} → {c.locationTo} ·{' '}
                            {new Date(c.at).toLocaleString()} · {c.hash.slice(0, 10)}…{' '}
                            {c.linkIntact ? '' : '⚠ link does not verify'}
                          </li>
                        ))}
                      </ol>

                      {canCustody && e.status !== 'handed_over' ? (
                        transferOf === e.id ? (
                          <form
                            className="mt-2 flex flex-wrap items-end gap-2"
                            onSubmit={(event) => {
                              event.preventDefault();
                              transfer.mutate(e.id);
                            }}
                          >
                            <div className="flex w-44 flex-col gap-1">
                              <Label htmlFor={`to-${e.id}`}>To</Label>
                              <select
                                id={`to-${e.id}`}
                                className={selectClass}
                                value={transferTo}
                                onChange={(ev) => {
                                  setTransferTo(ev.target.value);
                                }}
                              >
                                {LOCATIONS.map((l) => (
                                  <option key={l} value={l}>
                                    {l.replace('_', ' ')}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="flex min-w-72 flex-1 flex-col gap-1">
                              <Label htmlFor={`why-${e.id}`}>Purpose</Label>
                              <Input
                                id={`why-${e.id}`}
                                value={transferWhy}
                                autoComplete="off"
                                placeholder="Secured in the ER evidence locker at the end of the resuscitation"
                                onChange={(ev) => {
                                  setTransferWhy(ev.target.value);
                                }}
                              />
                            </div>
                            <Button
                              type="submit"
                              size="sm"
                              disabled={transferWhy.trim().length < 4 || transfer.isPending}
                            >
                              Record
                            </Button>
                          </form>
                        ) : (
                          <div className="mt-2">
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => {
                                setTransferOf(e.id);
                              }}
                            >
                              Transfer custody
                            </Button>
                          </div>
                        )
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-2xs text-fg-subtle">
                Every custody entry is hashed by the database from its own content plus the previous entry.
                Nothing in this application supplies a hash, so nothing in it can forge a link — and a break
                shows above rather than staying hidden.
              </p>
            </div>

            {/* ── Reports ───────────────────────────────────────────────── */}
            {data.reports.length === 0 ? null : (
              <div className="flex flex-col gap-2">
                <h2 className="text-sm font-medium">Certificates and reports</h2>
                <ul className="flex flex-col gap-2" data-testid="mlc-reports">
                  {data.reports.map((r) => (
                    <li key={r.id} className="rounded-lg border border-strong bg-layer-1 p-3 text-sm">
                      <p className="flex flex-wrap items-center gap-2">
                        <Badge tone="neutral">{`v${String(r.versionNo)}`}</Badge>
                        <span>{r.kind.replace(/_/gu, ' ')}</span>
                        <Badge tone={r.status.startsWith('final') ? 'success' : 'warning'}>
                          {r.status.replace(/_/gu, ' ')}
                        </Badge>
                        {r.copyRegisterNo === null ? null : (
                          <span className="font-mono text-2xs text-fg-subtle">{r.copyRegisterNo}</span>
                        )}
                      </p>
                      {r.addendumReason === null ? null : (
                        <p className="mt-1">Addendum: {r.addendumReason}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </AsyncPanel>
    </section>
  );
}
