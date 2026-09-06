import { newIdempotencyKey, queryString, request } from './http';
import type { ErBayView, ErBoardView, ErVisitDetailView } from './types';

/**
 * Every call the ER board makes.
 *
 * `quickReg` sends an arrival mode and whatever else is known, which may be
 * nothing. That is the contract, not an oversight — see the controller note.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}

function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

export async function getBoard(
  filters: { readonly status?: string | undefined } = {},
  options: Signal = {},
): Promise<ErBoardView> {
  return request(`${V1}/er/board${queryString({ status: filters.status, limit: 200 })}`, withSignal(options));
}

export async function getErVisit(id: string, options: Signal = {}): Promise<ErVisitDetailView> {
  return request(`${V1}/er/visits/${id}`, withSignal(options));
}

/** The thirty-second path. Only `arrivalMode` is required. */
export async function quickReg(
  body: {
    readonly arrivalMode: string;
    readonly displayName?: string;
    readonly approximateAge?: number;
    readonly gender?: string;
    readonly chiefComplaint?: string;
    readonly broughtBy?: string;
    readonly mlcSuspected?: boolean;
    readonly bayId?: string;
  },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<ErVisitDetailView> {
  return request(`${V1}/er/visits`, { method: 'POST', body, idempotencyKey });
}

export async function assignBay(
  visitId: string,
  body: { readonly bayId: string; readonly method?: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<ErVisitDetailView> {
  return request(`${V1}/er/visits/${visitId}/bay`, { method: 'POST', body, idempotencyKey });
}

export async function updateErVisit(
  visitId: string,
  body: { readonly status?: string; readonly markFirstSeen?: boolean },
): Promise<ErVisitDetailView> {
  return request(`${V1}/er/visits/${visitId}`, { method: 'PATCH', body });
}

export async function markBayClean(body: { readonly bayId: string }): Promise<ErBayView> {
  return request(`${V1}/er/bays/clean`, { method: 'POST', body });
}
