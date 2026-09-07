import { queryString, request } from '@/features/specialty/api/http';
import type { ArtCycleRow, DonationRow, DonorRow, RecipientRow } from './types';

/**
 * Every call the transplant register and the fertility clinic make.
 *
 * Nothing here waives the Authorisation Committee, shortens the six hours
 * between the brain-stem examinations, or lets a gamete donor donate twice —
 * and there is no field anywhere for a payment.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}
function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

export async function getRecipients(
  filters: { readonly organ?: string } = {},
  options: Signal = {},
): Promise<readonly RecipientRow[]> {
  return request(`${V1}/transplant/recipients${queryString({ organ: filters.organ })}`, withSignal(options));
}

export async function getDonations(
  filters: { readonly awaitingCommitteeOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly DonationRow[]> {
  return request(
    `${V1}/transplant/donations${queryString({
      awaitingCommitteeOnly: filters.awaitingCommitteeOnly,
    })}`,
    withSignal(options),
  );
}

export async function getDonors(
  filters: { readonly availableDonorsOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly DonorRow[]> {
  return request(
    `${V1}/art/donors${queryString({ availableDonorsOnly: filters.availableDonorsOnly })}`,
    withSignal(options),
  );
}

export async function getCycles(options: Signal = {}): Promise<readonly ArtCycleRow[]> {
  return request(`${V1}/art/cycles`, withSignal(options));
}
