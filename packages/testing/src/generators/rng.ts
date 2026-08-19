/**
 * A seeded, deterministic pseudo-random generator.
 *
 * `docs/09-quality-gates-and-testing.md` §2 forbids ambient randomness in
 * tests, for a specific reason rather than a stylistic one: a generator seeded
 * from the clock produces a suite that fails once in every few hundred CI runs
 * and cannot be reproduced from the failure report. Every fixture here is a
 * pure function of its seed, so a red build can be replayed exactly by passing
 * the seed printed in the failure.
 *
 * mulberry32 — 32-bit state, uniform output, fast, and short enough to audit.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number;
  /** Uniform element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** True with the given probability. */
  chance(probability: number): boolean;
  /** A new independent stream, so adding a field to one generator cannot shift another. */
  fork(salt: number): Rng;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    int(min, max) {
      if (max < min) throw new RangeError(`int(${min}, ${max}): max must be >= min`);
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(items) {
      if (items.length === 0) throw new RangeError('pick() requires a non-empty array');
      const item = items[rng.int(0, items.length - 1)];
      // `noUncheckedIndexedAccess` is on; the range guarantee above is not visible to the compiler.
      if (item === undefined) throw new Error('unreachable: index within bounds');
      return item;
    },
    chance(probability) {
      return next() < probability;
    },
    fork(salt) {
      return createRng((seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0);
    },
  };

  return rng;
}
