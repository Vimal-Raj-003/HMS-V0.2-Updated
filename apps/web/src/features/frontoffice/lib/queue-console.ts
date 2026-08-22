import type { QueueEntry, QueuePriority, QueueTokenState } from '@vims/ui';
import type { TokenClass, TokenSource, TokenStatus, TokenView } from '../api/types';
import { minutesBetween, secondsBetween, timeOf } from './time';

/**
 * `TokenView` → `QueueEntry`, and the two honesty problems in that mapping.
 *
 * **1. Reasons.** `QueueTokenState` requires a reason on `on-hold` and `skipped`,
 * and rightly: EN-006 §3.3 says a skip is never silent. `TokenView` carries no
 * reason column — the reason is written to the audit trail, not returned on the
 * token — so a reason the console itself has just submitted is passed in through
 * `knownReasons` and shown immediately, and anything older falls back to a
 * sentence that says where the reason actually is rather than pretending there
 * is none.
 *
 * **2. Priority lanes.** `QueuePriority` has five members and `TokenClass` has
 * nine. The extra four (pregnant, infant, staff, VIP) are collapsed onto the
 * nearest lane **and** the exact class is always rendered as a chip, so nothing
 * is hidden by the collapse. Inventing a lane would have been worse: the lane
 * drives the tile's icon, and a "differently-abled" icon over a pregnant
 * patient's token is a mistake staff would read as a data error.
 */

export const TOKEN_CLASS_LABELS: Readonly<Record<TokenClass, string>> = {
  regular: 'Walk-in',
  appointment: 'Appointment',
  priority_emergency: 'Emergency',
  priority_senior: 'Senior citizen',
  priority_pregnant: 'Pregnant',
  priority_disabled: 'Differently abled',
  priority_infant: 'Infant in arms',
  priority_staff: 'Staff',
  priority_vip: 'VIP',
};

export const TOKEN_SOURCE_LABELS: Readonly<Record<TokenSource, string>> = {
  desk: 'Desk',
  kiosk: 'Kiosk',
  app: 'App',
  portal: 'Portal',
  call_centre: 'Call centre',
  er: 'Emergency',
  ward: 'Ward',
  auto_forward: 'Forwarded',
};

/** Lanes, with the exact class always shown as a chip beside the tile. */
export function priorityLaneOf(tokenClass: TokenClass): QueuePriority {
  switch (tokenClass) {
    case 'priority_emergency':
      return 'emergency';
    case 'priority_senior':
    case 'priority_pregnant':
    case 'priority_infant':
      return 'senior-citizen';
    case 'priority_disabled':
      return 'differently-abled';
    case 'appointment':
      return 'appointment';
    case 'regular':
    case 'priority_staff':
    case 'priority_vip':
      return 'walk-in';
  }
}

export const REASON_IN_AUDIT_TRAIL =
  'Reason recorded against this token in the audit trail; it is not returned on the queue.';

export interface QueueMappingContext {
  readonly now: Date;
  /** Reasons this console has just submitted, so the tile is truthful immediately. */
  readonly knownReasons?: ReadonlyMap<string, string>;
  readonly timeZone?: string;
}

/** Statuses that are still in the queue and therefore count toward a position. */
const WAITING_STATUSES = new Set<TokenStatus>(['issued', 'awaiting_payment', 'waiting']);

export function isWaiting(status: TokenStatus): boolean {
  return WAITING_STATUSES.has(status);
}

/** Statuses being served at a counter right now — what "Complete" acts on. */
export function isBeingServed(status: TokenStatus): boolean {
  return status === 'called' || status === 'recalled' || status === 'in_service';
}

export function tokenStateOf(
  token: TokenView,
  position: number,
  context: QueueMappingContext,
): QueueTokenState {
  const reason = context.knownReasons?.get(token.id) ?? REASON_IN_AUDIT_TRAIL;
  const room = token.room_key ?? token.counter_id ?? 'this counter';

  switch (token.status) {
    case 'issued':
    case 'awaiting_payment':
    case 'waiting':
      return { kind: 'waiting', position };
    case 'called':
    case 'recalled':
      return {
        kind: 'called',
        room,
        secondsSinceCall:
          token.called_at === null ? 0 : secondsBetween(new Date(token.called_at), context.now),
      };
    case 'in_service':
      return { kind: 'in-progress', room };
    case 'held':
      return { kind: 'on-hold', reason };
    case 'skipped':
      return { kind: 'skipped', reason };
    case 'served':
      return { kind: 'completed' };
    case 'transferred':
      // It left this queue on purpose and is somebody else's problem now; showing
      // it as "no-show" would blame the patient for a decision the desk made.
      return { kind: 'completed' };
    case 'no_show':
    case 'cancelled':
    case 'expired':
      return { kind: 'no-show' };
  }
}

export function toQueueEntry(token: TokenView, position: number, context: QueueMappingContext): QueueEntry {
  const flags: string[] = [TOKEN_CLASS_LABELS[token.class]];
  if (token.skip_count > 0) flags.push(`Skipped ×${String(token.skip_count)}`);
  if (token.recall_count > 0) flags.push(`Recalled ×${String(token.recall_count)}`);

  const issuedAt = new Date(token.issued_at);
  const issuedTime = context.timeZone === undefined ? timeOf(issuedAt) : timeOf(issuedAt, context.timeZone);

  return {
    tokenId: token.id,
    token: token.token_display,
    state: tokenStateOf(token, position, context),
    priority: priorityLaneOf(token.class),
    // No name, ever, on a counter screen that a waiting room can see over the
    // clerk's shoulder (docs/06 §1.2.8). The class and the source are the two
    // facts a caller actually needs, and neither is PHI.
    maskedLabel: `${TOKEN_CLASS_LABELS[token.class]} · ${TOKEN_SOURCE_LABELS[token.source]}`,
    visitType: `Issued ${issuedTime}`,
    waitedMinutes: minutesBetween(issuedAt, context.now),
    ...(token.est_wait_sec_at_issue === null
      ? {}
      : { estimatedWaitMinutes: Math.round(token.est_wait_sec_at_issue / 60) }),
    flags,
  };
}

/**
 * The console's list: waiting tokens first in service order, then everything
 * that has already been dealt with.
 *
 * Positions are assigned over the waiting set only — a "position 7" that counted
 * three already-served tokens is a number that tells a patient the wrong thing.
 * Within waiting, the API's `priority_rank` decides, then the token number, which
 * is the same order `call-next` will pick in.
 */
export function buildQueueEntries(
  tokens: readonly TokenView[],
  context: QueueMappingContext,
): readonly QueueEntry[] {
  const waiting = tokens
    .filter((token) => isWaiting(token.status))
    .toSorted((a, b) => a.priority_rank - b.priority_rank || a.token_no - b.token_no);
  const rest = tokens.filter((token) => !isWaiting(token.status)).toSorted((a, b) => b.token_no - a.token_no);

  return [
    ...waiting.map((token, index) => toQueueEntry(token, index + 1, context)),
    ...rest.map((token) => toQueueEntry(token, 0, context)),
  ];
}

/** The token this counter is serving: what Complete and Recall act on. */
export function currentlyServing(
  tokens: readonly TokenView[],
  preferredTokenId: string | null,
): TokenView | null {
  if (preferredTokenId !== null) {
    const preferred = tokens.find((token) => token.id === preferredTokenId && isBeingServed(token.status));
    if (preferred !== undefined) return preferred;
  }
  const serving = tokens.filter((token) => isBeingServed(token.status));
  // Most recently called: the one physically at the window.
  return serving.toSorted((a, b) => (b.called_at ?? '').localeCompare(a.called_at ?? ''))[0] ?? null;
}

/**
 * EN-006's skip reasons.
 *
 * Coded rather than free-text-only because a skip is a statistic as well as an
 * event: "patient absent" and "documents incomplete" mean different things for
 * the no-show rate, and a free-text field turns both into an unqueryable string.
 * `other` still forces a note.
 */
export const SKIP_REASONS = [
  { code: 'patient_absent', label: 'Patient did not answer the call' },
  { code: 'patient_stepped_out', label: 'Patient stepped out — will return' },
  { code: 'documents_pending', label: 'Documents or payment pending' },
  { code: 'clinical_priority', label: 'Someone clinically more urgent went first' },
  { code: 'wrong_queue', label: 'Wrong queue — being redirected' },
  { code: 'other', label: 'Other (explain below)', requiresNote: true },
] as const;

export const TRANSFER_REASONS = [
  { code: 'wrong_queue', label: 'Issued to the wrong queue' },
  { code: 'doctor_unavailable', label: 'Doctor unavailable — moving to a colleague' },
  { code: 'load_balancing', label: 'Balancing the load across counters' },
  { code: 'clinical', label: 'Clinical reason' },
  { code: 'other', label: 'Other (explain below)', requiresNote: true },
] as const;
