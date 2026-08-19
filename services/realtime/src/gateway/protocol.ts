import { z } from 'zod';
import type { AccessTokenClaims } from '../auth/access-token.js';
import type { BoardDiff, RoomPushMessage } from '../emit/coalescing-emitter.js';
import type { PresenceChange } from '../presence/presence.js';
import { roomDescriptorSchema, type JoinDenialReason } from '../rooms/rooms.js';

/**
 * The wire contract.
 *
 * A client never sends a room *string* — it sends a typed descriptor, and the
 * server builds the name. That is not ceremony: it is what makes the tenant
 * check in `canJoinRoom` a check on a value this process constructed from
 * validated fields, rather than a check on attacker-controlled text.
 *
 * There is also no client→server *broadcast* event of any kind. Sockets are
 * strictly readers; everything that fans out originates from a domain event on
 * the outbox relay. A client that could emit into a room could forge a critical
 * lab value onto a ward board.
 */
export const subscriptionRequestSchema = z.object({
  room: roomDescriptorSchema,
  /** The cursor from the client's last push for this room (reconnect). */
  since: z.string().max(128).optional(),
});

export const subscribeRequestSchema = z.object({
  subscriptions: z.array(subscriptionRequestSchema).min(1).max(64),
});

export const unsubscribeRequestSchema = z.object({
  rooms: z.array(roomDescriptorSchema).min(1).max(64),
});

export const presenceListRequestSchema = z.object({}).default({});

export type SubscribeRequest = z.infer<typeof subscribeRequestSchema>;
export type UnsubscribeRequest = z.infer<typeof unsubscribeRequestSchema>;

export type DenialReason = JoinDenialReason | 'invalid_descriptor' | 'room_limit_exceeded';

export interface JoinedRoom {
  readonly room: string;
  /** Send this back as `?since=` when reconciling. */
  readonly cursor: string;
  /**
   * `true` when the client's `since` is not the room's current cursor, i.e. it
   * missed at least one coalesced push and must not apply the next diff to a
   * stale base. `docs/01` §6's reconnect rule, made explicit.
   */
  readonly resyncRequired: boolean;
  /** Fully-formed REST call for the reconciliation snapshot. */
  readonly snapshotUrl: string;
}

export interface DeniedRoom {
  readonly room: string | null;
  readonly reason: DenialReason;
}

export interface SubscribeAck {
  readonly ok: boolean;
  readonly joined: readonly JoinedRoom[];
  readonly denied: readonly DeniedRoom[];
}

export interface UnsubscribeAck {
  readonly ok: boolean;
  readonly left: readonly string[];
  readonly denied: readonly DeniedRoom[];
}

export interface PresenceListAck {
  readonly ok: boolean;
  readonly hospitalId: string;
  readonly userIds: readonly string[];
}

export interface HelloMessage {
  readonly socketId: string;
  readonly hospitalId: string;
  readonly branchId: string | null;
  readonly userId: string;
  /** The room the socket was auto-joined to (its own). */
  readonly userRoom: string;
  readonly snapshotPath: string;
  readonly pushIntervalMs: number;
  readonly serverTime: string;
}

export interface ServerToClientEvents {
  hello: (message: HelloMessage) => void;
  'room:push': (message: RoomPushMessage<BoardDiff>) => void;
  'presence:changed': (change: PresenceChange) => void;
  'server:shutdown': (message: { reason: string; reconnectAfterMs: number }) => void;
}

export interface ClientToServerEvents {
  subscribe: (payload: unknown, ack: (result: SubscribeAck) => void) => void;
  unsubscribe: (payload: unknown, ack: (result: UnsubscribeAck) => void) => void;
  'presence:list': (payload: unknown, ack: (result: PresenceListAck) => void) => void;
}

export interface InterServerEvents {
  ping: () => void;
}

export interface SocketData {
  /**
   * `undefined` only in the window before the auth middleware has run. Any
   * connection handler that finds it undefined disconnects the socket: there is
   * no such thing as a half-connected socket here.
   */
  claims: AccessTokenClaims | undefined;
  connectedAt: number;
}
