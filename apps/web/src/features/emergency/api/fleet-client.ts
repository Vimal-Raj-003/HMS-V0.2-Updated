import { newIdempotencyKey, queryString, request } from './http';
import type {
  DispatchBoardView,
  FleetRequestView,
  FleetVehicleView,
  PrealertView,
  TripDetailView,
} from './fleet-types';

/**
 * Every call NC-013 and TR-009 make.
 *
 * Two vocabularies, one trip: the dispatch console speaks of vehicles and
 * milestones, the crew's tablet speaks of observations and handovers, and both
 * write the same `ops.fleet_trips` row.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}
function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}
interface PageOf<T> {
  readonly items: readonly T[];
}

// ── The dispatch console ─────────────────────────────────────────────────────

export async function getDispatchBoard(
  filters: { readonly includeClosed?: boolean } = {},
  options: Signal = {},
): Promise<DispatchBoardView> {
  return request(
    `${V1}/fleet/board${queryString({ includeClosed: filters.includeClosed, limit: 100 })}`,
    withSignal(options),
  );
}

export async function listVehicles(
  filters: { readonly status?: string; readonly type?: string } = {},
  options: Signal = {},
): Promise<PageOf<FleetVehicleView>> {
  return request(
    `${V1}/fleet/vehicles${queryString({ status: filters.status, type: filters.type, limit: 100 })}`,
    withSignal(options),
  );
}

export async function createRequest(
  body: {
    readonly source: string;
    readonly priority: string;
    readonly clinicalNeed: string;
    readonly pickup: { readonly address: string; readonly lat?: number; readonly lng?: number };
    readonly externalCaseId?: string;
  },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<FleetRequestView> {
  return request(`${V1}/fleet/requests`, { method: 'POST', body, idempotencyKey });
}

export async function dispatchTrip(
  body: {
    readonly requestId: string;
    readonly vehicleId: string;
    readonly crew: readonly { readonly crewId: string; readonly role: string; readonly name?: string }[];
  },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<TripDetailView> {
  return request(`${V1}/fleet/trips`, { method: 'POST', body, idempotencyKey });
}

export async function getTrip(id: string, options: Signal = {}): Promise<TripDetailView> {
  return request(`${V1}/fleet/trips/${id}`, withSignal(options));
}

export async function recordMilestone(
  tripId: string,
  body: { readonly milestone: string; readonly lat?: number; readonly lng?: number },
): Promise<TripDetailView> {
  return request(`${V1}/fleet/trips/${tripId}/milestone`, { method: 'POST', body });
}

export async function divertTrip(
  tripId: string,
  destinationExternal: string,
  reason: string,
): Promise<TripDetailView> {
  return request(`${V1}/fleet/trips/${tripId}/divert`, {
    method: 'POST',
    body: { destinationExternal },
    reason,
  });
}

export async function closeTrip(
  tripId: string,
  body: { readonly endOdometer: number; readonly waitingMinutes?: number; readonly remarks?: string },
): Promise<TripDetailView> {
  return request(`${V1}/fleet/trips/${tripId}/close`, { method: 'POST', body });
}

export async function recordChecklist(body: {
  readonly vehicleId: string;
  readonly kind: string;
  readonly responses: readonly {
    readonly item: string;
    readonly mandatory: boolean;
    readonly ok: boolean;
  }[];
}): Promise<FleetVehicleView> {
  return request(`${V1}/fleet/checklists`, { method: 'POST', body });
}

// ── The crew's tablet ────────────────────────────────────────────────────────

export async function getPrehospitalTrip(id: string, options: Signal = {}): Promise<TripDetailView> {
  return request(`${V1}/prehospital/trips/${id}`, withSignal(options));
}

export async function openPcr(
  body: Readonly<Record<string, unknown>> & { readonly tripId: string },
): Promise<TripDetailView> {
  return request(`${V1}/prehospital/records`, { method: 'POST', body });
}

export async function recordVitals(
  tripId: string,
  body: Readonly<Record<string, unknown>> & { readonly at: string },
): Promise<TripDetailView> {
  return request(`${V1}/prehospital/trips/${tripId}/vitals`, { method: 'POST', body });
}

export async function recordIntervention(
  tripId: string,
  body: { readonly at: string; readonly type: string; readonly performedBy?: string },
): Promise<TripDetailView> {
  return request(`${V1}/prehospital/trips/${tripId}/interventions`, { method: 'POST', body });
}

export async function recordDrug(
  tripId: string,
  body: {
    readonly at: string;
    readonly drugName: string;
    readonly dose: number;
    readonly unit: string;
    readonly route: string;
    readonly isControlled?: boolean;
    readonly registerRef?: string;
  },
): Promise<TripDetailView> {
  return request(`${V1}/prehospital/trips/${tripId}/drugs`, { method: 'POST', body });
}

export async function signPcr(tripId: string): Promise<TripDetailView> {
  return request(`${V1}/prehospital/trips/${tripId}/sign`, { method: 'POST', body: {} });
}

// ── Pre-alert and handover ───────────────────────────────────────────────────

export async function getInbound(options: Signal = {}): Promise<PageOf<PrealertView>> {
  return request(`${V1}/prehospital/inbound`, withSignal(options));
}

export async function raisePrealert(
  tripId: string,
  body: {
    readonly pathway: string;
    readonly etaAt?: string;
    readonly atmist: {
      readonly age: string;
      readonly timeOfIncident?: string;
      readonly mechanism: string;
      readonly injuries: string;
      readonly signs: string;
      readonly treatment: string;
    };
  },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<TripDetailView> {
  return request(`${V1}/prehospital/trips/${tripId}/prealert`, { method: 'POST', body, idempotencyKey });
}

export async function acknowledgePrealert(
  id: string,
  body: { readonly bayId?: string } = {},
): Promise<PrealertView> {
  return request(`${V1}/prehospital/prealerts/${id}/acknowledge`, { method: 'POST', body });
}

export async function standDownPrealert(id: string, reason: string): Promise<PrealertView> {
  return request(`${V1}/prehospital/prealerts/${id}/stand-down`, { method: 'POST', body: {}, reason });
}

export async function divertPrealert(id: string, divertedTo: string, reason: string): Promise<PrealertView> {
  return request(`${V1}/prehospital/prealerts/${id}/divert`, {
    method: 'POST',
    body: { divertedTo },
    reason,
  });
}

export async function completeHandover(
  tripId: string,
  body: {
    readonly receiverUserId: string;
    readonly erVisitId?: string;
    readonly mciTagNo?: string;
    readonly controlledDrugReconciled: boolean;
    readonly carryVitalsIntoTriage?: boolean;
    readonly ageYears?: number;
    readonly discrepancies?: string;
  },
): Promise<TripDetailView> {
  return request(`${V1}/prehospital/trips/${tripId}/handover`, { method: 'POST', body });
}
