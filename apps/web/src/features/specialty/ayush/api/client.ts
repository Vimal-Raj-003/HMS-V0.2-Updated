import { queryString, request } from '@/features/specialty/api/http';
import type {
  AyushConsultRow,
  AyushCourseRow,
  AyushRegistrationRow,
  AyushSessionRow,
  HeavyMetalLimits,
} from './types';

/**
 * Every call the AYUSH board makes.
 *
 * Nothing here opens a consultation outside a registration, skips the oleation
 * before a pradhana karma, waives a gender match or clears a heavy-metal
 * classification — because no such endpoint exists to call.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}
function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

export async function getRegistrations(
  filters: { readonly liveOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly AyushRegistrationRow[]> {
  return request(
    `${V1}/ayush/registrations${queryString({ liveOnly: filters.liveOnly })}`,
    withSignal(options),
  );
}

export async function getConsults(
  filters: { readonly unsignedOnly?: boolean; readonly system?: string } = {},
  options: Signal = {},
): Promise<readonly AyushConsultRow[]> {
  return request(
    `${V1}/ayush/consults${queryString({
      unsignedOnly: filters.unsignedOnly,
      system: filters.system,
    })}`,
    withSignal(options),
  );
}

export async function getCourses(
  filters: { readonly openOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly AyushCourseRow[]> {
  return request(`${V1}/ayush/courses${queryString({ openOnly: filters.openOnly })}`, withSignal(options));
}

export async function getSessions(
  courseId: string,
  options: Signal = {},
): Promise<readonly AyushSessionRow[]> {
  return request(`${V1}/ayush/courses/${courseId}/sessions`, withSignal(options));
}

/** The ceiling and the monitoring threshold, so a composer shows them. */
export async function getHeavyMetalLimits(options: Signal = {}): Promise<HeavyMetalLimits> {
  return request(`${V1}/ayush/heavy-metal-limits`, withSignal(options));
}
