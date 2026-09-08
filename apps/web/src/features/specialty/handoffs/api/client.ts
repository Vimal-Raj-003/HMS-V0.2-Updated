import { queryString, request } from '@/features/specialty/api/http';
import type {
  PathwayInstanceRow,
  ReferralRow,
  TeleConsultRow,
  TeleDrugRuleRow,
  VarianceTallyRow,
} from './types';

/**
 * Every call the three hand-off screens make.
 *
 * Nothing here reaches the prohibited drug list, sets a referral's reply date,
 * closes a referral without a reply, or writes a pathway's adherence — because
 * no such endpoint exists to call.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}
function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

export async function getConsults(
  filters: { readonly openOnly?: boolean; readonly mode?: string } = {},
  options: Signal = {},
): Promise<readonly TeleConsultRow[]> {
  return request(
    `${V1}/tele/consults${queryString({ openOnly: filters.openOnly, mode: filters.mode })}`,
    withSignal(options),
  );
}

/** The four lists read against one consultation, or against none. */
export async function getDrugRules(
  consultId: string | undefined,
  options: Signal = {},
): Promise<readonly TeleDrugRuleRow[]> {
  return request(`${V1}/tele/drug-rules${queryString({ consultId })}`, withSignal(options));
}

export async function getReferrals(
  filters: { readonly overdueOnly?: boolean; readonly awaitingReplyOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly ReferralRow[]> {
  return request(
    `${V1}/referrals${queryString({
      overdueOnly: filters.overdueOnly,
      awaitingReplyOnly: filters.awaitingReplyOnly,
    })}`,
    withSignal(options),
  );
}

export async function getPathways(
  filters: { readonly openOnly?: boolean; readonly pathwayKey?: string } = {},
  options: Signal = {},
): Promise<readonly PathwayInstanceRow[]> {
  return request(
    `${V1}/pathways${queryString({ openOnly: filters.openOnly, pathwayKey: filters.pathwayKey })}`,
    withSignal(options),
  );
}

export async function getVarianceReport(
  pathwayKey: string | undefined,
  options: Signal = {},
): Promise<readonly VarianceTallyRow[]> {
  return request(`${V1}/pathways/variance-report${queryString({ pathwayKey })}`, withSignal(options));
}
