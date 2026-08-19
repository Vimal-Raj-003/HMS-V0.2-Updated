import { describe, expect, it } from 'vitest';
import { claimsFor, IDS } from '../__tests__/harness.js';
import {
  BRANCH_WILDCARD,
  canJoinRoom,
  hospitalOfRoom,
  InvalidRoomSegmentError,
  parseRoom,
  roomDescriptorSchema,
  rooms,
} from './rooms.js';

const { hospitalA, hospitalB, branchA1, branchA2, userAlice, userBob, doctorOrtho } = IDS;

describe('room names match docs/01 §6 exactly', () => {
  it('builds every documented room string', () => {
    expect(rooms.queue(hospitalA, branchA1, doctorOrtho)).toBe(
      `h:${hospitalA}:b:${branchA1}:queue:${doctorOrtho}`,
    );
    expect(rooms.ward(hospitalA, branchA1, 'ward-3b')).toBe(
      `h:${hospitalA}:b:${branchA1}:ward:ward-3b`,
    );
    expect(rooms.bedboard(hospitalA, branchA1)).toBe(`h:${hospitalA}:b:${branchA1}:bedboard`);
    expect(rooms.user(hospitalA, branchA1, userAlice)).toBe(
      `h:${hospitalA}:b:${branchA1}:user:${userAlice}`,
    );
    expect(rooms.ot(hospitalA, branchA1)).toBe(`h:${hospitalA}:b:${branchA1}:ot`);
    expect(rooms.er(hospitalA, branchA1)).toBe(`h:${hospitalA}:b:${branchA1}:er`);
    expect(rooms.display(hospitalA, branchA1, 'opd-lobby-1')).toBe(
      `h:${hospitalA}:b:${branchA1}:display:opd-lobby-1`,
    );
  });

  it('renders a null branch as the wildcard segment, never as an empty one', () => {
    expect(rooms.bedboard(hospitalA, null)).toBe(`h:${hospitalA}:b:${BRANCH_WILDCARD}:bedboard`);
    expect(rooms.bedboard(hospitalA, null)).not.toContain('::');
  });

  it('always puts the hospital in the first segment', () => {
    for (const room of [
      rooms.queue(hospitalA, branchA1, doctorOrtho),
      rooms.ward(hospitalA, null, 'icu'),
      rooms.bedboard(hospitalA, branchA1),
      rooms.user(hospitalA, branchA1, userAlice),
      rooms.ot(hospitalA, branchA1),
      rooms.er(hospitalA, branchA1),
      rooms.display(hospitalA, branchA1, 'tv-1'),
      rooms.presence(hospitalA, branchA1),
    ]) {
      expect(room.startsWith(`h:${hospitalA}:`)).toBe(true);
      expect(hospitalOfRoom(room)).toBe(hospitalA);
    }
  });
});

describe('segment validation', () => {
  it('rejects a segment containing the delimiter (a room-name injection)', () => {
    expect(() => rooms.ward(hospitalA, branchA1, `x:b:${hospitalB}:bedboard`)).toThrow(
      InvalidRoomSegmentError,
    );
  });

  it('rejects an empty or over-long segment', () => {
    expect(() => rooms.ward(hospitalA, branchA1, '')).toThrow(InvalidRoomSegmentError);
    expect(() => rooms.ward(hospitalA, branchA1, 'w'.repeat(65))).toThrow(InvalidRoomSegmentError);
  });

  it('the descriptor schema requires UUIDs for tenant-bearing fields', () => {
    expect(
      roomDescriptorSchema.safeParse({ kind: 'bedboard', hospitalId: 'not-a-uuid', branchId: null })
        .success,
    ).toBe(false);
    expect(
      roomDescriptorSchema.safeParse({ kind: 'bedboard', hospitalId: hospitalA, branchId: null })
        .success,
    ).toBe(true);
  });
});

describe('parseRoom', () => {
  it('round-trips every kind', () => {
    expect(parseRoom(rooms.queue(hospitalA, branchA1, doctorOrtho))).toEqual({
      hospitalId: hospitalA,
      branchId: branchA1,
      kind: 'queue',
      id: doctorOrtho,
    });
    expect(parseRoom(rooms.bedboard(hospitalA, null))).toEqual({
      hospitalId: hospitalA,
      branchId: null,
      kind: 'bedboard',
      id: null,
    });
  });

  it('returns null for anything this process did not build', () => {
    for (const bad of [
      '',
      'bedboard',
      `h:${hospitalA}`,
      `h:${hospitalA}:b:${branchA1}`,
      `h:${hospitalA}:b:${branchA1}:unknownkind`,
      `h:${hospitalA}:b:${branchA1}:bedboard:extra`,
      `x:${hospitalA}:b:${branchA1}:bedboard`,
      `h:${hospitalA}:b:${branchA1}:queue`,
    ]) {
      expect(parseRoom(bad)).toBeNull();
      expect(hospitalOfRoom(bad)).toBeNull();
    }
  });
});

describe('canJoinRoom — tenant isolation', () => {
  const alice = claimsFor();

  it('allows a room in the socket own hospital and branch', () => {
    expect(canJoinRoom(alice, rooms.bedboard(hospitalA, branchA1)).allowed).toBe(true);
    expect(canJoinRoom(alice, rooms.ward(hospitalA, branchA1, 'ward-3b')).allowed).toBe(true);
  });

  it('REFUSES another hospital room, even with an otherwise identical shape', () => {
    const decision = canJoinRoom(alice, rooms.bedboard(hospitalB, branchA1));
    expect(decision).toEqual({ allowed: false, reason: 'cross_tenant' });
  });

  it('refuses every kind of room in another hospital', () => {
    for (const room of [
      rooms.queue(hospitalB, branchA1, doctorOrtho),
      rooms.ward(hospitalB, branchA1, 'ward-3b'),
      rooms.bedboard(hospitalB, branchA1),
      rooms.user(hospitalB, branchA1, userAlice),
      rooms.ot(hospitalB, branchA1),
      rooms.er(hospitalB, branchA1),
      rooms.display(hospitalB, branchA1, 'tv-1'),
      rooms.presence(hospitalB, branchA1),
    ]) {
      expect(canJoinRoom(alice, room)).toEqual({ allowed: false, reason: 'cross_tenant' });
    }
  });

  it('fails closed on an unparseable room rather than allowing it', () => {
    expect(canJoinRoom(alice, `h:${hospitalA}:b:${branchA1}:sudo`)).toEqual({
      allowed: false,
      reason: 'unparseable_room',
    });
  });

  it('refuses another branch for a branch-scoped session', () => {
    expect(canJoinRoom(alice, rooms.bedboard(hospitalA, branchA2))).toEqual({
      allowed: false,
      reason: 'cross_branch',
    });
  });

  it('allows a sibling branch for an entity-scoped session', () => {
    const groupAdmin = claimsFor({ scope: 'entity' });
    expect(canJoinRoom(groupAdmin, rooms.bedboard(hospitalA, branchA2)).allowed).toBe(true);
    // …but still not another hospital.
    expect(canJoinRoom(groupAdmin, rooms.bedboard(hospitalB, branchA2)).allowed).toBe(false);
  });

  it("refuses a colleague's personal room (a within-tenant leak)", () => {
    expect(canJoinRoom(alice, rooms.user(hospitalA, branchA1, userBob))).toEqual({
      allowed: false,
      reason: 'foreign_user_room',
    });
    expect(canJoinRoom(alice, rooms.user(hospitalA, branchA1, userAlice)).allowed).toBe(true);
  });
});
