import { queryString, request } from '@/features/specialty/api/http';
import type { AdmissionRow, EpisodeDetail, PsyEpisodeRow, RestraintRow } from './types';

/**
 * Every call the psychiatry console makes.
 *
 * ── Nothing here decides capacity or sets an expiry ─────────────────────────
 *
 * The four limbs go up and the verdict comes back. Every clock follows from the
 * section of the Act the admission was made under, and there is no call that
 * extends one — past thirty days the choices are discharge, an independent
 * admission the person consents to, or the Review Board's authority under §90,
 * and the third is a different admission rather than a longer one.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}
function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

export async function getEpisodes(
  filters: {
    readonly activeOnly?: boolean;
    readonly highRiskOnly?: boolean;
    readonly authorityExpiringOnly?: boolean;
  } = {},
  options: Signal = {},
): Promise<readonly PsyEpisodeRow[]> {
  return request(
    `${V1}/psy/episodes${queryString({
      activeOnly: filters.activeOnly,
      highRiskOnly: filters.highRiskOnly,
      authorityExpiringOnly: filters.authorityExpiringOnly,
    })}`,
    withSignal(options),
  );
}

export async function getEpisode(id: string, options: Signal = {}): Promise<EpisodeDetail> {
  return request(`${V1}/psy/episodes/${id}`, withSignal(options));
}

export async function getRestraints(
  filters: { readonly openOnly?: boolean; readonly month?: string } = {},
  options: Signal = {},
): Promise<readonly RestraintRow[]> {
  return request(
    `${V1}/psy/restraints${queryString({ openOnly: filters.openOnly, month: filters.month })}`,
    withSignal(options),
  );
}

/** Recording a fact about an authority that already exists. */
export async function recordIntimation(id: string, mhrbRef: string): Promise<AdmissionRow> {
  return request(`${V1}/psy/admissions/${id}/intimation`, { method: 'POST', body: { mhrbRef } });
}

export async function observeRestraint(id: string, state: string): Promise<RestraintRow> {
  return request(`${V1}/psy/restraints/${id}/observations`, { method: 'POST', body: { state } });
}

export async function closeRestraint(id: string): Promise<RestraintRow> {
  return request(`${V1}/psy/restraints/${id}/close`, { method: 'POST', body: {} });
}
