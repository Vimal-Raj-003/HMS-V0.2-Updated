import { createHash } from 'node:crypto';

/**
 * Deterministic, UUIDv7-shaped identifiers for seed data.
 *
 * Seeds must be idempotent (`docs/03 §Migrations`), and the cheapest way to make
 * an upsert idempotent is for the primary key to be a pure function of what the
 * row *is*. `seedId('hospital', 'VIMS-BLR')` returns the same uuid on every
 * machine, on every run, forever — so re-running the seed conflicts on the
 * primary key rather than inserting a second Bengaluru.
 *
 * The value is a hash, not a timestamp, so it is not a real UUIDv7: it carries
 * the version-7 and RFC-4122 variant bits so it is a well-formed uuid of the
 * right shape, but its leading bits are not a millisecond clock. That is
 * deliberate and only ever true of seeded rows — application code generates real
 * UUIDv7s through `IdGen` from `@vims/contracts`. Fixtures in
 * `src/rls/verify-isolation.sql` already use the same convention
 * (`11111111-1111-7111-8111-111111111111`).
 */
export function seedId(...parts: readonly string[]): string {
  const digest = createHash('sha256').update(parts.join('|')).digest();
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
  // Version 7 in the high nibble of byte 6; RFC-4122 variant in byte 8.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * A fixed instant for every `created_at`/`updated_at` a seed writes.
 *
 * Using `now()` would make the second run of an idempotency test differ from the
 * first in every timestamp column, which would make "nothing changed"
 * unprovable. A constant makes the seeded corpus byte-identical across runs and
 * across machines.
 */
export const SEED_EPOCH = new Date('2026-01-01T00:00:00.000Z');

/** A stable, obviously-synthetic instant N days after the seed epoch. */
export function seedDate(daysFromEpoch: number, hours = 0): Date {
  return new Date(SEED_EPOCH.getTime() + daysFromEpoch * 86_400_000 + hours * 3_600_000);
}

/**
 * A deterministic integer in `[0, max)` derived from a key.
 *
 * `docs/09 §2` bans ambient randomness and ESLint bans `Math.random()`. Seed
 * variety therefore comes from hashing the row's own identity, which makes every
 * "random-looking" value reproducible from the seed alone.
 */
export function seedPick(max: number, ...parts: readonly string[]): number {
  const digest = createHash('sha256').update(parts.join('|')).digest();
  return digest.readUInt32BE(0) % max;
}

/** Deterministic pick from a non-empty list. */
export function seedChoice<T>(items: readonly [T, ...T[]], ...parts: readonly string[]): T {
  return items[seedPick(items.length, ...parts)] ?? items[0];
}
