import { newIdempotencyKey, queryString, request } from './http';
import type {
  MlcCaseDetailView,
  MlcCaseView,
  MlcDischargeGateView,
  MlcEvidenceView,
  MlcWorklistRow,
} from './mlc-types';

/**
 * Every call TR-008 makes.
 *
 * ── Three things this client cannot send ────────────────────────────────────
 *
 * A custody hash, an MLC number, and a two-finger test. The first is computed
 * by the database, the second by the gapless series, and the third has no field
 * anywhere in the stack. Their absence here is a consequence of the contract,
 * not a convention this file is keeping.
 *
 * ── Reasons ─────────────────────────────────────────────────────────────────
 *
 * Cancelling a case, overriding the discharge gate, handing evidence to the
 * police, issuing a certified copy, answering a court request and recording an
 * addendum all carry `x-reason`. The transport's `reason` option puts it in the
 * header so the policy guard writes the audit row before the handler runs.
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

// ── The register ─────────────────────────────────────────────────────────────

export async function getRegister(
  filters: {
    readonly year?: number;
    readonly status?: string;
    readonly category?: string;
    readonly includeSensitive?: boolean;
  } = {},
  options: Signal = {},
): Promise<PageOf<MlcCaseView>> {
  return request(
    `${V1}/mlc/register${queryString({
      year: filters.year,
      status: filters.status,
      category: filters.category,
      includeSensitive: filters.includeSensitive,
      limit: 200,
    })}`,
    withSignal(options),
  );
}

export async function getWorklist(kind: string, options: Signal = {}): Promise<PageOf<MlcWorklistRow>> {
  return request(`${V1}/mlc/worklists${queryString({ kind, limit: 100 })}`, withSignal(options));
}

export async function getCase(id: string, options: Signal = {}): Promise<MlcCaseDetailView> {
  return request(`${V1}/mlc/cases/${id}`, withSignal(options));
}

/** What OP-006 asks before it offers a discharge button. Null when not an MLC. */
export async function getDischargeGate(
  erVisitId: string,
  options: Signal = {},
): Promise<MlcDischargeGateView | null> {
  return request(`${V1}/mlc/discharge-gate/${erVisitId}`, withSignal(options));
}

export interface OpenCaseBody {
  readonly category: string;
  readonly subCategory?: string;
  readonly erVisitId?: string;
  readonly patientId?: string;
  readonly tempTagId?: string;
  readonly historyAsStated?: string;
  readonly incidentPlace?: string;
  readonly identificationMarks?: readonly string[];
  readonly broughtBy?: Readonly<Record<string, unknown>>;
  readonly informant?: Readonly<Record<string, unknown>>;
  readonly consent?: Readonly<Record<string, unknown>>;
  readonly suggestedFrom?: string;
}

export async function openCase(
  body: OpenCaseBody,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<MlcCaseDetailView> {
  return request(`${V1}/mlc/cases`, { method: 'POST', body, idempotencyKey });
}

export async function updateCase(
  id: string,
  body: Readonly<Record<string, unknown>>,
): Promise<MlcCaseDetailView> {
  return request(`${V1}/mlc/cases/${id}`, { method: 'PATCH', body });
}

export async function cancelCase(id: string, reason: string): Promise<MlcCaseDetailView> {
  return request(`${V1}/mlc/cases/${id}/cancel`, { method: 'POST', body: {}, reason });
}

// ── Police intimation ────────────────────────────────────────────────────────

export async function createIntimation(
  caseId: string,
  body: { readonly type: string; readonly psName: string; readonly jurisdiction?: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<MlcCaseDetailView> {
  return request(`${V1}/mlc/cases/${caseId}/intimations`, { method: 'POST', body, idempotencyKey });
}

export async function dispatchIntimation(
  id: string,
  channels: readonly { readonly channel: string; readonly to: string }[],
): Promise<MlcCaseDetailView> {
  return request(`${V1}/mlc/intimations/${id}/dispatch`, { method: 'POST', body: { channels } });
}

export async function acknowledgeIntimation(
  id: string,
  body: { readonly officerName: string; readonly officerBadge?: string },
): Promise<MlcCaseDetailView> {
  return request(`${V1}/mlc/intimations/${id}/acknowledge`, { method: 'POST', body });
}

// ── The body map ─────────────────────────────────────────────────────────────

export interface InjuryBody {
  readonly kind: string;
  readonly bodyView: string;
  readonly xPct: number;
  readonly yPct: number;
  readonly side?: string;
  readonly siteDescription: string;
  readonly lengthCm?: number;
  readonly breadthCm?: number;
  readonly depthCm?: number;
  readonly shape?: string;
  readonly edges?: string;
  readonly colourStage?: string;
  readonly ageEstimate?: string;
  readonly bnsClass: string;
  readonly grievousGround?: string;
  readonly weaponOpinion: string;
  readonly consistentWithHistory: string;
}

export async function recordInjury(caseId: string, body: InjuryBody): Promise<MlcCaseDetailView> {
  return request(`${V1}/mlc/cases/${caseId}/injuries`, { method: 'POST', body });
}

// ── Evidence and custody ─────────────────────────────────────────────────────

export async function captureEvidence(
  caseId: string,
  body: {
    readonly kind: string;
    readonly description: string;
    readonly sealNo?: string;
    readonly fileRef?: string;
    readonly sha256?: string;
    readonly notes?: string;
  },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<MlcEvidenceView> {
  return request(`${V1}/mlc/cases/${caseId}/evidence`, { method: 'POST', body, idempotencyKey });
}

export async function listEvidence(caseId: string, options: Signal = {}): Promise<PageOf<MlcEvidenceView>> {
  return request(`${V1}/mlc/cases/${caseId}/evidence`, withSignal(options));
}

export async function recordCustody(
  evidenceId: string,
  body: {
    readonly toUserId?: string;
    readonly toExternal?: Readonly<Record<string, unknown>>;
    readonly locationTo: string;
    readonly purpose: string;
    readonly sealIntact: boolean;
    readonly conditionNotes?: string;
    readonly witnessUserId?: string;
  },
): Promise<MlcEvidenceView> {
  return request(`${V1}/mlc/evidence/${evidenceId}/custody`, { method: 'POST', body });
}

export async function handOver(
  caseId: string,
  body: {
    readonly itemIds: readonly string[];
    readonly toExternal: {
      readonly officer: string;
      readonly badge?: string;
      readonly ps: string;
      readonly firNo?: string;
      readonly requisitionRef: string;
    };
  },
  reason: string,
): Promise<MlcCaseDetailView> {
  return request(`${V1}/mlc/cases/${caseId}/handovers`, { method: 'POST', body, reason });
}

// ── Reports ──────────────────────────────────────────────────────────────────

export async function createReport(
  caseId: string,
  body: { readonly kind: string; readonly content: Readonly<Record<string, unknown>> },
): Promise<MlcCaseDetailView> {
  return request(`${V1}/mlc/cases/${caseId}/reports`, { method: 'POST', body });
}

export async function signReport(
  id: string,
  body: { readonly documentRef: string; readonly sha256: string; readonly dscRef?: string },
): Promise<MlcCaseDetailView> {
  return request(`${V1}/mlc/reports/${id}/sign`, { method: 'POST', body });
}

export async function addendum(
  caseId: string,
  body: {
    readonly kind: string;
    readonly addendumOf: string;
    readonly content: Readonly<Record<string, unknown>>;
  },
  reason: string,
): Promise<MlcCaseDetailView> {
  return request(`${V1}/mlc/cases/${caseId}/reports/addendum`, { method: 'POST', body, reason });
}

export async function issueCertifiedCopy(id: string, reason: string): Promise<MlcCaseDetailView> {
  return request(`${V1}/mlc/reports/${id}/certified-copy`, { method: 'POST', body: {}, reason });
}

// ── Requests, the protocol, death, and the gate ──────────────────────────────

export async function registerRequest(
  caseId: string,
  body: {
    readonly kind: string;
    readonly requester: Readonly<Record<string, unknown>>;
    readonly authorityRef?: string;
  },
): Promise<MlcCaseDetailView> {
  return request(`${V1}/mlc/cases/${caseId}/requests`, { method: 'POST', body });
}

export async function answerRequest(
  id: string,
  body: { readonly providedDocRefs?: readonly string[]; readonly deniedReason?: string },
  reason: string,
): Promise<MlcCaseDetailView> {
  return request(`${V1}/mlc/requests/${id}/answer`, { method: 'POST', body, reason });
}

export async function recordSexualAssault(
  caseId: string,
  body: Readonly<Record<string, unknown>>,
): Promise<MlcCaseDetailView> {
  return request(`${V1}/mlc/cases/${caseId}/sexual-assault`, { method: 'POST', body });
}

export async function recordDeath(
  caseId: string,
  body: {
    readonly kind: string;
    readonly declaredAt: string;
    readonly provisionalCause?: string;
    readonly mannerSuspected?: string;
    readonly pmRequired?: string;
    readonly bodyCustody?: string;
    readonly nocNo?: string;
  },
): Promise<MlcCaseDetailView> {
  return request(`${V1}/mlc/cases/${caseId}/death`, { method: 'POST', body });
}

export async function overrideGate(caseId: string, reason: string): Promise<MlcCaseDetailView> {
  return request(`${V1}/mlc/cases/${caseId}/override-gate`, { method: 'POST', body: {}, reason });
}
