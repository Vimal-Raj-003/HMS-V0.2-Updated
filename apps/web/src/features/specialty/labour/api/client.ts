import { queryString, request } from '@/features/specialty/api/http';
import type {
  LabourEpisodeDetail,
  LabourEpisodeRow,
  NewbornRow,
  PartographAlertRow,
  PphActivationRow,
} from './types';

/**
 * Every call the labour room makes.
 *
 * ── Nothing here declares an alert, a delay, or a match ─────────────────────
 *
 * The two lines are computed from the start of the active phase; the
 * third-stage delay is the birth and the drug; the tranexamic acid window runs
 * from the birth; and whether two bands match is what the *scanner* read.
 *
 * ── And there is no `force` ─────────────────────────────────────────────────
 *
 * The chart releases on a decision, of which "continue expectantly, because —"
 * is one. A handover releases on a scan that matches, and nothing else.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}
function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

export async function getEpisodes(
  filters: { readonly openOnly?: boolean; readonly blockedOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly LabourEpisodeRow[]> {
  return request(
    `${V1}/obs/labour-episodes${queryString({
      openOnly: filters.openOnly,
      blockedOnly: filters.blockedOnly,
    })}`,
    withSignal(options),
  );
}

export async function getEpisode(id: string, options: Signal = {}): Promise<LabourEpisodeDetail> {
  return request(`${V1}/obs/labour-episodes/${id}`, withSignal(options));
}

export async function getNewborns(
  filters: { readonly reportDueOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly NewbornRow[]> {
  return request(
    `${V1}/obs/newborns${queryString({ reportDueOnly: filters.reportDueOnly })}`,
    withSignal(options),
  );
}

export async function getActivations(options: Signal = {}): Promise<readonly PphActivationRow[]> {
  return request(`${V1}/obs/pph-activations`, withSignal(options));
}

export async function plot(
  episodeId: string,
  entries: readonly Record<string, unknown>[],
): Promise<LabourEpisodeDetail> {
  return request(`${V1}/obs/labour-episodes/${episodeId}/partograph`, {
    method: 'POST',
    body: { entries },
  });
}

/** What releases the chart. Five choices, one of which is to continue. */
export async function decide(
  alertId: string,
  body: { readonly decision: string; readonly decisionNote?: string },
): Promise<PartographAlertRow> {
  return request(`${V1}/obs/partograph-alerts/${alertId}/decide`, {
    method: 'POST',
    body,
    ...(body.decisionNote === undefined ? {} : { reason: body.decisionNote }),
  });
}

/** `matched` is not sent. It is what the scanner read against the record. */
export async function checkIdentity(
  newbornId: string,
  body: {
    readonly motherBandScan: string;
    readonly babyBandScan: string;
    readonly context: string;
  },
): Promise<{ readonly matched: boolean }> {
  return request(`${V1}/obs/newborns/${newbornId}/identity-check`, { method: 'POST', body });
}
