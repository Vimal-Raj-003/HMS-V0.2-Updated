import { describe, expect, it } from 'vitest';
import { freshnessOf, presentFreshness } from '../features/board/staleness';

const thresholds = { staleAfterMs: 15_000, expiredAfterMs: 120_000 };
const now = new Date('2026-08-19T14:09:02.000Z');
const at = (secondsAgo: number): Date => new Date(now.getTime() - secondsAgo * 1000);

describe('freshnessOf', () => {
  it('is live only when data is recent and the transport is healthy', () => {
    expect(freshnessOf({ lastUpdatedAt: at(2), now, status: 'live', thresholds })).toBe('live');
  });

  it('is stale once the data ages past the stale threshold', () => {
    expect(freshnessOf({ lastUpdatedAt: at(20), now, status: 'live', thresholds })).toBe('stale');
  });

  it('is stale while reconnecting even if the bytes on screen are seconds old', () => {
    // The next token may already have been called without us; "live" would be a lie.
    expect(freshnessOf({ lastUpdatedAt: at(1), now, status: 'reconnecting', thresholds })).toBe('stale');
  });

  it('is expired past the 120 s threshold from EN-018 §3.6', () => {
    expect(freshnessOf({ lastUpdatedAt: at(121), now, status: 'live', thresholds })).toBe('expired');
  });

  it('is expired when nothing has ever arrived, and when the token was revoked', () => {
    expect(freshnessOf({ lastUpdatedAt: null, now, status: 'connecting', thresholds })).toBe('expired');
    expect(freshnessOf({ lastUpdatedAt: at(1), now, status: 'unauthorized', thresholds })).toBe('expired');
  });
});

describe('presentFreshness', () => {
  it('demotes the token numerals only once the data is expired', () => {
    expect(presentFreshness('live', 'live').demoteTokens).toBe(false);
    expect(presentFreshness('stale', 'reconnecting').demoteTokens).toBe(false);
    expect(presentFreshness('expired', 'reconnecting').demoteTokens).toBe(true);
  });

  it('labels each state for a viewer standing across the room', () => {
    expect(presentFreshness('live', 'live').label).toBe('Live');
    expect(presentFreshness('stale', 'reconnecting').label).toBe('Reconnecting');
    expect(presentFreshness('expired', 'reconnecting').label).toBe('Not live');
  });
});
