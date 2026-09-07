import { newIdempotencyKey, queryString, request } from '@/features/specialty/api/http';
import type {
  AcuityRow,
  DiagnosisRow,
  ExamRow,
  IopRow,
  RefractionRow,
  SpectacleRxRow,
  SurgeryPlanRow,
  TrendPoint,
  VisitDetail,
  VisitRow,
} from './types';

/**
 * Every call the eye clinic makes.
 *
 * There is deliberately no `orderInvestigation` here: an OCT is ordered through
 * the framework's `specialty/device-orders`, which is what keeps one upload
 * path across thirty consoles.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}
function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

export async function getVisits(
  filters: { readonly openOnly?: boolean; readonly stage?: string } = {},
  options: Signal = {},
): Promise<readonly VisitRow[]> {
  return request(
    `${V1}/ophtha/visits${queryString({ openOnly: filters.openOnly, stage: filters.stage })}`,
    withSignal(options),
  );
}

export async function getVisit(id: string, options: Signal = {}): Promise<VisitDetail> {
  return request(`${V1}/ophtha/visits/${id}`, withSignal(options));
}

export async function openVisit(body: {
  readonly patientId: string;
  readonly encounterId: string;
}): Promise<VisitRow> {
  return request(`${V1}/ophtha/visits`, { method: 'POST', body, idempotencyKey: newIdempotencyKey() });
}

export async function recordAcuities(
  visitId: string,
  readings: readonly Record<string, unknown>[],
): Promise<readonly AcuityRow[]> {
  return request(`${V1}/ophtha/visits/${visitId}/acuity`, { method: 'POST', body: { readings } });
}

export async function recordRefractions(
  visitId: string,
  refractions: readonly Record<string, unknown>[],
): Promise<readonly RefractionRow[]> {
  return request(`${V1}/ophtha/visits/${visitId}/refractions`, { method: 'POST', body: { refractions } });
}

export async function recordIop(
  visitId: string,
  readings: readonly Record<string, unknown>[],
): Promise<readonly IopRow[]> {
  return request(`${V1}/ophtha/visits/${visitId}/iop`, { method: 'POST', body: { readings } });
}

export async function dilate(
  visitId: string,
  body: { readonly drug: string; readonly cycloplegic: boolean },
): Promise<VisitRow> {
  return request(`${V1}/ophtha/visits/${visitId}/dilate`, { method: 'PATCH', body });
}

export async function recordExam(visitId: string, body: Record<string, unknown>): Promise<ExamRow> {
  return request(`${V1}/ophtha/visits/${visitId}/exam`, { method: 'POST', body });
}

export async function recordDiagnoses(
  visitId: string,
  diagnoses: readonly Record<string, unknown>[],
): Promise<readonly DiagnosisRow[]> {
  return request(`${V1}/ophtha/visits/${visitId}/diagnoses`, { method: 'POST', body: { diagnoses } });
}

export async function signVisit(visitId: string): Promise<VisitRow> {
  return request(`${V1}/ophtha/visits/${visitId}/sign`, {
    method: 'POST',
    body: {},
    idempotencyKey: newIdempotencyKey(),
  });
}

/** The doctor's signature. The optometrist's is a different route and key. */
export async function signSpectacleRx(
  visitId: string,
  body: Record<string, unknown>,
): Promise<SpectacleRxRow> {
  return request(`${V1}/ophtha/visits/${visitId}/spectacle-rx`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function signSpectacleRxDelegated(
  visitId: string,
  body: Record<string, unknown>,
): Promise<SpectacleRxRow> {
  return request(`${V1}/ophtha/visits/${visitId}/spectacle-rx/delegated`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function planSurgery(visitId: string, body: Record<string, unknown>): Promise<SurgeryPlanRow> {
  return request(`${V1}/ophtha/visits/${visitId}/surgery-plans`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function updateSurgeryStatus(
  id: string,
  body: { readonly status: string; readonly reason?: string; readonly otCaseId?: string },
): Promise<SurgeryPlanRow> {
  return request(`${V1}/ophtha/surgery-plans/${id}`, { method: 'PATCH', body });
}

export async function getTrend(
  patientId: string,
  metric: 'iop' | 'logmar' | 'cdr',
  options: Signal = {},
): Promise<readonly TrendPoint[]> {
  return request(`${V1}/ophtha/patients/${patientId}/trends${queryString({ metric })}`, withSignal(options));
}
