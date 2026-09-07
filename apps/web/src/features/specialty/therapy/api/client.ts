import { newIdempotencyKey, queryString, request } from '@/features/specialty/api/http';
import type {
  AssessmentRow,
  DietPlanRow,
  EpisodeDetail,
  EpisodeRow,
  GoalRow,
  NutritionAssessmentRow,
  PlanRow,
  SessionRow,
  SwallowOrderRow,
  WoundDetail,
  WoundRow,
} from './types';

/**
 * Every call the therapy consoles make.
 *
 * ── What is absent is the design ────────────────────────────────────────────
 *
 * No `setWoundArea`, no `setDietTotals`, no `closeEpisodeAnyway`, and no
 * `acknowledge` on the swallow-order write. Each of those would be a way past a
 * rule the database enforces, and the two that legitimately exist —
 * `extendAuthorisation` and `overrideCloseWound` — are separate calls that take
 * a reason and travel with their own permission.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}
function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

// ── OP-015 the spine ─────────────────────────────────────────────────────────

export async function getEpisodes(
  filters: { readonly patientId?: string; readonly discipline?: string; readonly openOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly EpisodeRow[]> {
  return request(
    `${V1}/therapy/episodes${queryString({
      patientId: filters.patientId,
      discipline: filters.discipline,
      openOnly: filters.openOnly,
    })}`,
    withSignal(options),
  );
}

export async function getEpisode(id: string, options: Signal = {}): Promise<EpisodeDetail> {
  return request(`${V1}/therapy/episodes/${id}`, withSignal(options));
}

export async function openEpisode(body: Record<string, unknown>): Promise<EpisodeRow> {
  return request(`${V1}/therapy/episodes`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function recordAssessment(
  episodeId: string,
  body: Record<string, unknown>,
): Promise<AssessmentRow> {
  return request(`${V1}/therapy/episodes/${episodeId}/assessments`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function signAssessment(id: string): Promise<AssessmentRow> {
  return request(`${V1}/therapy/assessments/${id}/sign`, { method: 'POST', body: {} });
}

export async function addGoal(episodeId: string, body: Record<string, unknown>): Promise<GoalRow> {
  return request(`${V1}/therapy/episodes/${episodeId}/goals`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function resolveGoal(
  id: string,
  body: { readonly status: string; readonly outcomeNote: string },
): Promise<GoalRow> {
  return request(`${V1}/therapy/goals/${id}/resolve`, { method: 'POST', body });
}

export async function writePlan(episodeId: string, body: Record<string, unknown>): Promise<PlanRow> {
  return request(`${V1}/therapy/episodes/${episodeId}/plans`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function bookSession(episodeId: string, body: Record<string, unknown>): Promise<SessionRow> {
  return request(`${V1}/therapy/episodes/${episodeId}/sessions`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function attendSession(id: string, body: Record<string, unknown>): Promise<SessionRow> {
  return request(`${V1}/therapy/sessions/${id}/attend`, { method: 'POST', body });
}

export async function markNoShow(id: string): Promise<SessionRow> {
  return request(`${V1}/therapy/sessions/${id}/no-show`, { method: 'POST', body: {} });
}

/** The eleventh session of a package of ten. Behind the payer desk's key. */
export async function extendAuthorisation(
  id: string,
  body: { readonly sessionsAuthorised: number; readonly reason: string },
): Promise<EpisodeRow> {
  return request(`${V1}/therapy/episodes/${id}/authorisation`, {
    method: 'POST',
    body,
    reason: body.reason,
  });
}

export async function dischargeEpisode(id: string, outcome: string): Promise<EpisodeRow> {
  return request(`${V1}/therapy/episodes/${id}/discharge`, { method: 'POST', body: { outcome } });
}

// ── OP-017 wound care ────────────────────────────────────────────────────────

export async function getWounds(
  filters: { readonly patientId?: string; readonly openOnly?: boolean; readonly needsReview?: boolean } = {},
  options: Signal = {},
): Promise<readonly WoundRow[]> {
  return request(
    `${V1}/wounds${queryString({
      patientId: filters.patientId,
      openOnly: filters.openOnly,
      needsReview: filters.needsReview,
    })}`,
    withSignal(options),
  );
}

export async function getWound(id: string, options: Signal = {}): Promise<WoundDetail> {
  return request(`${V1}/wounds/${id}`, withSignal(options));
}

export async function openWound(body: Record<string, unknown>): Promise<WoundRow> {
  return request(`${V1}/wounds`, { method: 'POST', body, idempotencyKey: newIdempotencyKey() });
}

/**
 * Record a measurement.
 *
 * Length and width go up; the area, the reduction and the trajectory come back.
 * There is no third field to send.
 */
export async function assessWound(woundId: string, body: Record<string, unknown>): Promise<WoundDetail> {
  return request(`${V1}/wounds/${woundId}/assessments`, { method: 'POST', body });
}

export async function recordDressing(woundId: string, body: Record<string, unknown>): Promise<WoundDetail> {
  return request(`${V1}/wounds/${woundId}/dressings`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function closeWound(id: string, status: string): Promise<WoundRow> {
  return request(`${V1}/wounds/${id}/close`, { method: 'POST', body: { status } });
}

/** The wound that healed elsewhere. Writes the closing measurement it stands in for. */
export async function overrideCloseWound(id: string, reason: string): Promise<WoundRow> {
  return request(`${V1}/wounds/${id}/close/override`, {
    method: 'POST',
    body: { reason },
    reason,
  });
}

// ── OP-011 dietetics ─────────────────────────────────────────────────────────

export async function getDietPlans(
  filters: { readonly patientId?: string } = {},
  options: Signal = {},
): Promise<readonly DietPlanRow[]> {
  return request(
    `${V1}/nutrition/plans${queryString({ patientId: filters.patientId })}`,
    withSignal(options),
  );
}

export async function getNutritionAssessments(
  filters: { readonly patientId?: string } = {},
  options: Signal = {},
): Promise<readonly NutritionAssessmentRow[]> {
  return request(
    `${V1}/nutrition/assessments${queryString({ patientId: filters.patientId })}`,
    withSignal(options),
  );
}

/** Drafting returns the summed totals, so a dietician sees them before signing. */
export async function draftDietPlan(body: Record<string, unknown>): Promise<DietPlanRow> {
  return request(`${V1}/nutrition/plans`, {
    method: 'POST',
    body,
    idempotencyKey: newIdempotencyKey(),
  });
}

export async function activateDietPlan(id: string): Promise<DietPlanRow> {
  return request(`${V1}/nutrition/plans/${id}/activate`, { method: 'POST', body: {} });
}

// ── OP-035 speech and swallow ────────────────────────────────────────────────

export async function getSwallowOrders(
  filters: { readonly patientId?: string; readonly awaitingAckOnly?: boolean } = {},
  options: Signal = {},
): Promise<readonly SwallowOrderRow[]> {
  return request(
    `${V1}/slp/orders${queryString({
      patientId: filters.patientId,
      awaitingAckOnly: filters.awaitingAckOnly,
    })}`,
    withSignal(options),
  );
}

export async function issueSwallowOrder(body: Record<string, unknown>): Promise<SwallowOrderRow> {
  return request(`${V1}/slp/orders`, { method: 'POST', body, idempotencyKey: newIdempotencyKey() });
}

/**
 * The kitchen or the ward saying it has read the order.
 *
 * A separate call because it is a separate key: the therapist who wrote it does
 * not hold it, and one person cannot stand in for both departments.
 */
export async function acknowledgeSwallowOrder(
  id: string,
  party: 'kitchen' | 'ward',
): Promise<SwallowOrderRow> {
  return request(`${V1}/slp/orders/${id}/acknowledge`, { method: 'POST', body: { party } });
}
