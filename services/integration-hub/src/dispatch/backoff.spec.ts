import { describe, expect, it } from 'vitest';
import type { RetryConfig } from '../config/connector-config.js';
import { backoffMs } from './dispatcher.js';

const R1: RetryConfig = {
  policy: 'R1',
  maxAttempts: 5,
  baseDelayMs: 5_000,
  backoffFactor: 2,
  maxDelayMs: 900_000,
  jitterMs: 2_000,
};

describe('retry backoff', () => {
  it('grows exponentially from the configured base', () => {
    const noJitter: RetryConfig = { ...R1, jitterMs: 0 };
    expect([1, 2, 3, 4].map((n) => backoffMs(noJitter, n, 'm'))).toEqual([5_000, 10_000, 20_000, 40_000]);
  });

  it('never exceeds the ceiling', () => {
    const noJitter: RetryConfig = { ...R1, jitterMs: 0 };
    expect(backoffMs(noJitter, 12, 'm')).toBe(900_000);
  });

  it('spreads retries with jitter so the herd does not return in one second', () => {
    const delays = new Set(
      Array.from({ length: 50 }, (_, i) => backoffMs(R1, 1, `message-${String(i)}`)),
    );
    // Distinct values across distinct messages is the property that matters;
    // an exact distribution is not worth asserting.
    expect(delays.size).toBeGreaterThan(20);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(5_000);
      expect(delay).toBeLessThan(7_000);
    }
  });

  it('is deterministic — the same message and attempt always gives the same delay', () => {
    // `docs/09` §2 bans `Math.random`: a suite that used it would fail
    // irreproducibly, and a replayed message would land in a different slot
    // than the log says it will.
    expect(backoffMs(R1, 2, 'abc')).toBe(backoffMs(R1, 2, 'abc'));
    expect(backoffMs(R1, 2, 'abc')).not.toBe(backoffMs(R1, 3, 'abc'));
  });

  it('honours a zero jitter span without dividing by zero', () => {
    expect(backoffMs({ ...R1, jitterMs: 0 }, 1, 'm')).toBe(5_000);
  });
});
