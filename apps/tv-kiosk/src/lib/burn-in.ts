/**
 * Burn-in mitigation (EN-018 §3.7: "subtle pixel-shift every 15 min").
 *
 * The shift is a pure function of the clock, not of `Math.random`: two boards
 * showing the same content shift in lockstep, the movement is reproducible in a
 * test, and it can never land on a pathological sequence that reads as jitter.
 * Eight positions on a ring; a whole cycle takes two hours at the default period.
 */
export interface BurnInShift {
  readonly x: number;
  readonly y: number;
}

export interface BurnInOptions {
  /** How long each position is held. EN-018 §3.7 says 15 minutes. */
  readonly periodMs: number;
  /** Peak displacement in CSS pixels. Must stay below one text line. */
  readonly amplitudePx: number;
}

export const DEFAULT_BURN_IN: BurnInOptions = {
  periodMs: 15 * 60 * 1000,
  amplitudePx: 8,
};

/** Unit ring: 8 positions, each a whole or half step, so the path is a square. */
const RING: readonly BurnInShift[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: -1, y: -1 },
  { x: 0, y: -1 },
];

export function burnInShift(now: Date, options: BurnInOptions = DEFAULT_BURN_IN): BurnInShift {
  const period = Math.max(1, options.periodMs);
  const index = Math.floor(now.getTime() / period) % RING.length;
  const position = RING[index < 0 ? index + RING.length : index] ?? RING[0];
  if (position === undefined) return { x: 0, y: 0 };
  return {
    x: position.x * options.amplitudePx,
    y: position.y * options.amplitudePx,
  };
}

/** The CSS the board applies. Kept here so the transform is testable as a string. */
export function burnInTransform(shift: BurnInShift): string {
  return `translate3d(${shift.x}px, ${shift.y}px, 0)`;
}
