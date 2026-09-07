import { newIdempotencyKey, queryString, request } from '@/features/specialty/api/http';
import type {
  DialyserUseRow,
  DialysisBoardRow,
  DialysisMachineRow,
  DialysisObservationRow,
  DialysisProgramRow,
  DialysisSessionDetail,
  DialysisSessionRow,
  VascularAccessRow,
} from './types';

/**
 * Every call the dialysis floor makes.
 *
 * ── Nothing here sends a zone, a rate, or a use number ──────────────────────
 *
 * All three are the database's, and each is the number a rule is a line on. And
 * there is no `forceMachine`: a hepatitis-positive patient is never correctly
 * placed on a general machine, so there is nothing for such a call to be for.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}
function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

export async function getBoard(options: Signal = {}): Promise<readonly DialysisBoardRow[]> {
  return request(`${V1}/dialysis/board`, withSignal(options));
}

export async function getMachines(options: Signal = {}): Promise<readonly DialysisMachineRow[]> {
  return request(`${V1}/dialysis/machines`, withSignal(options));
}

export async function getSessions(
  filters: { readonly on?: string; readonly liveOnly?: boolean; readonly machineId?: string } = {},
  options: Signal = {},
): Promise<readonly DialysisSessionRow[]> {
  return request(
    `${V1}/dialysis/sessions${queryString({
      on: filters.on,
      liveOnly: filters.liveOnly,
      machineId: filters.machineId,
    })}`,
    withSignal(options),
  );
}

export async function getSession(id: string, options: Signal = {}): Promise<DialysisSessionDetail> {
  return request(`${V1}/dialysis/sessions/${id}`, withSignal(options));
}

export async function getPrograms(
  filters: { readonly activeOnly?: boolean; readonly zone?: string } = {},
  options: Signal = {},
): Promise<readonly DialysisProgramRow[]> {
  return request(
    `${V1}/dialysis/programs${queryString({ activeOnly: filters.activeOnly, zone: filters.zone })}`,
    withSignal(options),
  );
}

export async function scheduleSession(body: Record<string, unknown>): Promise<DialysisSessionRow> {
  return request(`${V1}/dialysis/sessions`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function updateSession(id: string, body: Record<string, unknown>): Promise<DialysisSessionRow> {
  return request(`${V1}/dialysis/sessions/${id}`, { method: 'POST', body });
}

/** A different clinical fact from a cancellation, so it is its own call. */
export async function abortSession(
  id: string,
  body: { readonly reason: string; readonly actualUfL?: number },
): Promise<DialysisSessionRow> {
  return request(`${V1}/dialysis/sessions/${id}/abort`, {
    method: 'POST',
    body,
    reason: body.reason,
  });
}

export async function recordObservation(
  sessionId: string,
  body: Record<string, unknown>,
): Promise<DialysisObservationRow> {
  return request(`${V1}/dialysis/sessions/${sessionId}/observations`, { method: 'POST', body });
}

export async function setMachineStatus(
  id: string,
  body: { readonly status: string },
): Promise<DialysisMachineRow> {
  return request(`${V1}/dialysis/machines/${id}/status`, { method: 'POST', body });
}

/** A decommission and a re-commission. Refused while the machine holds a booking. */
export async function rezoneMachine(
  id: string,
  body: { readonly zone: string; readonly reason: string },
): Promise<DialysisMachineRow> {
  return request(`${V1}/dialysis/machines/${id}/rezone`, {
    method: 'POST',
    body,
    reason: body.reason,
  });
}

export async function getDialysers(
  filters: { readonly programId?: string; readonly usableOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly DialyserUseRow[]> {
  return request(
    `${V1}/dialysis/dialysers${queryString({
      programId: filters.programId,
      usableOnly: filters.usableOnly,
    })}`,
    withSignal(options),
  );
}

/** The use number is not sent. It is one more than the last one on that label. */
export async function logDialyserUse(body: {
  readonly programId: string;
  readonly label: string;
  readonly sessionId?: string;
}): Promise<DialyserUseRow> {
  return request(`${V1}/dialysis/dialysers`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function reprocessDialyser(
  id: string,
  body: { readonly tcvPct: number; readonly integrityOk: boolean; readonly chemical?: string },
): Promise<DialyserUseRow> {
  return request(`${V1}/dialysis/dialysers/${id}/reprocess`, { method: 'POST', body });
}

export async function updateAccess(
  id: string,
  body: { readonly status: string },
): Promise<VascularAccessRow> {
  return request(`${V1}/dialysis/accesses/${id}`, { method: 'POST', body });
}
