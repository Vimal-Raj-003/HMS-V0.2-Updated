import { newIdempotencyKey, queryString, request } from '@/features/specialty/api/http';
import type {
  AudiologyTestDetail,
  AudiologyTestRow,
  BiopsyRow,
  DentalChartDetail,
  DentalPlanRow,
  EcgRow,
  InrVisitRow,
  LesionRow,
  PapRxRow,
  PftRow,
  PhototherapyCourseRow,
  PhototherapySessionRow,
  SleepStudyRow,
} from './types';

/**
 * Every call the five device consoles make.
 *
 * There is deliberately no `orderInvestigation` here either: an ECG, a
 * spirometry trace, an audiogram, an OPG and a dermoscopy image all go through
 * the framework's `specialty/device-orders`, which is what keeps one upload
 * path across thirty consoles rather than thirty.
 *
 * And no `setQtc`, `setRatio`, `setPtaAvg`, `setPasi` or `saveChart`. Those
 * numbers are the database's; the client's job is to show them.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}
function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

// ── OP-029 cardiology ────────────────────────────────────────────────────────

export async function getEcgs(
  filters: { readonly patientId?: string; readonly unacknowledgedOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly EcgRow[]> {
  return request(
    `${V1}/cardio/ecgs${queryString({
      patientId: filters.patientId,
      unacknowledgedOnly: filters.unacknowledgedOnly,
    })}`,
    withSignal(options),
  );
}

export async function readEcg(
  id: string,
  body: { readonly interpretation: readonly string[]; readonly critical: boolean; readonly status: string },
): Promise<EcgRow> {
  return request(`${V1}/cardio/ecgs/${id}/read`, { method: 'POST', body });
}

/**
 * The handover.
 *
 * `toldTo` is who was told; who did the telling is the session's, and the
 * screen shows that rather than offering a field for it.
 */
export async function acknowledgeEcg(id: string, toldTo: string): Promise<EcgRow> {
  return request(`${V1}/cardio/ecgs/${id}/acknowledge`, { method: 'POST', body: { toldTo } });
}

export async function getInrVisits(
  enrolmentId: string,
  options: Signal = {},
): Promise<readonly InrVisitRow[]> {
  return request(`${V1}/cardio/anticoagulation/${enrolmentId}/visits`, withSignal(options));
}

export async function recordInrVisit(
  enrolmentId: string,
  body: Record<string, unknown>,
): Promise<InrVisitRow> {
  return request(`${V1}/cardio/anticoagulation/${enrolmentId}/visits`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

// ── OP-030 pulmonology ───────────────────────────────────────────────────────

export async function getPfts(
  filters: { readonly patientId?: string } = {},
  options: Signal = {},
): Promise<readonly PftRow[]> {
  return request(`${V1}/pulmo/pft${queryString({ patientId: filters.patientId })}`, withSignal(options));
}

export async function interpretPft(
  id: string,
  body: { readonly interpretation: string; readonly qualityGrade: string },
): Promise<PftRow> {
  return request(`${V1}/pulmo/pft/${id}/interpret`, { method: 'POST', body });
}

export async function getSleepStudies(
  filters: { readonly patientId?: string; readonly openOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly SleepStudyRow[]> {
  return request(
    `${V1}/pulmo/sleep-studies${queryString({ patientId: filters.patientId, openOnly: filters.openOnly })}`,
    withSignal(options),
  );
}

export async function scoreSleepStudy(id: string, body: Record<string, unknown>): Promise<SleepStudyRow> {
  return request(`${V1}/pulmo/sleep-studies/${id}/score`, { method: 'POST', body });
}

export async function getPapRx(
  filters: { readonly patientId?: string } = {},
  options: Signal = {},
): Promise<readonly PapRxRow[]> {
  return request(`${V1}/pulmo/pap${queryString({ patientId: filters.patientId })}`, withSignal(options));
}

// ── OP-028 ENT and audiology ─────────────────────────────────────────────────

export async function getAudiologyTests(
  filters: { readonly patientId?: string; readonly openOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly AudiologyTestRow[]> {
  return request(
    `${V1}/ent/audiology${queryString({ patientId: filters.patientId, openOnly: filters.openOnly })}`,
    withSignal(options),
  );
}

export async function getAudiologyTest(id: string, options: Signal = {}): Promise<AudiologyTestDetail> {
  return request(`${V1}/ent/audiology/${id}`, withSignal(options));
}

export async function recordThresholds(
  testId: string,
  thresholds: readonly Record<string, unknown>[],
): Promise<AudiologyTestDetail> {
  return request(`${V1}/ent/audiology/${testId}/thresholds`, { method: 'POST', body: { thresholds } });
}

export async function signAudiologyTest(testId: string): Promise<AudiologyTestDetail> {
  return request(`${V1}/ent/audiology/${testId}/sign`, { method: 'POST', body: {} });
}

// ── OP-026 dental ────────────────────────────────────────────────────────────

export async function getDentalChart(patientId: string, options: Signal = {}): Promise<DentalChartDetail> {
  return request(`${V1}/dental/charts/${patientId}`, withSignal(options));
}

/** The only write to the chart. The snapshot follows; it is never sent. */
export async function recordToothEvent(body: Record<string, unknown>): Promise<DentalChartDetail> {
  return request(`${V1}/dental/tooth-events`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function getDentalPlans(
  filters: { readonly patientId?: string; readonly openOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly DentalPlanRow[]> {
  return request(
    `${V1}/dental/plans${queryString({ patientId: filters.patientId, openOnly: filters.openOnly })}`,
    withSignal(options),
  );
}

export async function presentDentalPlan(id: string): Promise<DentalPlanRow> {
  return request(`${V1}/dental/plans/${id}/present`, { method: 'POST', body: {} });
}

export async function acceptDentalPlan(id: string, acceptedVia: string): Promise<DentalPlanRow> {
  return request(`${V1}/dental/plans/${id}/accept`, { method: 'POST', body: { acceptedVia } });
}

// ── OP-027 dermatology ───────────────────────────────────────────────────────

export async function getLesions(
  filters: { readonly patientId?: string; readonly openOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly LesionRow[]> {
  return request(
    `${V1}/derm/lesions${queryString({ patientId: filters.patientId, openOnly: filters.openOnly })}`,
    withSignal(options),
  );
}

export async function getBiopsies(
  filters: { readonly patientId?: string; readonly openOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly BiopsyRow[]> {
  return request(
    `${V1}/derm/biopsies${queryString({ patientId: filters.patientId, openOnly: filters.openOnly })}`,
    withSignal(options),
  );
}

export async function getPhototherapyCourses(
  filters: { readonly patientId?: string; readonly openOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly PhototherapyCourseRow[]> {
  return request(
    `${V1}/derm/phototherapy${queryString({ patientId: filters.patientId, openOnly: filters.openOnly })}`,
    withSignal(options),
  );
}

/**
 * Deliver one session.
 *
 * The body carries a dose and an erythema grade and nothing else. Raising the
 * ceiling is `raisePhototherapyCeiling` — a different call behind a different
 * key, because the two being one call is how a limit gets moved by the person
 * who wanted to exceed it.
 */
export async function deliverPhototherapySession(
  courseId: string,
  body: { readonly doseMj: number; readonly erythemaGrade: number },
): Promise<PhototherapySessionRow> {
  return request(`${V1}/derm/phototherapy/${courseId}/sessions`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function raisePhototherapyCeiling(
  courseId: string,
  body: { readonly maxDoseMj: number; readonly reason: string },
): Promise<PhototherapyCourseRow> {
  return request(`${V1}/derm/phototherapy/${courseId}/ceiling`, {
    method: 'POST',
    body,
    reason: body.reason,
  });
}
