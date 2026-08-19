import { isUuid } from '@vims/contracts/primitives';
import { z } from 'zod';
import type { AccessTokenClaims } from '../auth/access-token.js';

/**
 * Room naming — `docs/01` §6, verbatim:
 *
 *   h:<hospital>:b:<branch>:queue:<doctor>
 *   h:<hospital>:b:<branch>:ward:<ward>
 *   h:<hospital>:b:<branch>:bedboard
 *   h:<hospital>:b:<branch>:user:<userId>
 *   h:<hospital>:b:<branch>:ot
 *   h:<hospital>:b:<branch>:er
 *   h:<hospital>:b:<branch>:display:<screen>
 *
 * Two design choices, both load-bearing:
 *
 * 1. **`RoomName` is branded and only `buildRoom()` can produce one.** A room
 *    name assembled ad hoc at a call site is how a tenant prefix goes missing,
 *    and a missing prefix is a cross-hospital broadcast. The type system now
 *    refuses the shortcut instead of a reviewer having to notice it.
 *
 * 2. **The hospital is the *first* segment.** That is what makes isolation a
 *    string comparison on a fixed position rather than a parse of arbitrary
 *    client input — `hospitalOfRoom()` cannot be fooled by a room id that
 *    contains a colon, because segments are validated on the way in.
 */

declare const roomBrand: unique symbol;
/** A room name that has been through `buildRoom()`. Never construct one by hand. */
export type RoomName = string & { readonly [roomBrand]: 'RoomName' };

/**
 * A branch is `null` for a group- or entity-scoped session that has not yet
 * chosen a branch (`docs/05`: branch selection happens *after* the password
 * step). It renders as `-`, which is outside the id alphabet and so can never
 * collide with a real branch id.
 */
export const BRANCH_WILDCARD = '-';

/** Segment alphabet: no `:` — the delimiter can never appear inside a value. */
const SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class InvalidRoomSegmentError extends Error {
  constructor(field: string, value: string) {
    super(`Invalid room segment for ${field}: ${JSON.stringify(value)}`);
    this.name = 'InvalidRoomSegmentError';
  }
}

const uuidSegment = z.string().refine(isUuid, { message: 'must be a UUID' });
const slugSegment = z.string().regex(SEGMENT_RE, 'must match [A-Za-z0-9_-]{1,64}');
const branchSegment = uuidSegment.nullable();

/**
 * What a client asks for. It never sends a room *string*: it sends a typed
 * descriptor which the server turns into a name. That way the only room names
 * in existence are ones this process built, and the tenant check below is
 * checking a value the server produced from fields it validated.
 */
export const roomDescriptorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('queue'),
    hospitalId: uuidSegment,
    branchId: branchSegment,
    doctorId: uuidSegment,
  }),
  z.object({
    kind: z.literal('ward'),
    hospitalId: uuidSegment,
    branchId: branchSegment,
    wardId: slugSegment,
  }),
  z.object({ kind: z.literal('bedboard'), hospitalId: uuidSegment, branchId: branchSegment }),
  z.object({
    kind: z.literal('user'),
    hospitalId: uuidSegment,
    branchId: branchSegment,
    userId: uuidSegment,
  }),
  z.object({ kind: z.literal('ot'), hospitalId: uuidSegment, branchId: branchSegment }),
  z.object({ kind: z.literal('er'), hospitalId: uuidSegment, branchId: branchSegment }),
  z.object({
    kind: z.literal('display'),
    hospitalId: uuidSegment,
    branchId: branchSegment,
    screenId: slugSegment,
  }),
  /**
   * Extension beyond the seven names in `docs/01` §6, kept in the same shape so
   * that tenant isolation applies to it identically: presence fan-out needs a
   * room, and inventing one *outside* the `h:<hospital>:b:<branch>:` prefix
   * would be the one room the isolation rule did not cover.
   */
  z.object({ kind: z.literal('presence'), hospitalId: uuidSegment, branchId: branchSegment }),
]);

export type RoomDescriptor = z.infer<typeof roomDescriptorSchema>;
export type RoomKind = RoomDescriptor['kind'];

function seg(field: string, value: string): string {
  if (!SEGMENT_RE.test(value)) throw new InvalidRoomSegmentError(field, value);
  return value;
}

function branch(value: string | null): string {
  return value === null ? BRANCH_WILDCARD : seg('branchId', value);
}

function prefix(hospitalId: string, branchId: string | null): string {
  return `h:${seg('hospitalId', hospitalId)}:b:${branch(branchId)}`;
}

/** The single constructor for a room name. */
export function buildRoom(d: RoomDescriptor): RoomName {
  const base = prefix(d.hospitalId, d.branchId);
  switch (d.kind) {
    case 'queue':
      return `${base}:queue:${seg('doctorId', d.doctorId)}` as RoomName;
    case 'ward':
      return `${base}:ward:${seg('wardId', d.wardId)}` as RoomName;
    case 'bedboard':
      return `${base}:bedboard` as RoomName;
    case 'user':
      return `${base}:user:${seg('userId', d.userId)}` as RoomName;
    case 'ot':
      return `${base}:ot` as RoomName;
    case 'er':
      return `${base}:er` as RoomName;
    case 'display':
      return `${base}:display:${seg('screenId', d.screenId)}` as RoomName;
    case 'presence':
      return `${base}:presence` as RoomName;
  }
}

/** Named builders, so a call site reads as the thing it is pushing to. */
export const rooms = {
  queue: (hospitalId: string, branchId: string | null, doctorId: string): RoomName =>
    buildRoom({ kind: 'queue', hospitalId, branchId, doctorId }),
  ward: (hospitalId: string, branchId: string | null, wardId: string): RoomName =>
    buildRoom({ kind: 'ward', hospitalId, branchId, wardId }),
  bedboard: (hospitalId: string, branchId: string | null): RoomName =>
    buildRoom({ kind: 'bedboard', hospitalId, branchId }),
  user: (hospitalId: string, branchId: string | null, userId: string): RoomName =>
    buildRoom({ kind: 'user', hospitalId, branchId, userId }),
  ot: (hospitalId: string, branchId: string | null): RoomName =>
    buildRoom({ kind: 'ot', hospitalId, branchId }),
  er: (hospitalId: string, branchId: string | null): RoomName =>
    buildRoom({ kind: 'er', hospitalId, branchId }),
  display: (hospitalId: string, branchId: string | null, screenId: string): RoomName =>
    buildRoom({ kind: 'display', hospitalId, branchId, screenId }),
  presence: (hospitalId: string, branchId: string | null): RoomName =>
    buildRoom({ kind: 'presence', hospitalId, branchId }),
} as const;

export interface ParsedRoom {
  readonly hospitalId: string;
  /** `null` when the room was built for an unscoped (wildcard) branch. */
  readonly branchId: string | null;
  readonly kind: RoomKind;
  readonly id: string | null;
}

/** Inverse of `buildRoom`. Returns `null` for anything not built by us. */
export function parseRoom(name: string): ParsedRoom | null {
  const parts = name.split(':');
  const [h, hospitalId, b, branchRaw, kind, id] = parts;
  if (h !== 'h' || b !== 'b') return null;
  if (hospitalId === undefined || branchRaw === undefined || kind === undefined) return null;
  if (!SEGMENT_RE.test(hospitalId) || !SEGMENT_RE.test(branchRaw)) return null;

  const withId = kind === 'queue' || kind === 'ward' || kind === 'user' || kind === 'display';
  const withoutId = kind === 'bedboard' || kind === 'ot' || kind === 'er' || kind === 'presence';
  if (!withId && !withoutId) return null;
  if (withId && (parts.length !== 6 || id === undefined || !SEGMENT_RE.test(id))) return null;
  if (withoutId && parts.length !== 5) return null;

  return {
    hospitalId,
    branchId: branchRaw === BRANCH_WILDCARD ? null : branchRaw,
    kind,
    id: withId ? (id ?? null) : null,
  };
}

/**
 * The hospital a room belongs to, or `null` if the string is not one of ours.
 * Fails closed: an unparseable name has no hospital, and therefore matches no
 * token.
 */
export function hospitalOfRoom(name: string): string | null {
  return parseRoom(name)?.hospitalId ?? null;
}

export type JoinDenialReason =
  | 'unparseable_room'
  | 'cross_tenant'
  | 'cross_branch'
  | 'foreign_user_room';

export type JoinDecision =
  | { readonly allowed: true; readonly room: ParsedRoom }
  | { readonly allowed: false; readonly reason: JoinDenialReason };

/**
 * **The isolation rule.** A socket may only join a room whose `h:<hospital>`
 * segment equals the `hid` claim of its own access token.
 *
 * This is checked here, on the server, against the token — never against a
 * hospital id the client also supplied, which would be the client asserting its
 * own tenancy. Two further rules ride along, for the same reason:
 *
 *  - a `branch`-scoped session may not join another branch's room (`docs/05`
 *    scope semantics: `branch` means one branch, not "any branch of my hospital");
 *  - a `user:` room belongs to one person. Joining a colleague's personal room
 *    would expose their task and alert stream, which is a within-tenant leak and
 *    just as reportable.
 */
export function canJoinRoom(claims: AccessTokenClaims, name: string): JoinDecision {
  const room = parseRoom(name);
  if (room === null) return { allowed: false, reason: 'unparseable_room' };
  if (room.hospitalId !== claims.hid) return { allowed: false, reason: 'cross_tenant' };

  if (
    claims.scope === 'branch' &&
    claims.bid !== null &&
    room.branchId !== null &&
    room.branchId !== claims.bid
  ) {
    return { allowed: false, reason: 'cross_branch' };
  }

  if (room.kind === 'user' && room.id !== claims.sub) {
    return { allowed: false, reason: 'foreign_user_room' };
  }

  return { allowed: true, room };
}
