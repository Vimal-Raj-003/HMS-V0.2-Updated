import { newIdempotencyKey, queryString, request } from '@/features/specialty/api/http';
import type { AncVisitRow, PregnancyDetail, PregnancyRow, ScheduleItemRow } from './types';

/**
 * Every call the antenatal clinic makes.
 *
 * ── Nothing here sends a date, an age or a score ────────────────────────────
 *
 * The estimated date of delivery, the gestational age and the obstetric warning
 * score are all the database's. And there is no call that reports the sex of a
 * foetus, skips a Medical Board or forces a Form F past the register — each of
 * those is the thing its statute exists to prevent.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}
function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

export async function getPregnancies(
  filters: {
    readonly activeOnly?: boolean;
    readonly highRiskOnly?: boolean;
    readonly rhNegativeOnly?: boolean;
    readonly dueThisWeek?: boolean;
  } = {},
  options: Signal = {},
): Promise<readonly PregnancyRow[]> {
  return request(
    `${V1}/obg/pregnancies${queryString({
      activeOnly: filters.activeOnly,
      highRiskOnly: filters.highRiskOnly,
      rhNegativeOnly: filters.rhNegativeOnly,
      dueThisWeek: filters.dueThisWeek,
    })}`,
    withSignal(options),
  );
}

export async function getPregnancy(id: string, options: Signal = {}): Promise<PregnancyDetail> {
  return request(`${V1}/obg/pregnancies/${id}`, withSignal(options));
}

export async function getSchedule(
  filters: { readonly overdueOnly?: boolean; readonly kind?: string } = {},
  options: Signal = {},
): Promise<readonly ScheduleItemRow[]> {
  return request(
    `${V1}/obg/schedule${queryString({ overdueOnly: filters.overdueOnly, kind: filters.kind })}`,
    withSignal(options),
  );
}

export async function recordVisit(pregnancyId: string, body: Record<string, unknown>): Promise<AncVisitRow> {
  return request(`${V1}/obg/pregnancies/${pregnancyId}/visits`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

/** A visit carrying a danger sign cannot be signed without a plan. */
export async function signVisit(id: string): Promise<AncVisitRow> {
  return request(`${V1}/obg/visits/${id}/sign`, { method: 'POST', body: {} });
}

/** Anti-D is waived with a reason, never quietly skipped. */
export async function updateScheduleItem(
  id: string,
  body: { readonly status: string; readonly waivedReason?: string },
): Promise<ScheduleItemRow> {
  return request(`${V1}/obg/schedule/${id}`, { method: 'POST', body });
}
