import { newIdempotencyKey, queryString, request } from './http';
import type { ConsoleDetail, ConsoleRow, DeviceOrderRow, StageRow, WorklistRow } from './types';

/**
 * Every call the framework makes.
 *
 * `reviewResult` sends no body on purpose: the reviewer is whoever is signed
 * in, and the moment is the moment the request lands. A client that could name
 * the reviewer is a client that could name somebody else.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}
function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

export async function getConsoles(
  filters: { readonly activeOnly?: boolean; readonly departmentId?: string } = {},
  options: Signal = {},
): Promise<readonly ConsoleRow[]> {
  return request(
    `${V1}/specialty/consoles${queryString({
      activeOnly: filters.activeOnly,
      departmentId: filters.departmentId,
    })}`,
    withSignal(options),
  );
}

export async function getConsole(code: string, options: Signal = {}): Promise<ConsoleDetail> {
  return request(`${V1}/specialty/consoles/${code}`, withSignal(options));
}

export async function registerConsole(body: Readonly<Record<string, unknown>>): Promise<ConsoleRow> {
  return request(`${V1}/specialty/consoles`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function updateConsole(
  id: string,
  body: Readonly<Record<string, unknown>>,
): Promise<ConsoleRow> {
  return request(`${V1}/specialty/consoles/${id}`, { method: 'PATCH', body });
}

export async function getWorklist(
  filters: { readonly consoleCode: string; readonly stageKey?: string; readonly openOnly?: boolean },
  options: Signal = {},
): Promise<readonly WorklistRow[]> {
  return request(
    `${V1}/specialty/worklist${queryString({
      consoleCode: filters.consoleCode,
      stageKey: filters.stageKey,
      openOnly: filters.openOnly,
    })}`,
    withSignal(options),
  );
}

export async function moveStage(body: {
  readonly encounterId: string;
  readonly patientId: string;
  readonly consoleCode: string;
  readonly stageKey: string;
  readonly note?: string;
}): Promise<StageRow> {
  return request(`${V1}/specialty/stages`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function getStages(encounterId: string, options: Signal = {}): Promise<readonly StageRow[]> {
  return request(`${V1}/specialty/stages/${encounterId}`, withSignal(options));
}

export async function getDeviceOrders(
  filters: {
    readonly encounterId?: string;
    readonly consoleCode?: string;
    readonly unreviewedOnly?: boolean;
  } = {},
  options: Signal = {},
): Promise<readonly DeviceOrderRow[]> {
  return request(
    `${V1}/specialty/device-orders${queryString({
      encounterId: filters.encounterId,
      consoleCode: filters.consoleCode,
      unreviewedOnly: filters.unreviewedOnly,
    })}`,
    withSignal(options),
  );
}

export async function orderDeviceResult(body: {
  readonly patientId: string;
  readonly encounterId: string;
  readonly deviceResultTypeCode: string;
  readonly side?: string;
}): Promise<DeviceOrderRow> {
  return request(`${V1}/specialty/device-orders`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function attachDeviceResult(
  id: string,
  body: {
    readonly pacsStudyUid?: string;
    readonly resultFileId?: string;
    readonly parsed?: Record<string, unknown>;
  },
): Promise<DeviceOrderRow> {
  return request(`${V1}/specialty/device-orders/${id}/attach`, { method: 'PATCH', body });
}

/** No body. The reviewer is the caller and the moment is now. */
export async function reviewDeviceResult(id: string): Promise<DeviceOrderRow> {
  return request(`${V1}/specialty/device-orders/${id}/review`, { method: 'PATCH', body: {} });
}

export async function cancelDeviceOrder(id: string, reason: string): Promise<DeviceOrderRow> {
  return request(`${V1}/specialty/device-orders/${id}/cancel`, {
    method: 'POST',
    body: { reason },
    idempotencyKey: newIdempotencyKey(),
  });
}
