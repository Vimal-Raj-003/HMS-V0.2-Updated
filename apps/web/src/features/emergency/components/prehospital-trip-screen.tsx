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
  completeHandover,
  getPrehospitalTrip,
  openPcr,
  raisePrealert,
  recordDrug,
  recordIntervention,
  recordVitals,
  signPcr,
} from '../api/fleet-client';
import { erKeys } from '../api/keys';

const INTERVENTIONS = [
  'c_collar',
  'oxygen',
  'airway_adjunct',
  'supraglottic',
  'ett',
  'bvm',
  'cpr_start',
  'cpr_stop',
  'defib_shock',
  'iv_access',
  'io_access',
  'fluids',
  'tourniquet_on',
  'tourniquet_off',
  'pelvic_binder',
  'splint',
  'dressing',
  'needle_decompression',
  'glucose',
  'other',
] as const;

const PATHWAYS = [
  'trauma',
  'stemi',
  'stroke',
  'sepsis',
  'paediatric',
  'obstetric',
  'burns',
  'mci',
  'medical',
  'other',
] as const;

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
 * TR-009 — the crew's tablet.
 *
 * ── Every observation is a new row ──────────────────────────────────────────
 *
 * There is no edit here, and no endpoint behind one. What the crew found before
 * anybody resuscitated is the only record of what the patient was actually like
 * on arrival, and a set that can be corrected after the ER has seen them is a
 * set that will be corrected to match.
 *
 * ── The handover carries the numbers ────────────────────────────────────────
 *
 * "Carry the last observations into triage" is ticked by default and the tick
 * is exit gate 1. It writes the road set into the ER's first triage record —
 * without a level, because assigning one is the receiving nurse's act and the
 * crew never recorded ESI's decision points. The nurse triages *from* it.
 */
export function PrehospitalTripScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = erKeys(hospitalId);
  const { publish } = useToast();
  const tripId = useSearchParams().get('id') ?? '';

  const [hr, setHr] = useState('');
  const [sbp, setSbp] = useState('');
  const [dbp, setDbp] = useState('');
  const [rr, setRr] = useState('');
  const [spo2, setSpo2] = useState('');
  const [eye, setEye] = useState('');
  const [verbal, setVerbal] = useState('');
  const [motor, setMotor] = useState('');
  const [intubated, setIntubated] = useState(false);
  const [pain, setPain] = useState('');

  const [ivType, setIvType] = useState<string>('oxygen');
  const [drugName, setDrugName] = useState('');
  const [dose, setDose] = useState('');
  const [unit, setUnit] = useState('mg');
  const [route, setRoute] = useState('IV');
  const [controlled, setControlled] = useState(false);
  const [registerRef, setRegisterRef] = useState('');

  const [pathway, setPathway] = useState<string>('trauma');
  const [etaMinutes, setEtaMinutes] = useState('10');
  const [atmistAge, setAtmistAge] = useState('');
  const [atmistMech, setAtmistMech] = useState('');
  const [atmistInj, setAtmistInj] = useState('');
  const [atmistTx, setAtmistTx] = useState('');

  const [receiverId, setReceiverId] = useState('');
  const [reconciled, setReconciled] = useState(false);
  const [carry, setCarry] = useState(true);
  const [ageYears, setAgeYears] = useState('');

  const canWrite = granted.has('prehospital.pcr.write');
  const canSign = granted.has('prehospital.pcr.sign');
  const canPrealert = granted.has('prehospital.prealert.raise');
  const canHandover = granted.has('prehospital.handover.complete');

  const detail = useQuery({
    queryKey: keys.fleetTrip(tripId),
    queryFn: ({ signal }) => getPrehospitalTrip(tripId, { signal }),
    enabled: tripId !== '',
  });
  const data = detail.data ?? null;
  const pcr = data?.pcr ?? null;
  const refresh = (): void => {
    void detail.refetch();
  };

  const start = useMutation({
    mutationFn: () => openPcr({ tripId }),
    onSuccess: refresh,
  });

  const vitals = useMutation({
    mutationFn: () =>
      recordVitals(tripId, {
        at: new Date().toISOString(),
        seq: (pcr?.vitals.length ?? 0) + 1,
        ...when('heartRate', num(hr)),
        ...when('systolicBp', num(sbp)),
        ...when('diastolicBp', num(dbp)),
        ...when('respiratoryRate', num(rr)),
        ...when('spo2', num(spo2)),
        ...when('gcsEye', num(eye)),
        ...(intubated ? {} : when('gcsVerbal', num(verbal))),
        ...when('gcsMotor', num(motor)),
        gcsIntubated: intubated,
        ...when('painScore', num(pain)),
        source: 'manual',
      }),
    onSuccess: () => {
      setHr('');
      setSbp('');
      setDbp('');
      setRr('');
      setSpo2('');
      setPain('');
      refresh();
    },
  });

  const intervention = useMutation({
    mutationFn: () => recordIntervention(tripId, { at: new Date().toISOString(), type: ivType }),
    onSuccess: refresh,
  });

  const drug = useMutation({
    mutationFn: () =>
      recordDrug(tripId, {
        at: new Date().toISOString(),
        drugName: drugName.trim(),
        dose: num(dose) ?? 0,
        unit,
        route,
        isControlled: controlled,
        ...(registerRef.trim() === '' ? {} : { registerRef: registerRef.trim() }),
      }),
    onSuccess: () => {
      setDrugName('');
      setDose('');
      setControlled(false);
      setRegisterRef('');
      refresh();
    },
  });

  const sign = useMutation({
    mutationFn: () => signPcr(tripId),
    onSuccess: () => {
      refresh();
      publish({ title: 'Record signed', description: 'The trip can close now.', severity: 'success' });
    },
  });

  const prealert = useMutation({
    mutationFn: () => {
      const eta = num(etaMinutes) ?? 10;
      return raisePrealert(tripId, {
        pathway,
        etaAt: new Date(Date.now() + eta * 60_000).toISOString(),
        atmist: {
          age: atmistAge.trim(),
          mechanism: atmistMech.trim(),
          injuries: atmistInj.trim(),
          signs: latestSigns(),
          treatment: atmistTx.trim(),
        },
      });
    },
    onSuccess: () => {
      refresh();
      publish({
        title: 'Pre-alert sent',
        description: 'The ER board now shows this patient inbound, with an ETA.',
        severity: 'success',
      });
    },
  });

  const handover = useMutation({
    mutationFn: () =>
      completeHandover(tripId, {
        receiverUserId: receiverId.trim(),
        controlledDrugReconciled: reconciled,
        carryVitalsIntoTriage: carry,
        ...when('ageYears', num(ageYears)),
      }),
    onSuccess: (result) => {
      refresh();
      publish({
        title: 'Handover complete',
        description:
          result.pcr?.handover?.vitalsCarriedTriageId === null ||
          result.pcr?.handover?.vitalsCarriedTriageId === undefined
            ? 'The patient is the department’s.'
            : 'The road observations are in the triage record. Nothing was retyped.',
        severity: 'success',
      });
    },
  });

  /** The ATMIST "signs" line, built from what was actually recorded. */
  function latestSigns(): string {
    const v = pcr?.vitals[pcr.vitals.length - 1];
    if (v === undefined) return 'No observations recorded';
    return [
      v.heartRate === null ? null : `HR ${String(v.heartRate)}`,
      v.systolicBp === null ? null : `SBP ${String(v.systolicBp)}`,
      v.respiratoryRate === null ? null : `RR ${String(v.respiratoryRate)}`,
      v.spo2 === null ? null : `SpO₂ ${String(v.spo2)}`,
      v.gcsDisplay === null ? null : `GCS ${v.gcsDisplay}`,
    ]
      .filter((x) => x !== null)
      .join(' ');
  }

  if (tripId === '') {
    return (
      <section className="flex flex-col gap-5">
        <PageHeader title="Pre-hospital record" description="Open a trip from the dispatch board." />
        <EmptyState
          cause="No trip was named in the address."
          nextAction="Choose one from the dispatch board."
        />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title={data === null ? 'Pre-hospital record' : data.trip.tripNo}
        description="Observations, interventions, drugs, the pre-alert and the handover. Nothing here can be edited once written."
      />

      <AsyncPanel
        loading={detail.isPending}
        error={detail.error}
        isEmpty={false}
        skeletonLabel="Loading the trip"
        skeletonRows={5}
        onRetry={refresh}
        empty={null}
      >
        {data === null ? null : (
          <div className="flex flex-col gap-5">
            <div className="rounded-lg border border-strong bg-layer-1 p-4">
              <p className="flex flex-wrap items-center gap-2 text-base font-medium">
                {data.trip.fleetCode ?? '—'}
                <Badge tone="neutral">{data.trip.status.replace(/_/gu, ' ')}</Badge>
                {pcr?.signedByEmtAt === null || pcr === null ? (
                  <Badge tone="warning">record unsigned</Badge>
                ) : (
                  <Badge tone="success">signed</Badge>
                )}
              </p>
              <p className="mt-1 text-2xs text-fg-muted">
                {data.trip.responseMinutes === null
                  ? 'Not yet at scene'
                  : `Response ${String(data.trip.responseMinutes)} min`}
                {data.trip.offloadMinutes === null
                  ? ''
                  : ` · offload ${String(data.trip.offloadMinutes)} min`}
              </p>
              {pcr?.suggestedActivation == null ? null : (
                <p className="mt-2 text-sm">
                  <Badge tone="danger">
                    field criteria suggest {pcr.suggestedActivation.tier.replace('_', ' ')}
                  </Badge>{' '}
                  <span className="text-2xs text-fg-muted">
                    {pcr.suggestedActivation.criteria.map((c) => c.replace(/_/gu, ' ')).join(', ')}
                  </span>
                </p>
              )}
            </div>

            {pcr === null ? (
              <div className="flex flex-col gap-2">
                <EmptyState
                  cause="No patient care record has been opened for this trip."
                  nextAction="Open one before recording observations. A trip carrying nobody does not need one."
                />
                {canWrite ? (
                  <div>
                    <Button
                      type="button"
                      disabled={start.isPending}
                      onClick={() => {
                        start.mutate();
                      }}
                    >
                      Open the record
                    </Button>
                  </div>
                ) : null}
                {start.error === null ? null : <ProblemCard error={start.error} />}
              </div>
            ) : (
              <>
                {/* ── Observations ──────────────────────────────────────── */}
                <div className="flex flex-col gap-2">
                  <h2 className="text-sm font-medium">Observations</h2>
                  {vitals.error === null ? null : <ProblemCard error={vitals.error} />}
                  {pcr.vitals.length === 0 ? (
                    <EmptyState
                      cause="No observations recorded yet."
                      nextAction="A trip cannot close without at least one set, or the reason none could be taken."
                    />
                  ) : (
                    <div className="overflow-x-auto rounded-lg border border-strong bg-layer-1">
                      <table className="w-full text-sm" data-testid="ph-vitals">
                        <caption className="sr-only">Pre-hospital observations</caption>
                        <thead>
                          <tr className="border-b border-default text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                            {['Time', 'HR', 'BP', 'RR', 'SpO₂', 'GCS', 'Pain', 'Source'].map((h) => (
                              <th key={h} scope="col" className="px-3 py-2 text-start">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {pcr.vitals.map((v) => (
                            <tr
                              key={v.id}
                              className="border-b border-default last:border-0 font-mono text-2xs"
                            >
                              <td className="px-3 py-2">{new Date(v.at).toLocaleTimeString()}</td>
                              <td className="px-3 py-2">{v.heartRate ?? '—'}</td>
                              <td className="px-3 py-2">
                                {v.systolicBp ?? '—'}/{v.diastolicBp ?? '—'}
                              </td>
                              <td className="px-3 py-2">{v.respiratoryRate ?? '—'}</td>
                              <td className="px-3 py-2">{v.spo2 ?? '—'}</td>
                              <td className="px-3 py-2">{v.gcsDisplay ?? '—'}</td>
                              <td className="px-3 py-2">{v.painScore ?? '—'}</td>
                              <td className="px-3 py-2">{v.source}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {canWrite ? (
                    <form
                      className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-strong p-3"
                      data-testid="vitals-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        vitals.mutate();
                      }}
                    >
                      {(
                        [
                          { id: 'hr', label: 'HR', v: hr, set: setHr },
                          { id: 'sbp', label: 'SBP', v: sbp, set: setSbp },
                          { id: 'dbp', label: 'DBP', v: dbp, set: setDbp },
                          { id: 'rr', label: 'RR', v: rr, set: setRr },
                          { id: 'spo2', label: 'SpO₂', v: spo2, set: setSpo2 },
                          { id: 'pain', label: 'Pain', v: pain, set: setPain },
                        ] as const
                      ).map((f) => (
                        <div key={f.id} className="flex w-20 flex-col gap-1">
                          <Label htmlFor={`ph-${f.id}`}>{f.label}</Label>
                          <Input
                            id={`ph-${f.id}`}
                            data-testid={`ph-${f.id}`}
                            inputMode="numeric"
                            value={f.v}
                            onChange={(e) => {
                              f.set(e.target.value);
                            }}
                          />
                        </div>
                      ))}
                      {(
                        [
                          { id: 'eye', label: 'E', v: eye, set: setEye, max: 4, off: false },
                          { id: 'verbal', label: 'V', v: verbal, set: setVerbal, max: 5, off: intubated },
                          { id: 'motor', label: 'M', v: motor, set: setMotor, max: 6, off: false },
                        ] as const
                      ).map((g) => (
                        <div key={g.id} className="flex w-16 flex-col gap-1">
                          <Label htmlFor={`ph-${g.id}`}>{g.label}</Label>
                          <Input
                            id={`ph-${g.id}`}
                            inputMode="numeric"
                            disabled={g.off}
                            value={g.v}
                            onChange={(e) => {
                              g.set(e.target.value);
                            }}
                          />
                        </div>
                      ))}
                      <label className="flex items-center gap-2 text-2xs">
                        <input
                          type="checkbox"
                          className="size-5"
                          checked={intubated}
                          onChange={(e) => {
                            setIntubated(e.target.checked);
                          }}
                        />
                        intubated
                      </label>
                      <Button type="submit" disabled={vitals.isPending}>
                        Record
                      </Button>
                    </form>
                  ) : null}
                </div>

                {/* ── Interventions and drugs ───────────────────────────── */}
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="flex flex-col gap-2">
                    <h2 className="text-sm font-medium">Interventions</h2>
                    {intervention.error === null ? null : <ProblemCard error={intervention.error} />}
                    <ul className="flex flex-col gap-1 text-sm" data-testid="ph-interventions">
                      {pcr.interventions.map((i) => (
                        <li
                          key={i.id}
                          className="rounded-md border border-default px-3 py-1.5 font-mono text-2xs"
                        >
                          {new Date(i.at).toLocaleTimeString()} · {i.type.replace(/_/gu, ' ')}
                          {/*
                            Signed, not prefixed with `+`. An intervention can
                            legitimately precede the recorded patient-contact
                            time — the crew treats first and charts when a hand
                            is free — and "+-9 min" is what a blind prefix
                            produces.
                          */}
                          {i.minutesFromContact === null
                            ? ''
                            : i.minutesFromContact >= 0
                              ? ` · +${String(i.minutesFromContact)} min from contact`
                              : ` · ${String(Math.abs(i.minutesFromContact))} min before contact`}
                        </li>
                      ))}
                    </ul>
                    {canWrite ? (
                      <form
                        className="flex flex-wrap items-end gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          intervention.mutate();
                        }}
                      >
                        <div className="flex min-w-52 flex-1 flex-col gap-1">
                          <Label htmlFor="ph-intervention">What was done</Label>
                          <select
                            id="ph-intervention"
                            className={selectClass}
                            value={ivType}
                            onChange={(e) => {
                              setIvType(e.target.value);
                            }}
                          >
                            {INTERVENTIONS.map((t) => (
                              <option key={t} value={t}>
                                {t.replace(/_/gu, ' ')}
                              </option>
                            ))}
                          </select>
                        </div>
                        <Button type="submit" disabled={intervention.isPending}>
                          Record
                        </Button>
                      </form>
                    ) : null}
                  </div>

                  <div className="flex flex-col gap-2">
                    <h2 className="text-sm font-medium">Drugs</h2>
                    {drug.error === null ? null : <ProblemCard error={drug.error} />}
                    <ul className="flex flex-col gap-1 text-sm" data-testid="ph-drugs">
                      {pcr.drugs.map((d) => (
                        <li key={d.id} className="rounded-md border border-default px-3 py-1.5 text-2xs">
                          <span className="font-mono">{new Date(d.at).toLocaleTimeString()}</span>{' '}
                          {d.drugName} {d.dose} {d.unit} {d.route}
                          {d.isControlled ? <Badge tone="danger">controlled</Badge> : null}
                        </li>
                      ))}
                    </ul>
                    {canWrite ? (
                      <form
                        className="flex flex-wrap items-end gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          drug.mutate();
                        }}
                      >
                        <div className="flex min-w-40 flex-1 flex-col gap-1">
                          <Label htmlFor="ph-drug">Drug</Label>
                          <Input
                            id="ph-drug"
                            value={drugName}
                            autoComplete="off"
                            onChange={(e) => {
                              setDrugName(e.target.value);
                            }}
                          />
                        </div>
                        <div className="flex w-20 flex-col gap-1">
                          <Label htmlFor="ph-dose">Dose</Label>
                          <Input
                            id="ph-dose"
                            inputMode="decimal"
                            value={dose}
                            onChange={(e) => {
                              setDose(e.target.value);
                            }}
                          />
                        </div>
                        <div className="flex w-20 flex-col gap-1">
                          <Label htmlFor="ph-unit">Unit</Label>
                          <Input
                            id="ph-unit"
                            value={unit}
                            onChange={(e) => {
                              setUnit(e.target.value);
                            }}
                          />
                        </div>
                        <div className="flex w-20 flex-col gap-1">
                          <Label htmlFor="ph-route">Route</Label>
                          <Input
                            id="ph-route"
                            value={route}
                            onChange={(e) => {
                              setRoute(e.target.value);
                            }}
                          />
                        </div>
                        <label className="flex items-center gap-2 text-2xs">
                          <input
                            type="checkbox"
                            className="size-5"
                            checked={controlled}
                            onChange={(e) => {
                              setControlled(e.target.checked);
                            }}
                          />
                          controlled
                        </label>
                        {controlled ? (
                          <div className="flex w-44 flex-col gap-1">
                            <Label htmlFor="ph-register">Register ref</Label>
                            <Input
                              id="ph-register"
                              value={registerRef}
                              onChange={(e) => {
                                setRegisterRef(e.target.value);
                              }}
                            />
                          </div>
                        ) : null}
                        <Button type="submit" disabled={drugName.trim().length < 2 || drug.isPending}>
                          Record
                        </Button>
                      </form>
                    ) : null}
                  </div>
                </div>

                {/* ── The pre-alert ─────────────────────────────────────── */}
                <div className="flex flex-col gap-2">
                  <h2 className="text-sm font-medium">Pre-alert</h2>
                  {prealert.error === null ? null : <ProblemCard error={prealert.error} />}
                  {pcr.prealerts.length === 0 ? null : (
                    <ul className="flex flex-col gap-1 text-sm">
                      {pcr.prealerts.map((a) => (
                        <li key={a.id} className="rounded-md border border-default px-3 py-2">
                          <Badge tone={a.status === 'acknowledged' ? 'success' : 'warning'}>{a.status}</Badge>{' '}
                          {a.pathway}
                          {a.secondsToAcknowledge === null ? null : (
                            <span className="ms-2 text-2xs text-fg-subtle">
                              answered in {a.secondsToAcknowledge}s (target 120)
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {canPrealert && pcr.prealerts.length === 0 ? (
                    <form
                      className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-strong p-3"
                      data-testid="prealert-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        prealert.mutate();
                      }}
                    >
                      <div className="flex w-36 flex-col gap-1">
                        <Label htmlFor="pa-pathway">Pathway</Label>
                        <select
                          id="pa-pathway"
                          className={selectClass}
                          value={pathway}
                          onChange={(e) => {
                            setPathway(e.target.value);
                          }}
                        >
                          {PATHWAYS.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex w-24 flex-col gap-1">
                        <Label htmlFor="pa-eta">ETA min</Label>
                        <Input
                          id="pa-eta"
                          inputMode="numeric"
                          value={etaMinutes}
                          onChange={(e) => {
                            setEtaMinutes(e.target.value);
                          }}
                        />
                      </div>
                      <div className="flex w-40 flex-col gap-1">
                        <Label htmlFor="pa-age">A — age</Label>
                        <Input
                          id="pa-age"
                          value={atmistAge}
                          autoComplete="off"
                          placeholder="approx 32, male"
                          onChange={(e) => {
                            setAtmistAge(e.target.value);
                          }}
                        />
                      </div>
                      <div className="flex min-w-64 flex-1 flex-col gap-1">
                        <Label htmlFor="pa-mech">M — mechanism</Label>
                        <Input
                          id="pa-mech"
                          value={atmistMech}
                          autoComplete="off"
                          onChange={(e) => {
                            setAtmistMech(e.target.value);
                          }}
                        />
                      </div>
                      <div className="flex min-w-64 flex-1 flex-col gap-1">
                        <Label htmlFor="pa-inj">I — injuries</Label>
                        <Input
                          id="pa-inj"
                          value={atmistInj}
                          autoComplete="off"
                          onChange={(e) => {
                            setAtmistInj(e.target.value);
                          }}
                        />
                      </div>
                      <div className="flex min-w-64 flex-1 flex-col gap-1">
                        <Label htmlFor="pa-tx">T — treatment</Label>
                        <Input
                          id="pa-tx"
                          value={atmistTx}
                          autoComplete="off"
                          onChange={(e) => {
                            setAtmistTx(e.target.value);
                          }}
                        />
                      </div>
                      <p className="w-full text-2xs text-fg-subtle">
                        S — signs is filled from the last observation set: <strong>{latestSigns()}</strong>.
                        It is not retyped, so the ER reads the numbers that were actually recorded.
                      </p>
                      <Button
                        type="submit"
                        variant="danger"
                        disabled={atmistAge.trim() === '' || atmistMech.trim() === '' || prealert.isPending}
                      >
                        Send the pre-alert
                      </Button>
                    </form>
                  ) : null}
                </div>

                {/* ── Sign and hand over ────────────────────────────────── */}
                <div className="flex flex-col gap-2">
                  <h2 className="text-sm font-medium">Sign and hand over</h2>
                  {sign.error === null ? null : <ProblemCard error={sign.error} />}
                  {handover.error === null ? null : <ProblemCard error={handover.error} />}

                  {pcr.handover?.completedAt == null ? null : (
                    <p className="rounded-md border border-strong bg-layer-1 p-3 text-sm">
                      Handed over at {new Date(pcr.handover.completedAt).toLocaleTimeString()} · offload{' '}
                      {pcr.handover.offloadMinutes ?? '—'} min ·{' '}
                      {pcr.handover.vitalsCarriedTriageId === null
                        ? 'observations not carried'
                        : 'observations carried into the triage record'}
                    </p>
                  )}

                  {canHandover && pcr.handover?.completedAt == null ? (
                    <form
                      className="flex flex-wrap items-end gap-3 rounded-lg border border-dashed border-strong p-3"
                      data-testid="handover-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        handover.mutate();
                      }}
                    >
                      <div className="flex min-w-72 flex-1 flex-col gap-1">
                        <Label htmlFor="ho-receiver">Receiving clinician</Label>
                        <Input
                          id="ho-receiver"
                          value={receiverId}
                          autoComplete="off"
                          placeholder="User id of the nurse or doctor taking over"
                          onChange={(e) => {
                            setReceiverId(e.target.value);
                          }}
                        />
                      </div>
                      <div className="flex w-24 flex-col gap-1">
                        <Label htmlFor="ho-age">Age</Label>
                        <Input
                          id="ho-age"
                          inputMode="numeric"
                          value={ageYears}
                          onChange={(e) => {
                            setAgeYears(e.target.value);
                          }}
                        />
                      </div>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="size-5"
                          checked={carry}
                          onChange={(e) => {
                            setCarry(e.target.checked);
                          }}
                        />
                        Carry the last observations into triage
                      </label>
                      {pcr.drugs.some((d) => d.isControlled) ? (
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="size-5"
                            checked={reconciled}
                            onChange={(e) => {
                              setReconciled(e.target.checked);
                            }}
                          />
                          Controlled drug register reconciled
                        </label>
                      ) : null}
                      <Button type="submit" disabled={receiverId.trim() === '' || handover.isPending}>
                        Complete the handover
                      </Button>
                      <p className="w-full text-2xs text-fg-subtle">
                        The carried set becomes the first triage record with <em>no level</em> — assigning one
                        is the receiving nurse&rsquo;s act, and the crew never recorded the ESI decision
                        points. The nurse triages from it, and both records survive.
                      </p>
                    </form>
                  ) : null}

                  {canSign && pcr.signedByEmtAt === null ? (
                    <div>
                      <Button
                        type="button"
                        disabled={sign.isPending}
                        onClick={() => {
                          sign.mutate();
                        }}
                      >
                        Sign the record
                      </Button>
                      <p className="mt-1 text-2xs text-fg-subtle">
                        An unsigned record is a draft, and the trip cannot close on one.
                      </p>
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </div>
        )}
      </AsyncPanel>
    </section>
  );
}
