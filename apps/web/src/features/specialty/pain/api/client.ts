import { newIdempotencyKey, queryString, request } from '@/features/specialty/api/http';
import type { AgreementRow, OpioidRow, PainEpisodeDetail, PainEpisodeRow, PainThresholds } from './types';

/**
 * Every call the pain clinic makes.
 *
 * ── No `mme`, and no `secondReviewerId` on a prescription ───────────────────
 *
 * The equivalent is computed in the database and the countersignature is a
 * second person's act on a second route. Neither can be sent, which is what
 * makes the thresholds mean anything.
 *
 * ── And no route that exceeds the steroid ceiling ───────────────────────────
 *
 * There is no `overrideCeiling`. Every other console in the phase has one
 * documented way past its rule; this one does not, and the absence is the
 * decision rather than an omission.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}
function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

/** What the database will actually enforce. Never a constant in the client. */
export async function getThresholds(options: Signal = {}): Promise<PainThresholds> {
  return request(`${V1}/pain/thresholds`, withSignal(options));
}

export async function getEpisodes(
  filters: { readonly patientId?: string; readonly openOnly?: boolean; readonly opioidOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly PainEpisodeRow[]> {
  return request(
    `${V1}/pain/episodes${queryString({
      patientId: filters.patientId,
      openOnly: filters.openOnly,
      opioidOnly: filters.opioidOnly,
    })}`,
    withSignal(options),
  );
}

export async function getEpisode(id: string, options: Signal = {}): Promise<PainEpisodeDetail> {
  return request(`${V1}/pain/episodes/${id}`, withSignal(options));
}

export async function getOpioids(
  filters: { readonly patientId?: string; readonly highDoseOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly OpioidRow[]> {
  return request(
    `${V1}/pain/opioids${queryString({
      patientId: filters.patientId,
      highDoseOnly: filters.highDoseOnly,
    })}`,
    withSignal(options),
  );
}

export async function signAgreement(
  episodeId: string,
  body: { readonly patientId: string; readonly termsVersion: string; readonly validTo: string },
): Promise<AgreementRow> {
  return request(`${V1}/pain/episodes/${episodeId}/agreement`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

/** Stops every future opioid on the episode, so it carries its reason. */
export async function revokeAgreement(id: string, reason: string): Promise<AgreementRow> {
  return request(`${V1}/pain/agreements/${id}/revoke`, {
    method: 'POST',
    body: { reason },
    reason,
  });
}

/**
 * Countersign a prescription.
 *
 * The reviewer is the session's, and the server refuses one who is the
 * prescriber. There is no field for who reviewed it.
 */
export async function secondReview(id: string, justification: string): Promise<OpioidRow> {
  return request(`${V1}/pain/opioids/${id}/review`, {
    method: 'POST',
    body: { justification },
    reason: justification,
  });
}
