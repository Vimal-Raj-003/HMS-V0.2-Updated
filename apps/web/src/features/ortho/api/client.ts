import { newIdempotencyKey, queryString, request } from './http';
import type {
  CastApplicationView,
  CastDetailView,
  CastRequestView,
  CatalogueView,
  FractureDetailView,
  FractureView,
  OrthoEpisodeView,
  RecallDetailView,
  RecallView,
  StockView,
  TraceResult,
  UsageView,
} from './types';

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

// ─────────────────────────────────────────────────────────────────────────────
// TR-003 — implant traceability
//
// The trace call takes a reason as an argument rather than reading one from a
// context. It is the only call in this feature that turns a device identifier
// into a list of patient names, and a caller that could forget to pass the
// reason is a caller that would fail at the server instead of at the screen.
// ─────────────────────────────────────────────────────────────────────────────

export async function searchCatalogue(
  filters: { readonly q?: string; readonly kind?: string } = {},
  options: Signal = {},
): Promise<PageOf<CatalogueView>> {
  return request(
    `${V1}/implants/catalogue${queryString({ q: filters.q, kind: filters.kind, limit: 200 })}`,
    withSignal(options),
  );
}

export async function getStock(
  filters: {
    readonly catalogueId?: string;
    readonly status?: string;
    readonly lotNo?: string;
    readonly expiringWithinDays?: number;
  } = {},
  options: Signal = {},
): Promise<PageOf<StockView>> {
  return request(
    `${V1}/implants/stock${queryString({
      catalogueId: filters.catalogueId,
      status: filters.status,
      lotNo: filters.lotNo,
      expiringWithinDays: filters.expiringWithinDays,
      limit: 200,
    })}`,
    withSignal(options),
  );
}

export async function getPatientImplants(
  patientId: string,
  options: Signal = {},
): Promise<PageOf<UsageView>> {
  return request(`${V1}/implants/patients/${patientId}`, withSignal(options));
}

export interface RecordUsageBody {
  readonly stockItemId: string;
  readonly patientId: string;
  readonly fractureId?: string;
  readonly procedureName: string;
  /** Required. `not_applicable` is one of the answers; blank is not. */
  readonly side: string;
  readonly surgeonId: string;
  readonly scanned: boolean;
  readonly scanPayload?: string;
  readonly manualReason?: string;
  readonly chargedPrice?: number;
}

export async function recordImplantUsage(body: RecordUsageBody, idempotencyKey: string): Promise<UsageView> {
  return request(`${V1}/implants/usages`, { method: 'POST', body, idempotencyKey });
}

export async function explantImplant(
  id: string,
  body: { readonly reason: string; readonly explantedAt?: string },
): Promise<UsageView> {
  return request(`${V1}/implants/usages/${id}/explant`, { method: 'PATCH', body });
}

export async function traceImplants(
  filters: {
    readonly udiDi?: string;
    readonly lotNo?: string;
    readonly catalogueId?: string;
    readonly inSituOnly?: boolean;
  },
  reason: string,
  options: Signal = {},
): Promise<TraceResult> {
  return request(
    `${V1}/implants/trace${queryString({
      udiDi: filters.udiDi,
      lotNo: filters.lotNo,
      catalogueId: filters.catalogueId,
      inSituOnly: filters.inSituOnly,
    })}`,
    { ...withSignal(options), reason },
  );
}

export async function getRecalls(options: Signal = {}): Promise<PageOf<RecallView>> {
  return request(`${V1}/implants/recalls`, withSignal(options));
}

export async function getRecall(id: string, options: Signal = {}): Promise<RecallDetailView> {
  return request(`${V1}/implants/recalls/${id}`, withSignal(options));
}

export interface OpenRecallBody {
  readonly reference: string;
  readonly catalogueId?: string;
  readonly udiDi?: string;
  readonly lotNos: readonly string[];
  readonly manufacturer: string;
  readonly kind: string;
  readonly severity: string;
  readonly summary: string;
  readonly actionRequired: string;
  readonly issuedOn: string;
}

export async function openRecall(body: OpenRecallBody, idempotencyKey: string): Promise<RecallDetailView> {
  return request(`${V1}/implants/recalls`, { method: 'POST', body, idempotencyKey });
}

export async function recordRecallContact(
  recallId: string,
  caseId: string,
  body: {
    readonly response: string;
    readonly notifiedPatient?: boolean;
    readonly notifiedSurgeon?: boolean;
    readonly notes?: string;
  },
): Promise<RecallDetailView> {
  return request(`${V1}/implants/recalls/${recallId}/cases/${caseId}`, { method: 'PATCH', body });
}

export async function closeRecall(id: string): Promise<RecallDetailView> {
  return request(`${V1}/implants/recalls/${id}/close`, { method: 'PATCH', body: {} });
}

// ─────────────────────────────────────────────────────────────────────────────
// TR-005 — cast, splint, brace and traction
// ─────────────────────────────────────────────────────────────────────────────

export async function getCasts(
  filters: { readonly patientId?: string; readonly status?: string; readonly dueOnly?: boolean } = {},
  options: Signal = {},
): Promise<PageOf<CastApplicationView>> {
  return request(
    `${V1}/casts${queryString({
      patientId: filters.patientId,
      status: filters.status,
      dueOnly: filters.dueOnly,
      limit: 200,
    })}`,
    withSignal(options),
  );
}

export async function getCast(id: string, options: Signal = {}): Promise<CastDetailView> {
  return request(`${V1}/casts/${id}`, withSignal(options));
}

export interface CastRequestBody {
  readonly patientId: string;
  readonly fractureId?: string;
  readonly kind: string;
  readonly side: string;
  readonly bodyRegion: string;
  readonly position?: string;
  readonly material?: string;
  readonly weightBearing?: string;
  readonly urgency?: string;
  readonly instructions?: string;
}

export async function createCastRequest(
  body: CastRequestBody,
  idempotencyKey: string,
): Promise<CastRequestView> {
  return request(`${V1}/casts/requests`, { method: 'POST', body, idempotencyKey });
}

export interface ApplyCastBody {
  readonly requestId: string;
  readonly kind: string;
  readonly side: string;
  readonly material: string;
  readonly position?: string;
  readonly padding?: string;
  readonly appliedIn?: string;
  readonly firstCheckHours?: number;
  readonly plannedRemovalAt?: string;
  readonly instructionsGivenLocale?: string;
}

export async function applyCast(body: ApplyCastBody, idempotencyKey: string): Promise<CastDetailView> {
  return request(`${V1}/casts`, { method: 'POST', body, idempotencyKey });
}

export interface CastCheckBody {
  readonly kind?: string;
  readonly painOutOfProportion?: boolean;
  readonly painOnPassiveStretch?: boolean;
  readonly paraesthesia?: boolean;
  readonly pallor?: boolean;
  readonly pulselessness?: boolean;
  readonly otherFindings?: readonly string[];
  readonly capillaryRefillSec?: number;
  readonly skinIntact?: boolean;
  readonly castIntact?: boolean;
  readonly neurovascularIntact?: boolean;
  readonly actionTaken?: string;
  readonly escalatedTo?: string;
  readonly notes?: string;
}

/** `redFlag` is deliberately absent from the body. The server computes it. */
export async function recordCastCheck(id: string, body: CastCheckBody): Promise<CastDetailView> {
  return request(`${V1}/casts/${id}/checks`, { method: 'POST', body });
}

export async function removeCast(
  id: string,
  reason: string,
  body: { readonly notes?: string } = {},
): Promise<CastDetailView> {
  return request(`${V1}/casts/${id}/remove`, { method: 'PATCH', body, reason });
}

export async function addPinSite(
  id: string,
  body: { readonly pinLabel: string; readonly intervalDays?: number; readonly notes?: string },
): Promise<CastDetailView> {
  return request(`${V1}/casts/${id}/pin-sites`, { method: 'POST', body });
}

export async function recordPinCare(
  id: string,
  pinId: string,
  body: { readonly infectionGrade?: number; readonly notes?: string; readonly isActive?: boolean },
): Promise<CastDetailView> {
  return request(`${V1}/casts/${id}/pin-sites/${pinId}`, { method: 'PATCH', body });
}
