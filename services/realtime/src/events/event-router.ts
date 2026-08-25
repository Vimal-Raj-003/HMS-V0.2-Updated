import { parseRoom, rooms, type RoomName } from '../rooms/rooms.js';

/**
 * Which screens an event belongs on.
 *
 * `services/worker` relays every committed outbox row to `hms:events:<hospital>`
 * and — until this file existed — **nothing read that stream**. The gateway had
 * rooms, authorisation, presence and a coalescing emitter, and no domain event
 * ever reached any of them. Every board in `docs/01 §6` and every budget in
 * `docs/07 §2.3` ("event → WebSocket client p95 < 500 ms", "critical alert →
 * clinician device p95 < 1 s") described a path that was not connected.
 *
 * Two rules are enforced here and nowhere else, both structurally rather than by
 * convention:
 *
 * **A PHI event never reaches a display.** `EN-018 §5` forbids a patient
 * identifier on a screen in a public waiting area, and a TV board is exactly
 * that. The contract already marks each event `containsPhi`; this drops every
 * `display` room from such an event's fan-out. There is no option, no flag and
 * no second entry point — `routeEvent` is the only exported way to obtain rooms,
 * the same shape the CDSS safety floor uses, so a caller has nowhere to pass a
 * switch even if it wanted one.
 *
 * **A room always belongs to the event's own hospital.** Rooms are built from
 * `event.hospitalId` and then re-parsed and checked, because a routing bug that
 * put one hospital's event in another's room is a cross-tenant leak that no RLS
 * policy can catch: by this point the data has already left the database.
 *
 * Unrouted events are **counted, not silently dropped**. A missing entry here is
 * a screen that never updates, and the failure looks exactly like a working
 * system until somebody notices the board is stale.
 */

export interface StreamEvent {
  readonly id: string;
  readonly type: string;
  readonly aggregate: string;
  readonly aggregateId: string;
  readonly hospitalId: string;
  /** `''` on the wire when the event is not branch-scoped. */
  readonly branchId: string | null;
  readonly containsPhi: boolean;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
}

export interface RoutingDecision {
  readonly rooms: readonly RoomName[];
  /** Display rooms withheld because the event carries PHI. */
  readonly withheldFromDisplays: number;
  /** Rooms discarded for naming a hospital other than the event's. Always a bug. */
  readonly crossTenantDiscarded: number;
  /** True when no rule matched the type at all — a screen nobody is updating. */
  readonly unrouted: boolean;
}

/** A rule may read the payload; it may not decide policy. */
type Rule = (event: StreamEvent) => readonly RoomName[];

function str(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The queue room's descriptor field is called `doctorId` after `docs/01 §6`'s
 * "per-doctor queue", but a queue is not always a doctor — a sample-collection
 * or cash queue has none, and the events carry `queueId`. The value used is the
 * queue's id in every case, which keeps one room per queue. The field name is
 * worth correcting; nothing subscribes yet, so it is recorded rather than
 * renamed mid-flight.
 */
function queueRooms(event: StreamEvent): readonly RoomName[] {
  const queueId = str(event.payload, 'queueId');
  if (queueId === null) return [];
  const out: RoomName[] = [rooms.queue(event.hospitalId, event.branchId, queueId)];
  // The waiting-area board. Non-PHI queue events (a token number and a counter)
  // are precisely what belongs there; PHI ones are removed by the gate below.
  const screen = str(event.payload, 'screenId');
  if (screen !== null) out.push(rooms.display(event.hospitalId, event.branchId, screen));
  return out;
}

/** The clinician who ordered it, and the areas that act on it. */
function criticalRooms(event: StreamEvent): readonly RoomName[] {
  const out: RoomName[] = [
    rooms.er(event.hospitalId, event.branchId),
    rooms.bedboard(event.hospitalId, event.branchId),
  ];
  const doctor = str(event.payload, 'orderingDoctorUserId') ?? str(event.payload, 'orderingUserId');
  if (doctor !== null) out.push(rooms.user(event.hospitalId, event.branchId, doctor));
  return out;
}

/**
 * Deliberately partial and deliberately explicit.
 *
 * A wildcard "route everything to the bedboard" rule would make the unrouted
 * count zero and mean nothing. Each entry is a screen somebody asked for.
 */
const RULES: Readonly<Record<string, Rule>> = Object.freeze({
  'queue.token.issued': queueRooms,
  'queue.token.called': queueRooms,
  'queue.token.recalled': queueRooms,
  'queue.token.skipped': queueRooms,
  'queue.token.held': queueRooms,
  'queue.token.resumed': queueRooms,
  'queue.token.activated': queueRooms,
  'queue.token.completed': queueRooms,
  'queue.token.cancelled': queueRooms,
  'queue.token.no_show': queueRooms,
  'queue.token.expired': queueRooms,
  'queue.token.transferred': queueRooms,

  // The alert path `docs/07 §2.3` budgets at p95 < 1 s in-app.
  'lab.result.critical': criticalRooms,
  'lab.critical.escalated': criticalRooms,
  'lab.critical.acknowledged': criticalRooms,
  'rad.critical.escalated': criticalRooms,
  'rad.critical.acknowledged': criticalRooms,
  'lab.notifiable.detected': criticalRooms,
  'rad.contrast.reaction': criticalRooms,
});

/** Event types this build knows how to place. Exported so a test can prove coverage. */
export const ROUTED_EVENT_TYPES: readonly string[] = Object.freeze(Object.keys(RULES).sort());

/**
 * The only way to obtain rooms for an event.
 *
 * No options argument, by design: both gates below are policy, and a policy a
 * caller can pass a flag to is a policy that will eventually be passed one.
 */
export function routeEvent(event: StreamEvent): RoutingDecision {
  const rule = RULES[event.type];
  if (rule === undefined) {
    return { rooms: [], withheldFromDisplays: 0, crossTenantDiscarded: 0, unrouted: true };
  }

  const candidates = rule(event);

  // Gate 1 — tenancy. The data has already left the database, so no RLS policy
  // can catch a mistake here.
  const sameTenant: RoomName[] = [];
  let crossTenantDiscarded = 0;
  for (const room of candidates) {
    const parsed = parseRoom(room);
    if (parsed !== null && parsed.hospitalId === event.hospitalId) sameTenant.push(room);
    else crossTenantDiscarded += 1;
  }

  // Gate 2 — PHI never reaches a public screen (EN-018 §5).
  if (!event.containsPhi) {
    return { rooms: sameTenant, withheldFromDisplays: 0, crossTenantDiscarded, unrouted: false };
  }
  const withoutDisplays = sameTenant.filter((room) => parseRoom(room)?.kind !== 'display');
  return {
    rooms: withoutDisplays,
    withheldFromDisplays: sameTenant.length - withoutDisplays.length,
    crossTenantDiscarded,
    unrouted: false,
  };
}

/**
 * An event as a board diff.
 *
 * Keyed by aggregate id so that two updates to the same token, bed or alert
 * inside one coalescing window merge into the newest rather than queueing —
 * which is what `mergeBoardDiff` does with the key and why the key must be the
 * thing that changes, not the event id.
 *
 * The payload travels intact. It is safe to: `routeEvent` has already removed
 * every display room from a PHI event, so the only rooms left are ones whose
 * subscribers are authorised for the branch (`canJoinRoom`) and, for a user
 * room, are that user.
 */
export function eventToDiff(event: StreamEvent): {
  readonly changed: Readonly<Record<string, unknown>>;
  readonly removed: readonly string[];
} {
  const key = event.aggregateId.length > 0 ? event.aggregateId : event.id;
  return {
    changed: {
      [key]: {
        type: event.type,
        aggregate: event.aggregate,
        occurredAt: event.occurredAt,
        ...event.payload,
      },
    },
    removed: [],
  };
}
