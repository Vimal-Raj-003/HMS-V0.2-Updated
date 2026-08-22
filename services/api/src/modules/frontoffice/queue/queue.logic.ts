/**
 * EN-006 — the parts of the queue that are pure arithmetic.
 *
 * Kept out of the service so they can be tested without a database: the ordering
 * of a queue and the shape of a token number are the two things a hospital will
 * argue about, and both must be checkable in a unit test that runs in
 * milliseconds.
 */

/** `queue.QueueTokenClass` — the enum as it exists in the migration. */
export type TokenClass =
  | 'regular'
  | 'appointment'
  | 'priority_emergency'
  | 'priority_senior'
  | 'priority_pregnant'
  | 'priority_disabled'
  | 'priority_infant'
  | 'priority_staff'
  | 'priority_vip';

/** `queue.QueueTokenStatus`. */
export type TokenStatus =
  | 'issued'
  | 'awaiting_payment'
  | 'waiting'
  | 'called'
  | 'recalled'
  | 'in_service'
  | 'held'
  | 'skipped'
  | 'no_show'
  | 'served'
  | 'transferred'
  | 'cancelled'
  | 'expired';

/**
 * Statuses that make a token *active* for the purpose of "one active token per
 * patient per queue per day" (EN-006 §5).
 *
 * `served`, `no_show`, `cancelled`, `expired` and `transferred` are deliberately
 * absent: a patient seen this morning must be able to take a second token in the
 * same queue this afternoon, which is exactly why this rule cannot be a unique
 * index (a unique index on a partitioned table may not be partial — see the note
 * beside `idx_queue_tokens_patient_day` in the Phase-1 migration).
 */
export const ACTIVE_TOKEN_STATUSES: readonly TokenStatus[] = Object.freeze([
  'issued',
  'awaiting_payment',
  'waiting',
  'called',
  'recalled',
  'in_service',
  'held',
  'skipped',
]);

/** Statuses the caller may still act on. */
export const LIVE_TOKEN_STATUSES: readonly TokenStatus[] = ACTIVE_TOKEN_STATUSES;

/**
 * Effective priority weight per class (EN-006 §3.5).
 *
 * `priority_emergency` sits far above everything else because EN-006 §5 makes it
 * a patient-safety rule rather than a courtesy: "ER `EM` class always front
 * (safety)". The remaining ranks are the statutory/NABH priority groups —
 * senior citizens, pregnant women, persons with disabilities, infants — then
 * hospital courtesy classes, then appointments (which are ordered by their slot
 * time, not by weight), then walk-ins.
 */
const PRIORITY_RANKS: Readonly<Record<TokenClass, number>> = Object.freeze({
  priority_emergency: 100,
  priority_senior: 60,
  priority_pregnant: 60,
  priority_disabled: 60,
  priority_infant: 50,
  priority_vip: 40,
  priority_staff: 30,
  appointment: 10,
  regular: 0,
});

export function priorityRankFor(tokenClass: TokenClass): number {
  return PRIORITY_RANKS[tokenClass];
}

export function isPriorityClass(tokenClass: TokenClass): boolean {
  return tokenClass.startsWith('priority_');
}

/**
 * `A-023` — prefix, hyphen, number zero-padded to the queue's configured width.
 *
 * The width is clamped rather than trusted: a misconfigured width of 0 would
 * render token 7 as `A-7` on the slip and `A-007` on the board once somebody
 * fixed the config, and the patient holding the slip would not recognise their
 * own number.
 */
export function formatTokenDisplay(prefix: string, tokenNo: number, numberWidth: number): string {
  const width = Math.min(Math.max(Math.trunc(numberWidth), 1), 8);
  return `${prefix}-${String(tokenNo).padStart(width, '0')}`;
}

/**
 * Estimated wait at issue: position in the queue x the queue's service time.
 *
 * EN-006 §5 asks for an EWMA of the last 20 service times; the rolling figure
 * lives in `queue.queue_wait_stats.ewma_service_sec` and is used when it has
 * been populated, falling back to the queue's configured seed. Anything cleverer
 * (the ML estimate behind `queue.ml_wait`) is AI-005 and deliberately not here.
 */
export function estimateWaitSeconds(positionAhead: number, serviceSeconds: number): number {
  const ahead = Math.max(Math.trunc(positionAhead), 0);
  const service = Math.max(Math.trunc(serviceSeconds), 0);
  return ahead * service;
}

/**
 * Skip policy (EN-006 §5): "after M skips → no_show", default M = 2.
 *
 * Returns the status the token lands in *after* this skip.
 */
export function statusAfterSkip(skipCountAfterIncrement: number, maxSkips: number): 'skipped' | 'no_show' {
  const limit = maxSkips > 0 ? maxSkips : 2;
  return skipCountAfterIncrement >= limit ? 'no_show' : 'skipped';
}

/** Seconds between two instants, floored at zero and rounded to a whole second. */
export function elapsedSeconds(from: Date, to: Date): number {
  const seconds = Math.round((to.getTime() - from.getTime()) / 1000);
  return seconds > 0 ? seconds : 0;
}
