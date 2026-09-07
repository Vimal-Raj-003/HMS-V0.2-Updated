import { newIdempotencyKey, queryString, request } from './http';
import type {
  AdministrationRow,
  BookingRow,
  ChecklistRow,
  DressingRow,
  OrderDetail,
  OrderRow,
  ProcedureRow,
  RecoveryRow,
  RoomRow,
  TaskRow,
  TimeoutRow,
} from './types';

/**
 * Every call the procedure board and the nursing rooms make.
 *
 * There is no `startWithoutConsent`, and there is no consent endpoint that
 * creates one — `recordConsent` attaches an EN-028 document that already
 * exists. The checklist override is here because it is a real clinical act.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}
function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

export async function getRooms(options: Signal = {}): Promise<readonly RoomRow[]> {
  return request(`${V1}/procedures/rooms`, withSignal(options));
}

export async function getOrders(
  filters: { readonly openOnly?: boolean; readonly status?: string } = {},
  options: Signal = {},
): Promise<readonly OrderRow[]> {
  return request(
    `${V1}/procedures/orders${queryString({ openOnly: filters.openOnly, status: filters.status })}`,
    withSignal(options),
  );
}

export async function getOrder(id: string, options: Signal = {}): Promise<OrderDetail> {
  return request(`${V1}/procedures/orders/${id}`, withSignal(options));
}

export async function orderProcedure(body: Readonly<Record<string, unknown>>): Promise<OrderRow> {
  return request(`${V1}/procedures/orders`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function recordConsent(id: string, consentId: string): Promise<OrderRow> {
  return request(`${V1}/procedures/orders/${id}/consent`, { method: 'PATCH', body: { consentId } });
}

export async function book(
  id: string,
  body: { readonly roomId: string; readonly startAt: string; readonly endAt: string },
): Promise<BookingRow> {
  return request(`${V1}/procedures/orders/${id}/bookings`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function saveChecklist(
  id: string,
  body: Readonly<Record<string, unknown>>,
): Promise<ChecklistRow> {
  return request(`${V1}/procedures/orders/${id}/checklist`, { method: 'POST', body });
}

export async function overrideChecklist(id: string, reason: string): Promise<ChecklistRow> {
  return request(`${V1}/procedures/orders/${id}/checklist/override`, { method: 'POST', body: { reason } });
}

/** The caller is the first confirmer; the request names the second. */
export async function confirmTimeout(id: string, confirmedBy2: string): Promise<TimeoutRow> {
  return request(`${V1}/procedures/orders/${id}/timeout`, {
    method: 'POST',
    body: {
      confirmedBy2,
      patientOk: true,
      procedureOk: true,
      sideOk: true,
      consentOk: true,
      allergyOk: true,
    },
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function startProcedure(
  id: string,
  body: { readonly anaesthesia: string; readonly anaesthetistId?: string },
): Promise<ProcedureRow> {
  return request(`${V1}/procedures/orders/${id}/start`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function completeProcedure(
  id: string,
  body: Readonly<Record<string, unknown>>,
): Promise<ProcedureRow> {
  return request(`${V1}/procedures/${id}/complete`, { method: 'PATCH', body });
}

export async function signProcedure(id: string): Promise<ProcedureRow> {
  return request(`${V1}/procedures/${id}/sign`, {
    method: 'POST',
    body: {},
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function recordRecovery(
  id: string,
  body: Readonly<Record<string, unknown>>,
): Promise<RecoveryRow> {
  return request(`${V1}/procedures/${id}/recovery`, { method: 'POST', body });
}

export async function getTasks(
  filters: { readonly roomType?: string; readonly openOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly TaskRow[]> {
  return request(
    `${V1}/opd-nursing/tasks${queryString({ roomType: filters.roomType, openOnly: filters.openOnly })}`,
    withSignal(options),
  );
}

export async function createTask(body: Readonly<Record<string, unknown>>): Promise<TaskRow> {
  return request(`${V1}/opd-nursing/tasks`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function setTaskStatus(
  id: string,
  body: { readonly status: string; readonly reason?: string },
): Promise<TaskRow> {
  return request(`${V1}/opd-nursing/tasks/${id}/status`, { method: 'PATCH', body });
}

export async function administer(
  id: string,
  body: Readonly<Record<string, unknown>>,
): Promise<AdministrationRow> {
  return request(`${V1}/opd-nursing/tasks/${id}/administer`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function closeObservation(
  id: string,
  body: { readonly outcome: string; readonly reaction?: Record<string, unknown> },
): Promise<AdministrationRow> {
  return request(`${V1}/opd-nursing/administrations/${id}/observation`, { method: 'PATCH', body });
}

export async function recordDressing(
  id: string,
  body: Readonly<Record<string, unknown>>,
): Promise<DressingRow> {
  return request(`${V1}/opd-nursing/tasks/${id}/dressing`, { method: 'POST', body });
}
