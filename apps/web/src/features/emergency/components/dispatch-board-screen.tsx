'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Input, Label, useToast } from '@vims/ui';
import Link from 'next/link';
import { useState } from 'react';
import { AsyncPanel } from '@/features/admin/components/async-panel';
import { PageHeader } from '@/features/admin/components/page-header';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { createRequest, dispatchTrip, getDispatchBoard, recordMilestone } from '../api/fleet-client';
import type { FleetRequestView, FleetTripView, FleetVehicleView } from '../api/fleet-types';
import { erKeys } from '../api/keys';

const PRIORITY_TONE: Readonly<Record<string, 'danger' | 'warning' | 'neutral'>> = {
  emergency: 'danger',
  urgent: 'warning',
  scheduled: 'neutral',
};

const STATUS_TONE: Readonly<Record<string, 'success' | 'warning' | 'danger' | 'neutral'>> = {
  available: 'success',
  on_trip: 'warning',
  not_ready: 'warning',
  maintenance: 'neutral',
  breakdown: 'danger',
  out_of_service: 'danger',
  retired: 'neutral',
};

const SOURCES = [
  { value: 'ems_108', label: '108' },
  { value: 'ems_112', label: '112' },
  { value: 'er', label: 'ER' },
  { value: 'ward', label: 'Ward' },
  { value: 'ip_transfer', label: 'Transfer' },
  { value: 'discharge', label: 'Discharge' },
  { value: 'call_centre', label: 'Call centre' },
] as const;

const NEEDS = [
  { value: 'als', label: 'ALS' },
  { value: 'bls', label: 'BLS' },
  { value: 'patient_transport', label: 'Transport' },
  { value: 'neonatal', label: 'Neonatal' },
  { value: 'ventilator', label: 'Ventilator' },
] as const;

const NEXT_MILESTONE: Readonly<Record<string, { readonly value: string; readonly label: string }>> = {
  assigned: { value: 'en_route', label: 'En route' },
  en_route: { value: 'at_scene', label: 'At scene' },
  at_scene: { value: 'patient_onboard', label: 'Patient on board' },
  patient_onboard: { value: 'arrived_hospital', label: 'Arrived' },
};

const selectClass = 'h-10 rounded-md border border-control bg-layer-1 px-3 text-sm text-fg-default';

/**
 * NC-013 — the dispatch console.
 *
 * ── The greyed row is a courtesy ────────────────────────────────────────────
 *
 * A vehicle whose fitness certificate lapsed shows its blockers here so a
 * dispatcher does not press a button and get a refusal. The refusal is a
 * trigger on the trip table, and it stands whether or not this screen rendered:
 * driving an ambulance on expired papers is an offence, and it is the crew who
 * answer for it, not the console.
 *
 * ── 108 trips are marked free before anybody bills them ─────────────────────
 *
 * The badge is not decoration. A hospital posting a charge against a national
 * ambulance service call is a headline, so the queue says so on the row and the
 * database refuses the posting.
 */
export function DispatchBoardScreen(): React.JSX.Element {
  const { hospitalId, granted } = useSession();
  const keys = erKeys(hospitalId);
  const { publish } = useToast();

  const [showRequest, setShowRequest] = useState(false);
  const [source, setSource] = useState<string>('ems_108');
  const [need, setNeed] = useState<string>('als');
  const [priority, setPriority] = useState<string>('emergency');
  const [address, setAddress] = useState('');
  const [assigning, setAssigning] = useState<string | null>(null);

  const canRequest = granted.has('fleet.request.create');
  const canDispatch = granted.has('fleet.trip.dispatch');
  const canUpdate = granted.has('fleet.trip.update');

  const board = useQuery({
    queryKey: keys.dispatchBoard('live'),
    queryFn: ({ signal }) => getDispatchBoard({}, { signal }),
    // A dispatch board is a wall display. Stale is worse than blank.
    refetchInterval: 10_000,
  });

  const queue: readonly FleetRequestView[] = board.data?.queue ?? [];
  const trips: readonly FleetTripView[] = board.data?.trips ?? [];
  const vehicles: readonly FleetVehicleView[] = board.data?.vehicles ?? [];
  const inbound = board.data?.inbound ?? [];

  const raise = useMutation({
    mutationFn: () =>
      createRequest({
        source,
        priority,
        clinicalNeed: need,
        pickup: { address: address.trim() },
      }),
    onSuccess: () => {
      setAddress('');
      setShowRequest(false);
      void board.refetch();
    },
  });

  const assign = useMutation({
    mutationFn: (input: { readonly requestId: string; readonly vehicleId: string }) =>
      dispatchTrip({
        requestId: input.requestId,
        vehicleId: input.vehicleId,
        // A real console picks the rostered crew; this build assigns the
        // vehicle and lets the crew identify themselves on the tablet.
        crew: [{ crewId: input.vehicleId, role: 'driver' }],
      }),
    onSuccess: (detail) => {
      setAssigning(null);
      void board.refetch();
      publish({ title: `${detail.trip.tripNo} dispatched`, severity: 'success' });
    },
  });

  const milestone = useMutation({
    mutationFn: (input: { readonly tripId: string; readonly milestone: string }) =>
      recordMilestone(input.tripId, { milestone: input.milestone }),
    onSuccess: () => {
      void board.refetch();
    },
  });

  return (
    <section className="flex flex-col gap-5">
      <PageHeader
        title="Ambulance dispatch"
        description="What is waiting, what is out, and which vehicles can legally leave the yard."
      />

      {raise.error === null ? null : <ProblemCard error={raise.error} />}
      {assign.error === null ? null : <ProblemCard error={assign.error} />}
      {milestone.error === null ? null : <ProblemCard error={milestone.error} />}

      {canRequest ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            data-testid="open-request"
            onClick={() => {
              setShowRequest(!showRequest);
            }}
          >
            {showRequest ? 'Close' : 'Take a call'}
          </Button>
          <span className="text-2xs text-fg-subtle">
            108 and 112 calls are free at the point of use and are never billed to the patient.
          </span>
        </div>
      ) : null}

      {showRequest ? (
        <form
          className="flex flex-wrap items-end gap-3 rounded-lg border border-strong bg-layer-1 p-4"
          data-testid="request-form"
          onSubmit={(event) => {
            event.preventDefault();
            raise.mutate();
          }}
        >
          <div className="flex w-36 flex-col gap-1">
            <Label htmlFor="req-source">Source</Label>
            <select
              id="req-source"
              className={selectClass}
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
              }}
            >
              {SOURCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex w-36 flex-col gap-1">
            <Label htmlFor="req-need">Need</Label>
            <select
              id="req-need"
              className={selectClass}
              value={need}
              onChange={(e) => {
                setNeed(e.target.value);
              }}
            >
              {NEEDS.map((n) => (
                <option key={n.value} value={n.value}>
                  {n.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex w-36 flex-col gap-1">
            <Label htmlFor="req-priority">Priority</Label>
            <select
              id="req-priority"
              className={selectClass}
              value={priority}
              onChange={(e) => {
                setPriority(e.target.value);
              }}
            >
              <option value="emergency">Emergency</option>
              <option value="urgent">Urgent</option>
              <option value="scheduled">Scheduled</option>
            </select>
          </div>
          <div className="flex min-w-96 flex-1 flex-col gap-1">
            <Label htmlFor="req-address">Where</Label>
            <Input
              id="req-address"
              value={address}
              autoComplete="off"
              placeholder="Hosur Road service road, opposite Bommanahalli bus stand"
              onChange={(e) => {
                setAddress(e.target.value);
              }}
            />
          </div>
          <Button type="submit" disabled={address.trim().length < 4 || raise.isPending}>
            Queue it
          </Button>
        </form>
      ) : null}

      <AsyncPanel
        loading={board.isPending}
        error={board.error}
        isEmpty={false}
        skeletonLabel="Loading the dispatch board"
        skeletonRows={6}
        onRetry={() => {
          void board.refetch();
        }}
        empty={null}
      >
        <div className="flex flex-col gap-5">
          {/* ── Inbound to the ER ──────────────────────────────────────── */}
          {inbound.length === 0 ? null : (
            <div
              className="rounded-lg border-2 border-danger-border bg-danger-subtle p-4"
              data-testid="inbound"
            >
              <h2 className="text-sm font-medium">Inbound to the emergency department</h2>
              <ul className="mt-2 flex flex-col gap-1 text-sm">
                {inbound.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2">
                    <Badge tone={a.suggestedActivation === 'level_1' ? 'danger' : 'warning'}>
                      {a.pathway}
                    </Badge>
                    <span className="text-2xs text-fg-muted">
                      {a.etaMinutes === null
                        ? 'no ETA'
                        : a.etaMinutes >= 0
                          ? `ETA ${String(a.etaMinutes)} min`
                          : `${String(Math.abs(a.etaMinutes))} min overdue`}
                    </span>
                    <Badge tone={a.status === 'acknowledged' ? 'success' : 'warning'}>{a.status}</Badge>
                    {a.suggestedActivation === 'none' ? null : (
                      <span className="text-2xs">suggests {a.suggestedActivation.replace('_', ' ')}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ── The queue ──────────────────────────────────────────────── */}
          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">Waiting for a vehicle</h2>
            {queue.length === 0 ? (
              <EmptyState
                cause="Nothing is waiting."
                nextAction="Calls appear here the moment they are taken."
              />
            ) : (
              <ul className="flex flex-col gap-2" data-testid="dispatch-queue">
                {queue.map((r) => (
                  <li key={r.id} className="rounded-lg border border-strong bg-layer-1 p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge tone={PRIORITY_TONE[r.priority] ?? 'neutral'}>{r.priority}</Badge>
                        <Badge tone="neutral">{r.clinicalNeed.toUpperCase()}</Badge>
                        <span className="font-mono text-2xs">{r.requestNo}</span>
                        {r.freeAtPointOfUse ? <Badge tone="success">free at point of use</Badge> : null}
                        <span className="text-2xs text-fg-subtle">waiting {r.waitingMinutes} min</span>
                      </span>
                      {canDispatch ? (
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => {
                            setAssigning(assigning === r.id ? null : r.id);
                          }}
                        >
                          Assign
                        </Button>
                      ) : null}
                    </div>
                    <p className="mt-1 text-2xs text-fg-muted">
                      {typeof r.pickup === 'object' && r.pickup !== null && 'address' in r.pickup
                        ? String(r.pickup.address)
                        : '—'}
                    </p>

                    {assigning === r.id ? (
                      <ul className="mt-2 flex flex-wrap gap-2">
                        {vehicles.map((v) => (
                          <li key={v.id}>
                            <button
                              type="button"
                              disabled={!v.dispatchable || assign.isPending}
                              title={v.blockers.join('; ')}
                              className={`min-h-12 rounded-lg border px-3 text-sm ${
                                v.dispatchable
                                  ? 'border-default text-fg-default hover:bg-layer-2'
                                  : 'border-default text-fg-disabled'
                              }`}
                              onClick={() => {
                                assign.mutate({ requestId: r.id, vehicleId: v.id });
                              }}
                            >
                              <span className="block font-mono text-2xs">{v.fleetCode}</span>
                              <span className="block text-2xs">
                                {v.type.toUpperCase()} · {v.dispatchable ? 'ready' : v.blockers[0]}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ── Out now ────────────────────────────────────────────────── */}
          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">Out now</h2>
            {trips.length === 0 ? (
              <EmptyState cause="No ambulance is out." nextAction="Assign one from the queue above." />
            ) : (
              <ul className="flex flex-col gap-2" data-testid="dispatch-trips">
                {trips.map((t) => {
                  const next = NEXT_MILESTONE[t.status];
                  return (
                    <li key={t.id} className="rounded-lg border border-strong bg-layer-1 p-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-2xs">{t.tripNo}</span>
                          <Badge tone="neutral">{t.fleetCode ?? '—'}</Badge>
                          <Badge tone={t.status === 'completed' ? 'success' : 'warning'}>
                            {t.status.replace(/_/gu, ' ')}
                          </Badge>
                          <span className="text-2xs text-fg-subtle">
                            {t.elapsedMinutes} min out
                            {t.responseMinutes === null ? '' : ` · response ${String(t.responseMinutes)} min`}
                            {t.offloadMinutes === null ? '' : ` · offload ${String(t.offloadMinutes)} min`}
                          </span>
                          {t.distanceFlagged ? <Badge tone="warning">distance needs review</Badge> : null}
                        </span>
                        <span className="flex gap-2">
                          <Link
                            href={{ pathname: '/er/ambulance/trip', query: { id: t.id } }}
                            className="text-2xs text-fg-link underline-offset-2 hover:underline"
                          >
                            Open the record
                          </Link>
                          {canUpdate && next !== undefined ? (
                            <Button
                              type="button"
                              size="sm"
                              disabled={milestone.isPending}
                              onClick={() => {
                                milestone.mutate({ tripId: t.id, milestone: next.value });
                              }}
                            >
                              {next.label}
                            </Button>
                          ) : null}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* ── The fleet ──────────────────────────────────────────────── */}
          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">The fleet</h2>
            <ul className="flex flex-wrap gap-2" data-testid="fleet-list">
              {vehicles.map((v) => (
                <li
                  key={v.id}
                  className={`min-w-56 rounded-lg border p-3 text-sm ${
                    v.dispatchable ? 'border-strong bg-layer-1' : 'border-default bg-layer-2'
                  }`}
                >
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">{v.fleetCode}</span>
                    <Badge tone="neutral">{v.type.toUpperCase()}</Badge>
                    <Badge tone={STATUS_TONE[v.status] ?? 'neutral'}>{v.status.replace(/_/gu, ' ')}</Badge>
                  </p>
                  <p className="mt-1 font-mono text-2xs text-fg-subtle">{v.registrationNo}</p>
                  {v.blockers.length === 0 ? null : (
                    <ul className="mt-1 list-disc ps-4 text-2xs text-fg-muted">
                      {v.blockers.map((b) => (
                        <li key={b}>{b}</li>
                      ))}
                    </ul>
                  )}
                  {v.documents
                    .filter((d) => d.daysToExpiry !== null && d.daysToExpiry < 30)
                    .map((d) => (
                      <p key={d.id} className="mt-1 text-2xs">
                        <Badge tone={(d.daysToExpiry ?? 0) < 0 ? 'danger' : 'warning'}>
                          {`${d.type.replace(/_/gu, ' ')} ${
                            (d.daysToExpiry ?? 0) < 0
                              ? `expired ${String(Math.abs(d.daysToExpiry ?? 0))}d ago`
                              : `expires in ${String(d.daysToExpiry)}d`
                          }`}
                        </Badge>
                      </p>
                    ))}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </AsyncPanel>

      <p className="text-2xs text-fg-subtle">
        A vehicle whose mandatory papers have lapsed is greyed here and refused by the database. Driving it is
        an offence under the Motor Vehicles Act, and it is the crew who answer for it.
      </p>
    </section>
  );
}
