import { newIdempotencyKey, queryString, request } from './http';
import type { AdmissionDetailView, AdmissionView, BedBoardRow, CensusRow, CleaningTaskView } from './types';

/**
 * Every call Phase 7A makes.
 *
 * ── Admitting names a class, not a bed ──────────────────────────────────────
 *
 * There is no `bedId` on `admit`, only `preferredBedId`. A client naming a bed
 * read the board a moment ago and is about to lose a race it cannot see; the
 * server allocates under a lock and the preference is tried first.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}
function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}
interface PageOf<T> {
  readonly items: readonly T[];
}

export async function getBoard(
  filters: {
    readonly wardId?: string;
    readonly wardType?: string;
    readonly classId?: string;
    readonly status?: string;
    readonly freeOnly?: boolean;
  } = {},
  options: Signal = {},
): Promise<PageOf<BedBoardRow>> {
  return request(
    `${V1}/ip/board${queryString({
      wardId: filters.wardId,
      wardType: filters.wardType,
      classId: filters.classId,
      status: filters.status,
      freeOnly: filters.freeOnly,
    })}`,
    withSignal(options),
  );
}

export async function getCensus(options: Signal = {}): Promise<readonly CensusRow[]> {
  return request(`${V1}/ip/census`, withSignal(options));
}

export async function getAdmissions(
  filters: {
    readonly status?: string;
    readonly wardId?: string;
    readonly patientId?: string;
    readonly dueForDischarge?: boolean;
  } = {},
  options: Signal = {},
): Promise<PageOf<AdmissionView>> {
  return request(
    `${V1}/ip/admissions${queryString({
      status: filters.status,
      wardId: filters.wardId,
      patientId: filters.patientId,
      dueForDischarge: filters.dueForDischarge,
    })}`,
    withSignal(options),
  );
}

export async function getAdmission(id: string, options: Signal = {}): Promise<AdmissionDetailView> {
  return request(`${V1}/ip/admissions/${id}`, withSignal(options));
}

export interface AdmitBody {
  readonly classId: string;
  readonly wardId?: string;
  readonly needsIsolation?: boolean;
  readonly needsVentilatorPoint?: boolean;
  readonly needsMonitor?: boolean;
  readonly needsAttendantBed?: boolean;
  /** A preference, tried first. Not an instruction — the lock decides. */
  readonly preferredBedId?: string;
  readonly depositTaken?: number;
  readonly depositApprovalId?: string;
}

export async function admit(id: string, body: AdmitBody): Promise<AdmissionDetailView> {
  return request(`${V1}/ip/admissions/${id}/admit`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export interface TransferBody {
  readonly kind: string;
  readonly toBedId?: string;
  readonly reason: string;
  readonly situation?: string;
  readonly background?: string;
  readonly assessment?: string;
  readonly recommendation?: string;
  readonly linesAndTubes?: readonly string[];
  readonly infusions?: readonly string[];
  readonly pendingResults?: readonly string[];
  readonly allergies?: readonly string[];
  readonly destinationFacility?: string;
  readonly stabilityNote?: string;
}

export async function transfer(id: string, body: TransferBody): Promise<AdmissionDetailView> {
  return request(`${V1}/ip/admissions/${id}/transfers`, { method: 'POST', body });
}

export async function discharge(
  id: string,
  body: { readonly outcome: string; readonly notes?: string },
): Promise<AdmissionDetailView> {
  return request(`${V1}/ip/admissions/${id}/discharge`, { method: 'PATCH', body });
}

export async function holdBed(body: {
  readonly bedId: string;
  readonly reason: string;
  readonly admissionId?: string;
  readonly minutes?: number;
}): Promise<{ readonly id: string; readonly expiresAt: string }> {
  return request(`${V1}/ip/holds`, { method: 'POST', body, idempotencyKey: newIdempotencyKey() });
}

export async function releaseHold(id: string, reason: string): Promise<{ readonly released: boolean }> {
  return request(`${V1}/ip/holds/${id}/release`, { method: 'PATCH', body: { reason } });
}

export async function blockBed(
  id: string,
  body: { readonly blocked: boolean; readonly expectedHours?: number; readonly approvalId?: string },
  reason: string,
): Promise<{ readonly status: string }> {
  return request(`${V1}/ip/beds/${id}/block`, { method: 'PATCH', body, reason });
}

export async function getCleaning(
  filters: { readonly wardId?: string; readonly openOnly?: boolean; readonly breachedOnly?: boolean } = {},
  options: Signal = {},
): Promise<PageOf<CleaningTaskView>> {
  return request(
    `${V1}/ip/cleaning${queryString({
      wardId: filters.wardId,
      openOnly: filters.openOnly,
      breachedOnly: filters.breachedOnly,
    })}`,
    withSignal(options),
  );
}

export async function cleaningAction(
  id: string,
  body: { readonly action: string; readonly failReason?: string },
): Promise<CleaningTaskView> {
  return request(`${V1}/ip/cleaning/${id}`, { method: 'PATCH', body });
}

/** The audited exception. The reason lands on the bed row, where the trigger reads it. */
export async function skipCleaning(bedId: string, reason: string): Promise<{ readonly status: string }> {
  return request(`${V1}/ip/beds/${bedId}/skip-cleaning`, { method: 'PATCH', body: {}, reason });
}
