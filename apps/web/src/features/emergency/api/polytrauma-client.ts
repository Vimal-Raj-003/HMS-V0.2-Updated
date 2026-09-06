import { newIdempotencyKey, queryString, request } from './http';
import type { BoardCardView, BoardDetailView } from './polytrauma-types';

/**
 * Every call TR-007 makes.
 *
 * ── Two things this client cannot send ──────────────────────────────────────
 *
 * A consent state of `emergency_waiver` on the ordinary consent route, and a
 * single procedure move. The first has its own route behind its own key,
 * because a narrow permission reachable by sending a different field to the
 * wide route is not a permission. The second is a whole arrangement, because
 * "put the nail at 2" is ambiguous about what happens to whatever was at 2, and
 * resolving that on the server would mean guessing at a surgical decision.
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

export async function getBoards(
  filters: { readonly state?: string; readonly patientId?: string } = {},
  options: Signal = {},
): Promise<PageOf<BoardCardView>> {
  return request(
    `${V1}/polytrauma${queryString({ state: filters.state, patientId: filters.patientId, limit: 100 })}`,
    withSignal(options),
  );
}

export async function getBoard(id: string, options: Signal = {}): Promise<BoardDetailView> {
  return request(`${V1}/polytrauma/${id}`, withSignal(options));
}

export async function openBoard(body: {
  readonly patientId: string;
  readonly erVisitId?: string;
  readonly notes?: string;
}): Promise<BoardDetailView> {
  return request(`${V1}/polytrauma`, { method: 'POST', body, idempotencyKey: newIdempotencyKey() });
}

export async function closeBoard(
  id: string,
  body: { readonly outcome: string; readonly notes?: string },
): Promise<BoardDetailView> {
  return request(`${V1}/polytrauma/${id}/close`, { method: 'PATCH', body });
}

export interface PlanProcedureBody {
  readonly name: string;
  readonly specialty: string;
  readonly priority: string;
  readonly side?: string;
  readonly fractureId?: string;
  readonly estimatedMinutes?: number;
  readonly rationale?: string;
}

export async function planProcedure(id: string, body: PlanProcedureBody): Promise<BoardDetailView> {
  return request(`${V1}/polytrauma/${id}/procedures`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

/** The whole arrangement, and a reason. The server refuses one that breaks the class order. */
export async function resequence(
  id: string,
  order: readonly { readonly procedureId: string; readonly sequence: number }[],
  reason: string,
): Promise<BoardDetailView> {
  return request(`${V1}/polytrauma/${id}/sequence`, { method: 'PATCH', body: { order }, reason });
}

export async function setProcedureState(
  id: string,
  procedureId: string,
  body: { readonly state: string; readonly reason?: string; readonly surgeonId?: string },
): Promise<BoardDetailView> {
  return request(`${V1}/polytrauma/${id}/procedures/${procedureId}`, { method: 'PATCH', body });
}

export interface ConsentBody {
  readonly state: string;
  readonly signedBy?: string;
  readonly relationship?: string;
  readonly explainedLocale?: string;
  readonly risksDiscussed?: readonly string[];
  readonly witnessName?: string;
  readonly reason?: string;
}

export async function recordConsent(
  id: string,
  procedureId: string,
  body: ConsentBody,
): Promise<BoardDetailView> {
  return request(`${V1}/polytrauma/${id}/procedures/${procedureId}/consent`, { method: 'PATCH', body });
}

/** The waiver. Its own route, its own key, and the grounds are not optional. */
export async function recordWaiver(
  id: string,
  procedureId: string,
  body: {
    readonly reason: string;
    readonly witnessName?: string;
    readonly risksDiscussed?: readonly string[];
  },
  reason: string,
): Promise<BoardDetailView> {
  return request(`${V1}/polytrauma/${id}/procedures/${procedureId}/waiver`, {
    method: 'PATCH',
    body,
    reason,
  });
}

export async function planBlood(
  id: string,
  body: {
    readonly component: string;
    readonly unitsRequired: number;
    readonly unitsReserved?: number;
    readonly procedureId?: string;
    readonly crossmatchRef?: string;
    readonly mtpActivated?: boolean;
  },
): Promise<BoardDetailView> {
  return request(`${V1}/polytrauma/${id}/blood`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function updateBlood(
  id: string,
  bloodId: string,
  body: {
    readonly unitsReserved?: number;
    readonly unitsIssued?: number;
    readonly crossmatchRef?: string;
    readonly mtpActivated?: boolean;
  },
): Promise<BoardDetailView> {
  return request(`${V1}/polytrauma/${id}/blood/${bloodId}`, { method: 'PATCH', body });
}

export async function requestConsult(
  id: string,
  body: { readonly specialty: string; readonly question: string; readonly urgency: string },
): Promise<BoardDetailView> {
  return request(`${V1}/polytrauma/${id}/consults`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function respondToConsult(
  id: string,
  consultId: string,
  body: { readonly state: string; readonly advice?: string; readonly declineReason?: string },
): Promise<BoardDetailView> {
  return request(`${V1}/polytrauma/${id}/consults/${consultId}`, { method: 'PATCH', body });
}

/** The note is required only when the target has not been passed — the server decides. */
export async function escalateConsult(
  id: string,
  consultId: string,
  body: { readonly escalatedTo: string; readonly note?: string },
): Promise<BoardDetailView> {
  return request(`${V1}/polytrauma/${id}/consults/${consultId}/escalate`, { method: 'PATCH', body });
}

export async function addTask(
  id: string,
  body: { readonly title: string; readonly detail?: string; readonly blocking?: boolean },
): Promise<BoardDetailView> {
  return request(`${V1}/polytrauma/${id}/tasks`, { method: 'POST', body });
}

export async function completeTask(id: string, taskId: string): Promise<BoardDetailView> {
  return request(`${V1}/polytrauma/${id}/tasks/${taskId}`, { method: 'PATCH', body: {} });
}

export async function recordHuddle(
  id: string,
  body: {
    readonly specialties: readonly string[];
    readonly decisions: string;
    readonly concerns?: string;
  },
): Promise<BoardDetailView> {
  return request(`${V1}/polytrauma/${id}/huddles`, { method: 'POST', body });
}

export async function recordFamilyUpdate(
  id: string,
  body: {
    readonly spokeTo: string;
    readonly relationship?: string;
    readonly locale?: string;
    readonly summary: string;
    readonly prognosisDiscussed?: boolean;
  },
): Promise<BoardDetailView> {
  return request(`${V1}/polytrauma/${id}/family-updates`, { method: 'POST', body });
}
