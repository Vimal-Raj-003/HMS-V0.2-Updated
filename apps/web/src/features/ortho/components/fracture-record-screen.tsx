'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, useToast } from '@vims/ui';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import {
  attachFilm,
  confirmFracture,
  declareUnion,
  getFracture,
  recordBundle,
  recordFinding,
  setPlan,
} from '../api/client';
import { orthoKeys } from '../api/keys';

const INTENTS = [
  'conservative',
  'closed_reduction_cast',
  'percutaneous_pinning',
  'orif',
  'im_nail',
  'external_fixation',
  'arthroplasty',
  'amputation',
  'traction',
  'observation',
] as const;

const WEIGHT_BEARING = [
  { value: 'nwb', label: 'Non-weight-bearing' },
  { value: 'ttwb', label: 'Toe-touch' },
  { value: 'pwb', label: 'Partial' },
  { value: 'wbat', label: 'As tolerated' },
  { value: 'fwb', label: 'Full' },
] as const;

const FILM_LABELS = [
  'injury',
  'post_reduction',
  'post_op',
  'healing_2w',
  'healing_6w',
  'healing_12w',
  'healing_24w',
  'hardware_review',
] as const;

const selectClass = 'h-10 rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

function num(v: string): number | undefined {
  if (v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * TR-002 — one fracture.
 *
 * ── The plan's side is chosen, never inherited ──────────────────────────────
 *
 * The form makes you pick it, and the server refuses a mismatch. Pre-filling it
 * from the fracture would make the two agree by construction and remove the
 * only check that catches the case this rule exists for — the surgeon who is
 * looking at the wrong patient's film.
 *
 * ── The open-fracture clocks are shown before they are missed ───────────────
 *
 * The antibiotic hour is counting from arrival on this screen. Showing the
 * breach afterwards is an audit; showing the clock is a chance to not breach it.
 */
export function FractureRecordScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = orthoKeys(hospitalId);
  const { publish } = useToast();
  const fractureId = useSearchParams().get('id') ?? '';

  const [intent, setIntent] = useState<string>('conservative');
  const [planSide, setPlanSide] = useState<string>('');
  const [weightBearing, setWeightBearing] = useState<string>('nwb');
  const [urgency, setUrgency] = useState<string>('elective');

  const [filmLabel, setFilmLabel] = useState<string>('healing_6w');
  const [rust, setRust] = useState('');
  const [findingFilm, setFindingFilm] = useState<string | null>(null);
  const [unionReason, setUnionReason] = useState('');

  const canConfirm = granted.has('fracture.classification.confirm');
  const canPlan = granted.has('fracture.plan.set');
  const canImage = granted.has('fracture.imaging.assess');
  const canUnion = granted.has('fracture.union.declare');
  const canBundle = granted.has('fracture.event.record');

  const detail = useQuery({
    queryKey: keys.fracture(fractureId),
    queryFn: ({ signal }) => getFracture(fractureId, { signal }),
    enabled: fractureId !== '',
  });
  const data = detail.data ?? null;
  const refresh = (): void => {
    void detail.refetch();
  };

  const confirm = useMutation({
    mutationFn: () => confirmFracture(fractureId),
    onSuccess: () => {
      refresh();
      publish({ title: 'Classification confirmed', severity: 'success' });
    },
  });

  const plan = useMutation({
    mutationFn: () => setPlan(fractureId, { intent, side: planSide, urgency, weightBearing }),
    onSuccess: () => {
      setPlanSide('');
      refresh();
    },
  });

  const film = useMutation({
    mutationFn: () => attachFilm(fractureId, { label: filmLabel, takenAt: new Date().toISOString() }),
    onSuccess: refresh,
  });

  const finding = useMutation({
    mutationFn: (filmId: string) => {
      const scored = num(rust);
      return recordFinding(fractureId, {
        filmId,
        ...(scored === undefined ? {} : { rustScore: scored }),
        // A RUST of 10 or more across four cortices is the usual threshold for
        // calling union radiologically. Below it the film says "progressing",
        // which is a statement the surgeon can still disagree with.
        unionStatus: (scored ?? 0) >= 10 ? 'united' : 'progressing',
      });
    },
    onSuccess: () => {
      setRust('');
      setFindingFilm(null);
      refresh();
    },
  });

  const bundle = useMutation({
    mutationFn: (field: string) => recordBundle(fractureId, { [field]: new Date().toISOString() }),
    onSuccess: refresh,
  });

  const union = useMutation({
    mutationFn: (outcome: string) =>
      declareUnion(fractureId, { outcome }, unionReason.trim() === '' ? undefined : unionReason.trim()),
    onSuccess: () => {
      setUnionReason('');
      refresh();
    },
  });

  if (fractureId === '') {
    return (
      <section className="flex flex-col gap-5">
        <PageHeader title="Fracture record" description="Open one from the registry." />
        <EmptyState
          cause="No fracture was named in the address."
          nextAction="Choose one from the registry."
        />
      </section>
    );
  }

  const f = data?.fracture ?? null;
  const bundleView = data?.openBundle ?? null;

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title={f === null ? 'Fracture record' : `${f.aoCode ?? 'Unclassified'} · ${f.boneDisplay}`}
        description="Classification, plan, healing films and the union call."
      />

      <AsyncPanel
        loading={detail.isPending}
        error={detail.error}
        isEmpty={false}
        skeletonLabel="Loading the fracture"
        skeletonRows={6}
        onRetry={refresh}
        empty={null}
      >
        {data === null || f === null ? null : (
          <div className="flex flex-col gap-5">
            {/* ── The header ────────────────────────────────────────────── */}
            <div className="rounded-lg border border-strong bg-layer-1 p-4">
              <p className="flex flex-wrap items-center gap-2 text-base font-medium">
                {f.boneDisplay}
                <Badge tone={f.side === 'right' ? 'danger' : f.side === 'left' ? 'info' : 'neutral'}>
                  {f.side.replace('_', ' ')}
                </Badge>
                {f.isOpen ? <Badge tone="danger">{`open · Gustilo ${f.gustilo ?? '?'}`}</Badge> : null}
                <Badge tone={f.classificationStatus === 'confirmed' ? 'success' : 'warning'}>
                  {f.classificationStatus}
                </Badge>
                <Badge tone={f.status === 'united' ? 'success' : 'warning'}>
                  {f.status.replace('_', ' ')}
                </Badge>
              </p>
              <p className="mt-1 font-mono text-2xs text-fg-muted">
                {f.aoCode ?? 'no AO code'} · AO {f.aoVersion}
                {f.weeksSinceInjury === null ? '' : ` · ${f.weeksSinceInjury} weeks since injury`}
                {f.timeToUnionWeeks === null ? '' : ` · united at ${f.timeToUnionWeeks} weeks`}
              </p>
              {f.registryReady ? null : (
                <p className="mt-2 text-2xs">
                  <Badge tone="warning">not exportable</Badge>{' '}
                  <span className="text-fg-muted">{f.registryGaps.join('; ')}</span>
                </p>
              )}
              {f.nonunionOverrideReason === null ? null : (
                <p className="mt-2 text-sm">Non-union declared early: {f.nonunionOverrideReason}</p>
              )}
              {canConfirm && f.classificationStatus === 'provisional' ? (
                <div className="mt-3">
                  <Button
                    type="button"
                    disabled={confirm.isPending}
                    onClick={() => {
                      confirm.mutate();
                    }}
                  >
                    Confirm the classification
                  </Button>
                </div>
              ) : null}
              {confirm.error === null ? null : <ProblemCard error={confirm.error} />}
            </div>

            {/* ── The open-fracture clocks ──────────────────────────────── */}
            {bundleView === null ? null : (
              <div
                className={`rounded-lg p-4 ${
                  bundleView.breaches.length > 0
                    ? 'border-2 border-danger-border bg-danger-subtle'
                    : 'border border-strong bg-layer-1'
                }`}
                data-testid="open-bundle"
              >
                <h2 className="text-sm font-medium">Open-fracture bundle</h2>
                <p className="mt-1 text-2xs text-fg-muted">
                  Measured from arrival at {new Date(bundleView.arrivedAt).toLocaleTimeString()}, not from
                  diagnosis — a four-hour wait for a film would otherwise be invisible.
                </p>
                <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                  {(
                    [
                      ['Antibiotic', bundleView.antibioticAt, 'antibioticAt'],
                      ['Tetanus', bundleView.tetanusAt, 'tetanusAt'],
                      ['Debridement', bundleView.debridementAt, 'debridementAt'],
                      ['Plastics', bundleView.plasticsReferralAt, 'plasticsReferralAt'],
                    ] as const
                  ).map(([label, value, field]) => (
                    <div key={label} className="flex flex-col gap-1">
                      <dt className="text-2xs text-fg-subtle">{label}</dt>
                      <dd className="font-mono text-2xs">
                        {value === null ? (
                          canBundle ? (
                            <Button
                              type="button"
                              size="sm"
                              disabled={bundle.isPending}
                              onClick={() => {
                                bundle.mutate(field);
                              }}
                            >
                              Record now
                            </Button>
                          ) : (
                            '—'
                          )
                        ) : (
                          new Date(value).toLocaleTimeString()
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
                {bundleView.minutesToAntibiotic === null ? null : (
                  <p className="mt-2 text-sm">
                    <Badge tone={bundleView.minutesToAntibiotic > 60 ? 'danger' : 'success'}>
                      {`antibiotic at ${String(bundleView.minutesToAntibiotic)} min (target 60)`}
                    </Badge>
                  </p>
                )}
                {bundleView.breaches.length === 0 ? null : (
                  <ul className="mt-2 list-disc ps-5 text-sm">
                    {bundleView.breaches.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                )}
                {bundle.error === null ? null : <ProblemCard error={bundle.error} />}
              </div>
            )}

            {/* ── The plan ──────────────────────────────────────────────── */}
            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">Plan</h2>
              {plan.error === null ? null : <ProblemCard error={plan.error} />}
              {data.plans.length === 0 ? (
                <EmptyState
                  cause="No treatment plan has been set."
                  nextAction="A plan carries the weight-bearing status that physio and ward nursing both read."
                />
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.plans.map((p) => (
                    <li key={p.id} className="rounded-md border border-default px-3 py-2 text-sm">
                      <Badge tone={p.isCurrent ? 'success' : 'neutral'}>{`v${String(p.version)}`}</Badge>{' '}
                      {p.intent.replace(/_/gu, ' ')} ·{' '}
                      <Badge tone={p.side === 'right' ? 'danger' : 'info'}>{p.side}</Badge> · {p.urgency} ·
                      weight bearing {p.weightBearing.toUpperCase()}
                    </li>
                  ))}
                </ul>
              )}

              {canPlan ? (
                <form
                  className="flex flex-wrap items-end gap-3 rounded-lg border border-dashed border-strong p-3"
                  data-testid="plan-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    plan.mutate();
                  }}
                >
                  <div className="flex w-52 flex-col gap-1">
                    <Label htmlFor="plan-intent">Intent</Label>
                    <select
                      id="plan-intent"
                      className={selectClass}
                      value={intent}
                      onChange={(e) => {
                        setIntent(e.target.value);
                      }}
                    >
                      {INTENTS.map((i) => (
                        <option key={i} value={i}>
                          {i.replace(/_/gu, ' ')}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex w-40 flex-col gap-1">
                    <Label htmlFor="plan-side">Side</Label>
                    <select
                      id="plan-side"
                      className={selectClass}
                      value={planSide}
                      onChange={(e) => {
                        setPlanSide(e.target.value);
                      }}
                    >
                      <option value="">Choose…</option>
                      <option value="left">left</option>
                      <option value="right">right</option>
                      <option value="midline">midline</option>
                    </select>
                  </div>
                  <div className="flex w-52 flex-col gap-1">
                    <Label htmlFor="plan-wb">Weight bearing</Label>
                    <select
                      id="plan-wb"
                      className={selectClass}
                      value={weightBearing}
                      onChange={(e) => {
                        setWeightBearing(e.target.value);
                      }}
                    >
                      {WEIGHT_BEARING.map((w) => (
                        <option key={w.value} value={w.value}>
                          {w.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex w-36 flex-col gap-1">
                    <Label htmlFor="plan-urgency">Urgency</Label>
                    <select
                      id="plan-urgency"
                      className={selectClass}
                      value={urgency}
                      onChange={(e) => {
                        setUrgency(e.target.value);
                      }}
                    >
                      {['emergency', 'urgent', 'early', 'elective'].map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button type="submit" disabled={planSide === '' || plan.isPending}>
                    Set the plan
                  </Button>
                  <p className="w-full text-2xs text-fg-subtle">
                    The side is chosen, never pre-filled from the fracture. Pre-filling would make the two
                    agree by construction and remove the only check that catches the case this rule exists for
                    — somebody looking at the wrong patient&rsquo;s film.
                  </p>
                </form>
              ) : null}
            </div>

            {/* ── The films ─────────────────────────────────────────────── */}
            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">Healing timeline</h2>
              {film.error === null ? null : <ProblemCard error={film.error} />}
              {finding.error === null ? null : <ProblemCard error={finding.error} />}
              {data.films.length === 0 ? (
                <EmptyState
                  cause="No films are attached."
                  nextAction="A film attached with its interval is what makes a side-by-side comparison mean something."
                />
              ) : (
                <ul className="flex flex-col gap-2" data-testid="fracture-films">
                  {data.films.map((x) => (
                    <li key={x.id} className="rounded-lg border border-strong bg-layer-1 p-3 text-sm">
                      <p className="flex flex-wrap items-center gap-2">
                        <Badge tone="neutral">{x.label.replace(/_/gu, ' ')}</Badge>
                        <span className="font-mono text-2xs">{new Date(x.takenAt).toLocaleString()}</span>
                        {x.weeksSinceInjury === null ? null : (
                          <span className="text-2xs text-fg-subtle">
                            {x.weeksSinceInjury} weeks since injury
                          </span>
                        )}
                        {x.autoAttached ? <Badge tone="info">auto-matched</Badge> : null}
                      </p>
                      {x.findings.map((fi) => (
                        <p key={fi.id} className="mt-1 font-mono text-2xs text-fg-muted">
                          RUST {fi.rustScore ?? '—'} · mRUST {fi.mrustScore ?? '—'} ·{' '}
                          {fi.unionStatus.replace('_', ' ')}
                          {fi.alignmentMaintained === null
                            ? ''
                            : fi.alignmentMaintained
                              ? ' · aligned'
                              : ' · alignment lost'}
                        </p>
                      ))}
                      {canImage && x.findings.length === 0 ? (
                        findingFilm === x.id ? (
                          <form
                            className="mt-2 flex flex-wrap items-end gap-2"
                            onSubmit={(event) => {
                              event.preventDefault();
                              finding.mutate(x.id);
                            }}
                          >
                            <div className="flex w-28 flex-col gap-1">
                              <Label htmlFor={`rust-${x.id}`}>RUST 4–12</Label>
                              <Input
                                id={`rust-${x.id}`}
                                inputMode="numeric"
                                value={rust}
                                onChange={(e) => {
                                  setRust(e.target.value);
                                }}
                              />
                            </div>
                            <Button type="submit" size="sm" disabled={finding.isPending}>
                              Score it
                            </Button>
                          </form>
                        ) : (
                          <div className="mt-2">
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => {
                                setFindingFilm(x.id);
                              }}
                            >
                              Score this film
                            </Button>
                          </div>
                        )
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              {canImage ? (
                <form
                  className="flex flex-wrap items-end gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    film.mutate();
                  }}
                >
                  <div className="flex w-48 flex-col gap-1">
                    <Label htmlFor="film-label">Attach a film</Label>
                    <select
                      id="film-label"
                      className={selectClass}
                      value={filmLabel}
                      onChange={(e) => {
                        setFilmLabel(e.target.value);
                      }}
                    >
                      {FILM_LABELS.map((l) => (
                        <option key={l} value={l}>
                          {l.replace(/_/gu, ' ')}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button type="submit" disabled={film.isPending}>
                    Attach
                  </Button>
                </form>
              ) : null}
            </div>

            {/* ── The union call ────────────────────────────────────────── */}
            {canUnion && f.status === 'open' ? (
              <div className="flex flex-col gap-2 rounded-lg border border-dashed border-strong p-4">
                <h2 className="text-sm font-medium">Union</h2>
                {union.error === null ? null : <ProblemCard error={union.error} />}
                <p className="text-2xs text-fg-subtle">
                  Union needs a film reporting it, or stated clinical grounds. Non-union before six months
                  needs grounds either way — it converts a fracture that might have healed into an operation.
                </p>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex min-w-96 flex-1 flex-col gap-1">
                    <Label htmlFor="union-reason">Grounds, if any</Label>
                    <Input
                      id="union-reason"
                      value={unionReason}
                      autoComplete="off"
                      placeholder="Segmental bone loss at index debridement; established non-union"
                      onChange={(e) => {
                        setUnionReason(e.target.value);
                      }}
                    />
                  </div>
                  <Button
                    type="button"
                    disabled={union.isPending}
                    onClick={() => {
                      union.mutate('united');
                    }}
                  >
                    Declare union
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    disabled={union.isPending}
                    onClick={() => {
                      union.mutate('nonunion');
                    }}
                  >
                    Declare non-union
                  </Button>
                </div>
              </div>
            ) : null}

            {/* ── The timeline ──────────────────────────────────────────── */}
            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">Events</h2>
              <ol className="flex flex-col gap-1" data-testid="fracture-events">
                {data.events.map((e) => (
                  <li key={e.id} className="rounded-md border border-default px-3 py-1.5 font-mono text-2xs">
                    {new Date(e.at).toLocaleString()} · {e.kind.replace(/_/gu, ' ')}
                    {e.weeksSinceInjury === null ? '' : ` · ${e.weeksSinceInjury}w`}
                  </li>
                ))}
              </ol>
            </div>

            {data.complications.length === 0 ? null : (
              <div className="flex flex-col gap-2">
                <h2 className="text-sm font-medium">Complications</h2>
                <ul className="flex flex-col gap-1">
                  {data.complications.map((c) => (
                    <li key={c.id} className="rounded-md border border-default px-3 py-2 text-sm">
                      <Badge
                        tone={
                          c.severity === 'severe' || c.severity === 'limb_threatening' ? 'danger' : 'warning'
                        }
                      >
                        {c.kind.replace(/_/gu, ' ')}
                      </Badge>{' '}
                      <span className="text-2xs text-fg-muted">
                        from {new Date(c.onsetAt).toLocaleDateString()}
                        {c.resolvedAt === null
                          ? ''
                          : ` · resolved ${new Date(c.resolvedAt).toLocaleDateString()}`}
                      </span>
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
