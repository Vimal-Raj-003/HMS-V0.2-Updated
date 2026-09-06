import { newIdempotencyKey, queryString, request } from './http';
import type { FractureDetailView, FractureView, OrthoEpisodeView } from './types';

/**
 * Every call TR-002 and OP-009 make.
 *
 * ── `side` is on the plan as well as the fracture ───────────────────────────
 *
 * Not redundancy. The server compares them, and the comparison is the
 * wrong-site check — a client that omitted the side would be asking the server
 * to assume, which is the assumption the whole rule exists to remove.
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

export async function getRegistry(
  filters: {
    readonly patientId?: string;
    readonly status?: string;
    readonly openOnly?: boolean;
    readonly confirmedOnly?: boolean;
  } = {},
  options: Signal = {},
): Promise<PageOf<FractureView>> {
  return request(
    `${V1}/ortho/fractures${queryString({
      patientId: filters.patientId,
      status: filters.status,
      openOnly: filters.openOnly,
      confirmedOnly: filters.confirmedOnly,
      limit: 200,
    })}`,
    withSignal(options),
  );
}

export async function getFracture(id: string, options: Signal = {}): Promise<FractureDetailView> {
  return request(`${V1}/ortho/fractures/${id}`, withSignal(options));
}

export interface CreateFractureBody {
  readonly patientId: string;
  readonly boneCode: string;
  readonly boneDisplay: string;
  readonly side: string;
  readonly aoBone?: number;
  readonly aoSegment?: number;
  readonly aoType?: string;
  readonly aoGroup?: number;
  readonly aoSubgroup?: number;
  readonly isOpen?: boolean;
  readonly gustilo?: string;
  readonly paediatric?: boolean;
  readonly salterHarris?: string;
  readonly aetiology?: string;
  readonly injuryAt?: string;
  readonly arrivedAt?: string;
  readonly mechanism?: Readonly<Record<string, unknown>>;
  readonly notes?: string;
}

export async function createFracture(
  body: CreateFractureBody,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<FractureDetailView> {
  return request(`${V1}/ortho/fractures`, { method: 'POST', body, idempotencyKey });
}

export async function confirmFracture(id: string, cosignRequired = false): Promise<FractureDetailView> {
  return request(`${V1}/ortho/fractures/${id}/confirm`, { method: 'POST', body: { cosignRequired } });
}

export async function setPlan(
  id: string,
  body: {
    readonly intent: string;
    /** Sent so the server can refuse a mismatch. Never inferred. */
    readonly side: string;
    readonly urgency?: string;
    readonly weightBearing?: string;
    readonly damageControl?: boolean;
    readonly dvtProphylaxis?: boolean;
  },
): Promise<FractureDetailView> {
  return request(`${V1}/ortho/fractures/${id}/plan`, { method: 'POST', body });
}

export async function attachFilm(
  id: string,
  body: { readonly label: string; readonly takenAt: string; readonly studyUid?: string },
): Promise<FractureDetailView> {
  return request(`${V1}/ortho/fractures/${id}/films`, { method: 'POST', body });
}

export async function recordFinding(
  id: string,
  body: {
    readonly filmId: string;
    readonly rustScore?: number;
    readonly mrustScore?: number;
    readonly alignmentMaintained?: boolean;
    readonly unionStatus: string;
    readonly notes?: string;
  },
): Promise<FractureDetailView> {
  return request(`${V1}/ortho/fractures/${id}/findings`, { method: 'POST', body });
}

export async function recordBundle(
  id: string,
  body: Readonly<Record<string, string | undefined>>,
): Promise<FractureDetailView> {
  return request(`${V1}/ortho/fractures/${id}/open-bundle`, { method: 'POST', body });
}

export async function declareUnion(
  id: string,
  body: { readonly outcome: string; readonly clinicalJustification?: string },
  reason?: string,
): Promise<FractureDetailView> {
  return request(`${V1}/ortho/fractures/${id}/union`, {
    method: 'POST',
    body,
    ...(reason === undefined ? {} : { reason }),
  });
}

export async function recordComplication(
  id: string,
  body: {
    readonly kind: string;
    readonly onsetAt: string;
    readonly severity?: string;
    readonly management?: string;
  },
): Promise<FractureDetailView> {
  return request(`${V1}/ortho/fractures/${id}/complications`, { method: 'POST', body });
}

// ── OP-009 ───────────────────────────────────────────────────────────────────

export async function getEpisode(id: string, options: Signal = {}): Promise<OrthoEpisodeView> {
  return request(`${V1}/ortho/episodes/${id}`, withSignal(options));
}

export async function createEpisode(
  body: {
    readonly patientId: string;
    readonly anchorKind: string;
    readonly anchorAt: string;
    readonly presentingComplaint?: string;
    readonly xrayFirst?: boolean;
  },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<OrthoEpisodeView> {
  return request(`${V1}/ortho/episodes`, { method: 'POST', body, idempotencyKey });
}

export async function scheduleFollowups(
  id: string,
  body: {
    readonly protocolKey: string;
    readonly fractureId?: string;
    readonly visits: readonly {
      readonly label: string;
      readonly offsetWeeks: number;
      readonly actions?: readonly string[];
    }[];
  },
): Promise<OrthoEpisodeView> {
  return request(`${V1}/ortho/episodes/${id}/followups`, { method: 'POST', body });
}

export async function recordProm(
  id: string,
  body: {
    readonly instrument: string;
    readonly atWeeks: number;
    readonly responses: Readonly<Record<string, unknown>>;
    readonly score?: number;
    readonly fractureId?: string;
  },
): Promise<OrthoEpisodeView> {
  return request(`${V1}/ortho/episodes/${id}/proms`, { method: 'POST', body });
}
