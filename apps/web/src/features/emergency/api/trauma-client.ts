import { newIdempotencyKey, queryString, request } from './http';
import type {
  MciIncidentView,
  PrimarySurveyView,
  TraumaActivationView,
  TraumaBoardView,
  TraumaInjuryView,
  TraumaScoreView,
  TriageRecordView,
  TriageResultView,
} from './trauma-types';

/**
 * Every call TR-001 makes.
 *
 * ── No score is ever sent ───────────────────────────────────────────────────
 *
 * `triage` posts observations. The screen runs the same `scoreEsi` and
 * `scoreGcs` from `@vims/contracts` so the nurse sees a level before the round
 * trip completes, but what comes back is what the *server* computed, and that is
 * what gets rendered once it arrives. If the two ever disagree the screen shows
 * the server's answer, because that is the one in the record.
 *
 * ── Reasons ride in a header ────────────────────────────────────────────────
 *
 * Standing the team down and amending a locked score both need `x-reason`
 * (EN-024 §5). The transport's `reason` option puts it there rather than in
 * the body, so the policy guard can write the audit row before the handler runs.
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

// ── Triage ───────────────────────────────────────────────────────────────────

export interface TriageBody {
  readonly system?: 'esi' | 'start' | 'jump_start';
  readonly needsLifeSavingIntervention?: boolean;
  readonly highRisk?: boolean;
  readonly resourceCount?: number;
  readonly tag?: 'red' | 'yellow' | 'green' | 'black';
  readonly ageYears: number;
  readonly heartRate?: number;
  readonly respiratoryRate?: number;
  readonly systolicBp?: number;
  readonly diastolicBp?: number;
  readonly spo2?: number;
  readonly temperatureC?: number;
  readonly painScore?: number;
  readonly glucose?: number;
  readonly gcsEye?: number;
  readonly gcsVerbal?: number;
  readonly gcsMotor?: number;
  readonly gcsIntubated?: boolean;
  readonly chiefComplaint?: string;
  readonly pathways?: readonly string[];
  readonly assignedLevel?: number;
  readonly overrideReason?: string;
}

export async function triage(
  visitId: string,
  body: TriageBody,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<TriageResultView> {
  return request(`${V1}/trauma/visits/${visitId}/triage`, { method: 'POST', body, idempotencyKey });
}

export async function getTriageHistory(
  visitId: string,
  options: Signal = {},
): Promise<PageOf<TriageRecordView>> {
  return request(`${V1}/trauma/visits/${visitId}/triage`, withSignal(options));
}

// ── Activation ───────────────────────────────────────────────────────────────

export async function getTraumaBoard(
  filters: { readonly includeClosed?: boolean } = {},
  options: Signal = {},
): Promise<TraumaBoardView> {
  return request(
    `${V1}/trauma/board${queryString({ includeClosed: filters.includeClosed, limit: 100 })}`,
    withSignal(options),
  );
}

export async function activate(
  body: {
    readonly erVisitId: string;
    readonly tier: 'level_1' | 'level_2' | 'consult';
    readonly triageRecordId?: string;
    readonly criteriaFired?: readonly string[];
    readonly clinicalJudgement?: boolean;
  },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<TraumaActivationView> {
  return request(`${V1}/trauma/activations`, { method: 'POST', body, idempotencyKey });
}

export async function acknowledgePage(
  pageId: string,
  body: { readonly etaMinutes?: number; readonly arrived?: boolean },
): Promise<TraumaActivationView> {
  return request(`${V1}/trauma/pages/${pageId}/acknowledge`, { method: 'POST', body });
}

export async function standDown(
  activationId: string,
  reason: string,
  body: { readonly finalIss?: number } = {},
): Promise<TraumaActivationView> {
  return request(`${V1}/trauma/activations/${activationId}/standdown`, {
    method: 'POST',
    body,
    reason,
  });
}

// ── The primary survey ───────────────────────────────────────────────────────

export async function getSurvey(visitId: string, options: Signal = {}): Promise<PrimarySurveyView> {
  return request(`${V1}/trauma/visits/${visitId}/survey`, withSignal(options));
}

export async function recordSurvey(
  body: Readonly<Record<string, unknown>> & { readonly erVisitId: string },
): Promise<PrimarySurveyView> {
  return request(`${V1}/trauma/surveys`, { method: 'POST', body });
}

export async function addIntervention(
  visitId: string,
  body: { readonly kind: string; readonly detail?: string; readonly atTime?: string },
): Promise<PrimarySurveyView> {
  return request(`${V1}/trauma/visits/${visitId}/interventions`, { method: 'POST', body });
}

// ── Injuries and scores ──────────────────────────────────────────────────────

export async function listInjuries(visitId: string, options: Signal = {}): Promise<PageOf<TraumaInjuryView>> {
  return request(`${V1}/trauma/visits/${visitId}/injuries`, withSignal(options));
}

export async function addInjury(
  visitId: string,
  body: {
    readonly region: string;
    readonly aisSeverity: number;
    readonly description: string;
    readonly aisCode?: string;
    readonly side?: string;
  },
): Promise<PageOf<TraumaInjuryView>> {
  return request(`${V1}/trauma/visits/${visitId}/injuries`, { method: 'POST', body });
}

export async function removeInjury(visitId: string, injuryId: string): Promise<PageOf<TraumaInjuryView>> {
  return request(`${V1}/trauma/visits/${visitId}/injuries/${injuryId}`, { method: 'DELETE' });
}

export async function listScores(visitId: string, options: Signal = {}): Promise<PageOf<TraumaScoreView>> {
  return request(`${V1}/trauma/visits/${visitId}/scores`, withSignal(options));
}

export async function computeScores(body: {
  readonly erVisitId: string;
  readonly mechanism?: 'blunt' | 'penetrating';
  readonly arrivalGcs?: number;
  readonly arrivalSbp?: number;
  readonly arrivalRr?: number;
  readonly arrivalHeartRate?: number;
  readonly ageYears?: number;
}): Promise<TraumaScoreView> {
  return request(`${V1}/trauma/scores`, { method: 'POST', body });
}

export async function lockScore(scoreId: string): Promise<TraumaScoreView> {
  return request(`${V1}/trauma/scores/${scoreId}/lock`, { method: 'POST', body: {} });
}

export async function amendScore(
  body: { readonly erVisitId: string; readonly supersedesId: string; readonly mechanism?: string },
  reason: string,
): Promise<TraumaScoreView> {
  return request(`${V1}/trauma/scores/amend`, {
    method: 'POST',
    body,
    reason,
  });
}

// ── Mass casualty ────────────────────────────────────────────────────────────

export async function listMci(options: Signal = {}): Promise<PageOf<MciIncidentView>> {
  return request(`${V1}/trauma/mci`, withSignal(options));
}

export async function declareMci(
  body: { readonly name: string; readonly source?: 'local' | 'control_room' },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<MciIncidentView> {
  return request(`${V1}/trauma/mci`, { method: 'POST', body, idempotencyKey });
}

export async function standDownMci(
  id: string,
  reason: string,
  afterActionReport?: {
    readonly patientsSeen: number;
    readonly whatWorked?: string;
    readonly whatDidNot?: string;
  },
): Promise<MciIncidentView> {
  return request(`${V1}/trauma/mci/${id}/standdown`, {
    method: 'POST',
    body: afterActionReport === undefined ? {} : { afterActionReport },
    reason,
  });
}
