/**
 * A board runs unattended for months: every time-dependent behaviour (staleness,
 * burn-in shift, the on-screen clock) reads from an injected `Clock` so it can be
 * driven deterministically in tests. `Math.random` is banned repo-wide precisely
 * because a display that only misbehaves at 03:00 must be reproducible.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export interface ControllableClock extends Clock {
  advance(ms: number): void;
  set(at: Date): void;
}

/** Test double. Never used by the runtime. */
export function createFixedClock(start: Date): ControllableClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
    set: (at: Date) => {
      current = at.getTime();
    },
  };
}
