import { describe, expect, it } from 'vitest';
import {
  FixedClock,
  asId,
  isUuid,
  isUuidV7,
  newId,
  systemClock,
  uuidV7Timestamp,
  uuidv7IdGen,
} from './ids.js';
import type { HospitalId } from './ids.js';

/**
 * `docs/09 §2` forbids ambient randomness and ambient time in unit tests:
 * "time comes from an injected `Clock`, randomness from an injected `IdGen`".
 * These tests assert that the injection points actually behave as substitutes —
 * a `FixedClock` that drifted would make every retention, escalation and SLA
 * test in the repo meaningless.
 */

/** A UUIDv7 whose first 48 bits encode a known instant, built without randomness. */
function uuidV7At(epochMs: number, tail = '7abc-8def-0123456789ab'): string {
  const hex = epochMs.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${tail}`;
}

const V4_UUID = '9f1b3c2d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';

describe('uuid recognition', () => {
  it('accepts any RFC-4122 uuid with a valid variant nibble', () => {
    expect(isUuid(V4_UUID)).toBe(true);
    expect(isUuid(uuidV7At(0))).toBe(true);
  });

  it('rejects anything that is not a uuid, including near misses', () => {
    // These are the shapes that actually arrive: a trimmed id, a braced id, a
    // Prisma `undefined`, and a numeric primary key from a legacy system.
    expect(isUuid('9f1b3c2d4e5f4a6b8c9d0e1f2a3b4c5d')).toBe(false);
    expect(isUuid(`{${V4_UUID}}`)).toBe(false);
    expect(isUuid('9f1b3c2d-4e5f-4a6b-0c9d-0e1f2a3b4c5d')).toBe(false); // bad variant nibble
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(12345)).toBe(false);
    expect(isUuid(null)).toBe(false);
  });

  it('tells a v7 apart from a v4, because only v7 carries a timestamp', () => {
    expect(isUuidV7(V4_UUID)).toBe(false);
    expect(isUuidV7(uuidV7At(1_755_000_000_000))).toBe(true);
    expect(isUuidV7(42)).toBe(false);
  });
});

describe('uuidv7 generation', () => {
  it('generates ids that are v7 and unique', () => {
    const ids = Array.from({ length: 200 }, () => uuidv7IdGen.next());
    for (const id of ids) {
      expect(isUuidV7(id), `${id} is not a UUIDv7`).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('generates ids that sort in creation order as plain strings', () => {
    // docs/03: "UUIDv7 (time-ordered → index-friendly)". If lexical order and
    // creation order diverged, the whole reason for choosing v7 would be gone.
    const ids = Array.from({ length: 200 }, () => uuidv7IdGen.next());
    expect([...ids].sort()).toEqual(ids);
  });

  it('exposes the same generator through the convenience helper', () => {
    expect(isUuidV7(newId())).toBe(true);
  });

  it('freezes the generator so a module cannot swap it globally at runtime', () => {
    expect(Object.isFrozen(uuidv7IdGen)).toBe(true);
  });
});

describe('uuidv7 timestamp extraction', () => {
  it('reads back the exact millisecond a v7 id encodes', () => {
    // EN-024 §3.4 uses this to compare an audit row's id against its occurred_at.
    const at = Date.UTC(2026, 7, 17, 10, 30, 0);
    expect(uuidV7Timestamp(uuidV7At(at)).getTime()).toBe(at);
  });

  it('handles the epoch and a far-future instant without overflowing', () => {
    expect(uuidV7Timestamp(uuidV7At(0)).getTime()).toBe(0);
    const far = 281_474_976_710_655; // 2^48 - 1, the largest value the 48 bits hold
    expect(uuidV7Timestamp(uuidV7At(far)).getTime()).toBe(far);
  });

  it('agrees with the wall clock for a freshly generated id', () => {
    const before = Date.now();
    const extracted = uuidV7Timestamp(uuidv7IdGen.next()).getTime();
    const after = Date.now();
    expect(extracted).toBeGreaterThanOrEqual(before);
    expect(extracted).toBeLessThanOrEqual(after);
  });

  it('refuses a v4 id rather than returning a nonsense date', () => {
    // A v4 id would decode to an arbitrary instant, which would make the audit
    // integrity job raise false tamper alarms — worse than raising none.
    expect(() => uuidV7Timestamp(V4_UUID)).toThrow(/Not a UUIDv7/);
    expect(() => uuidV7Timestamp('not-an-id')).toThrow(/Not a UUIDv7/);
  });
});

describe('id branding', () => {
  it('passes the value through unchanged — branding is a compile-time device only', () => {
    const raw = uuidV7At(1_700_000_000_000);
    const hospitalId = asId<'HospitalId'>(raw) satisfies HospitalId;
    expect(hospitalId).toBe(raw);
  });
});

describe('clocks', () => {
  it('reports a consistent instant from the system clock', () => {
    const before = Date.now();
    const asDate = systemClock.now().getTime();
    const asMs = systemClock.nowMs();
    const after = Date.now();
    expect(asDate).toBeGreaterThanOrEqual(before);
    expect(asMs).toBeGreaterThanOrEqual(asDate);
    expect(asMs).toBeLessThanOrEqual(after);
    expect(Object.isFrozen(systemClock)).toBe(true);
  });

  it('holds a fixed instant so a scheduled-job test never has to sleep', () => {
    const at = Date.UTC(2026, 7, 17, 9, 0, 0);
    const clock = new FixedClock(at);
    expect(clock.nowMs()).toBe(at);
    expect(clock.now().toISOString()).toBe('2026-08-17T09:00:00.000Z');
    // Reading twice must give the same answer; a clock that ticked would make
    // "escalate after exactly 600 s" untestable.
    expect(clock.now().getTime()).toBe(clock.now().getTime());
  });

  it('accepts either a Date or epoch milliseconds', () => {
    const at = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(new FixedClock(new Date(at)).nowMs()).toBe(at);
    expect(new FixedClock(at).nowMs()).toBe(at);
  });

  it('advances by an exact interval, forwards and backwards', () => {
    // EN-037 §13: escalation timers are asserted against a frozen clock that is
    // advanced past each rung, so the arithmetic must be exact, not approximate.
    const at = Date.UTC(2026, 7, 17, 9, 0, 0);
    const clock = new FixedClock(at);
    clock.advance(600_000);
    expect(clock.nowMs()).toBe(at + 600_000);
    clock.advance(-600_000);
    expect(clock.nowMs()).toBe(at);
  });

  it('can be reset to a new instant, as either a Date or milliseconds', () => {
    const clock = new FixedClock(0);
    clock.set(new Date(1_000));
    expect(clock.nowMs()).toBe(1_000);
    clock.set(2_000);
    expect(clock.now().getTime()).toBe(2_000);
  });

  it('hands out a fresh Date each call, so a caller cannot mutate the clock', () => {
    const clock = new FixedClock(0);
    const first = clock.now();
    first.setFullYear(1999);
    expect(clock.nowMs()).toBe(0);
    expect(clock.now().getTime()).toBe(0);
  });
});
