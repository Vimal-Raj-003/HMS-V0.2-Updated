import { newIdempotencyKey, queryString, request } from '@/features/specialty/api/http';
import type {
  AefiRow,
  BreachRow,
  HcEpisodeDetail,
  HcEpisodeRow,
  PlanDoseRow,
  VaccinationRow,
  VialRow,
} from './types';

/**
 * Every call the programme consoles make.
 *
 * ── Nothing here sends a discard time, a dose count or a health score ───────
 *
 * All three are the database's. And there is no `forceSignReport`: a station is
 * done or skipped with a reason that goes on the report, and a way round that
 * would be the failure this console exists to prevent, with a button.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}
function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

// ── OP-013 ───────────────────────────────────────────────────────────────────

/** `usableOnly` is the list a session sets up from: open, in clock, doses left. */
export async function getVials(
  filters: { readonly usableOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly VialRow[]> {
  return request(
    `${V1}/immunisation/vials${queryString({ usableOnly: filters.usableOnly })}`,
    withSignal(options),
  );
}

export async function openVial(body: Record<string, unknown>): Promise<VialRow> {
  return request(`${V1}/immunisation/vials`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function discardVial(
  id: string,
  body: { readonly reason: string; readonly wastageDoses?: number },
): Promise<VialRow> {
  return request(`${V1}/immunisation/vials/${id}/discard`, { method: 'POST', body });
}

export async function administer(body: Record<string, unknown>): Promise<VaccinationRow> {
  return request(`${V1}/immunisation/records`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function getRecords(
  filters: { readonly patientId?: string } = {},
  options: Signal = {},
): Promise<readonly VaccinationRow[]> {
  return request(
    `${V1}/immunisation/records${queryString({ patientId: filters.patientId })}`,
    withSignal(options),
  );
}

/** Strikes the dose and puts it back on the recall list. Never a delete. */
export async function voidDose(id: string, reason: string): Promise<VaccinationRow> {
  return request(`${V1}/immunisation/records/${id}/void`, { method: 'POST', body: { reason }, reason });
}

export async function getPlanDoses(
  filters: { readonly patientId?: string; readonly overdueOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly PlanDoseRow[]> {
  return request(
    `${V1}/immunisation/plan-doses${queryString({
      patientId: filters.patientId,
      overdueOnly: filters.overdueOnly,
    })}`,
    withSignal(options),
  );
}

export async function getBreaches(options: Signal = {}): Promise<readonly BreachRow[]> {
  return request(`${V1}/immunisation/breaches`, withSignal(options));
}

/** The only moment a hold means anything: it releases the doses, or condemns them. */
export async function decideBreach(
  id: string,
  body: { readonly action: 'released' | 'discarded'; readonly reason: string },
): Promise<BreachRow> {
  return request(`${V1}/immunisation/breaches/${id}/decide`, {
    method: 'POST',
    body,
    reason: body.reason,
  });
}

export async function getAefi(options: Signal = {}): Promise<readonly AefiRow[]> {
  return request(`${V1}/immunisation/aefi`, withSignal(options));
}

// ── OP-014 ───────────────────────────────────────────────────────────────────

export async function getHcEpisodes(
  filters: { readonly patientId?: string; readonly inProgressOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly HcEpisodeRow[]> {
  return request(
    `${V1}/healthcheck/episodes${queryString({
      patientId: filters.patientId,
      inProgressOnly: filters.inProgressOnly,
    })}`,
    withSignal(options),
  );
}

export async function getHcEpisode(id: string, options: Signal = {}): Promise<HcEpisodeDetail> {
  return request(`${V1}/healthcheck/episodes/${id}`, withSignal(options));
}

export async function updateStation(
  id: string,
  body: { readonly status: string; readonly skipReason?: string },
): Promise<HcEpisodeDetail> {
  return request(`${V1}/healthcheck/stations/${id}`, { method: 'POST', body });
}

export async function signHcReport(id: string): Promise<Record<string, unknown>> {
  return request(`${V1}/healthcheck/reports/${id}/sign`, { method: 'POST', body: {} });
}
