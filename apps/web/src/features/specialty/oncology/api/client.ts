import { queryString, request } from '@/features/specialty/api/http';
import type { ChemoCycleRow, CycleDetail, OncoCaseRow, OrderLineRow } from './types';

/**
 * Every call the oncology console makes.
 *
 * ── Nothing here sends a dose, a surface area or a route ────────────────────
 *
 * The dose is √(height × weight / 3600) times a figure from the library, and
 * the route is the library's. Intrathecal vincristine is uniformly fatal, and
 * the strongest thing this build can say about it is that no request in this
 * file can express it.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}
function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

export async function getCases(
  filters: { readonly activeOnly?: boolean; readonly nearingCapOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly OncoCaseRow[]> {
  return request(
    `${V1}/onco/cases${queryString({
      activeOnly: filters.activeOnly,
      nearingCapOnly: filters.nearingCapOnly,
    })}`,
    withSignal(options),
  );
}

export async function getCycles(
  filters: { readonly on?: string; readonly pendingPharmacyOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly ChemoCycleRow[]> {
  return request(
    `${V1}/onco/cycles${queryString({
      on: filters.on,
      pendingPharmacyOnly: filters.pendingPharmacyOnly,
    })}`,
    withSignal(options),
  );
}

export async function getCycle(id: string, options: Signal = {}): Promise<CycleDetail> {
  return request(`${V1}/onco/cycles/${id}`, withSignal(options));
}

/** The pharmacist's independent recalculation, and the ability to stop the line. */
export async function verifyLine(
  id: string,
  body: { readonly status: string; readonly notes?: string },
): Promise<OrderLineRow> {
  return request(`${V1}/onco/order-lines/${id}/verify`, { method: 'POST', body });
}

export async function signCycle(id: string, body: Record<string, unknown> = {}): Promise<CycleDetail> {
  return request(`${V1}/onco/cycles/${id}/sign`, { method: 'POST', body });
}

/** The second oncologist, taken from whoever is signed in rather than named. */
export async function cosignCycle(id: string, reason: string): Promise<CycleDetail> {
  return request(`${V1}/onco/cycles/${id}/cosign`, { method: 'POST', body: { reason }, reason });
}
