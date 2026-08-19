import { describe, expect, it } from 'vitest';
import { DEFAULT_BURN_IN, burnInShift, burnInTransform } from '../lib/burn-in';

describe('burnInShift', () => {
  it('is a pure function of the clock, so two boards shift in lockstep', () => {
    const at = new Date('2026-08-19T14:07:02.000Z');
    expect(burnInShift(at)).toEqual(burnInShift(new Date(at.getTime())));
  });

  it('holds each position for a whole period and then moves', () => {
    const base = new Date('2026-08-19T00:00:00.000Z');
    const withinPeriod = new Date(base.getTime() + DEFAULT_BURN_IN.periodMs - 1);
    const nextPeriod = new Date(base.getTime() + DEFAULT_BURN_IN.periodMs);

    expect(burnInShift(withinPeriod)).toEqual(burnInShift(base));
    expect(burnInShift(nextPeriod)).not.toEqual(burnInShift(base));
  });

  it('never displaces further than the configured amplitude', () => {
    for (let step = 0; step < 16; step += 1) {
      const shift = burnInShift(new Date(step * DEFAULT_BURN_IN.periodMs));
      expect(Math.abs(shift.x)).toBeLessThanOrEqual(DEFAULT_BURN_IN.amplitudePx);
      expect(Math.abs(shift.y)).toBeLessThanOrEqual(DEFAULT_BURN_IN.amplitudePx);
    }
  });

  it('returns to its starting position after a full ring of periods', () => {
    const start = burnInShift(new Date(0));
    const afterRing = burnInShift(new Date(8 * DEFAULT_BURN_IN.periodMs));
    expect(afterRing).toEqual(start);
  });

  it('renders as a GPU-friendly transform', () => {
    expect(burnInTransform({ x: 8, y: -8 })).toBe('translate3d(8px, -8px, 0)');
  });
});
