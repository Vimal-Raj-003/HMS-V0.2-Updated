import { queryString, request } from '@/features/specialty/api/http';
import type { GrowthRow, MedicationReviewRow, NicuAdmissionRow, NicuFluidRow } from './types';

/**
 * Every call the two ends of life make.
 *
 * Nothing here sends a dose, a centile or a burden — and no weight in
 * kilograms, on a child or a neonate, anywhere.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}
function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

export async function getGrowth(
  filters: { readonly falteringOnly?: boolean; readonly patientId?: string } = {},
  options: Signal = {},
): Promise<readonly GrowthRow[]> {
  return request(
    `${V1}/lifespan/growth${queryString({
      falteringOnly: filters.falteringOnly,
      patientId: filters.patientId,
    })}`,
    withSignal(options),
  );
}

export async function getNicu(
  filters: { readonly currentOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly NicuAdmissionRow[]> {
  return request(
    `${V1}/lifespan/nicu-admissions${queryString({ currentOnly: filters.currentOnly })}`,
    withSignal(options),
  );
}

export async function getFluids(id: string, options: Signal = {}): Promise<readonly NicuFluidRow[]> {
  return request(`${V1}/lifespan/nicu-admissions/${id}/fluids`, withSignal(options));
}

export async function getReviews(
  filters: { readonly highBurdenOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly MedicationReviewRow[]> {
  return request(
    `${V1}/lifespan/medication-reviews${queryString({ highBurdenOnly: filters.highBurdenOnly })}`,
    withSignal(options),
  );
}
