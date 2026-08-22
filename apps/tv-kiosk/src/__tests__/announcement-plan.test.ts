import { describe, expect, it } from 'vitest';
import { ANNOUNCE_TTL_MS, callKey, planAnnouncements } from '../features/announce/announcement-plan';
import type { BoardAudio, BoardSnapshot, QueueTokenStatus } from '../features/board/board-contract';
import { servingFixture, snapshot } from './fixtures';

const NOW = new Date('2026-08-19T14:07:02.000Z');
const AUDIO: BoardAudio = { enabled: true, locales: ['ta'], repeatCount: 1 };

function called(status: QueueTokenStatus, calledAt = '2026-08-19T14:06:50.000Z'): BoardSnapshot {
  return { ...snapshot(), audio: AUDIO, nowServing: [servingFixture({ status, calledAt })] };
}

const NOTHING_ANNOUNCED = new Set<string>();

function plan(input: BoardSnapshot, announced = NOTHING_ANNOUNCED) {
  return planAnnouncements({ snapshot: input, freshness: 'live', now: NOW, announced });
}

describe('what a board announces', () => {
  it('announces a token that was just called', () => {
    const [call] = plan(called('called'));

    expect(call).toBeDefined();
    expect(call?.tokenDisplay).toBe('C-45');
    expect(call?.destination).toBe('Room 3');
    expect(call?.utterances.map((u) => u.localeCode)).toEqual(['en-IN', 'ta']);
  });

  it('announces a recall, because a recall is a fresh call', () => {
    expect(plan(called('recalled'))).toHaveLength(1);
  });

  /**
   * The lifecycle states added in `packages/contracts` — `held`, `cancelled`,
   * `no_show`, `expired` — all mean "nobody should walk to that room". Calling
   * one out sends a patient down a corridor for nothing, and on a `cancelled`
   * token it sends them for a token that has already been re-issued as another
   * number (EN-006 §5).
   */
  it.each<QueueTokenStatus>([
    'issued',
    'awaiting_payment',
    'waiting',
    'in_service',
    'held',
    'skipped',
    'no_show',
    'served',
    'transferred',
    'cancelled',
    'expired',
  ])('never announces a token that is %s', (status) => {
    expect(plan(called(status))).toEqual([]);
  });
});

describe('when a board stays quiet', () => {
  it('says nothing when the board carries no audio configuration', () => {
    const withoutAudio = { ...called('called'), audio: undefined };
    expect(plan(withoutAudio)).toEqual([]);
  });

  it('says nothing when audio is switched off', () => {
    const muted = { ...called('called'), audio: { ...AUDIO, enabled: false } };
    expect(plan(muted)).toEqual([]);
  });

  /**
   * EN-018 §14 AC-4: a board that reconnects "does not replay stale audio
   * announcements older than 90 seconds". The waiting room has moved on; the
   * people those tokens belong to have been seen or have gone home.
   */
  it('says nothing about a call older than the 90-second TTL', () => {
    const stale = called('called', new Date(NOW.getTime() - ANNOUNCE_TTL_MS - 1000).toISOString());
    expect(plan(stale)).toEqual([]);
  });

  it('still announces a call inside the TTL', () => {
    const recent = called('called', new Date(NOW.getTime() - 30_000).toISOString());
    expect(plan(recent)).toHaveLength(1);
  });

  it('says nothing when the feed is too old to trust', () => {
    // The screen already shows these tokens dimmed and labelled "not live"
    // (EN-018 §3.6). Speaking them would undo that in the one channel where the
    // caveat cannot be seen.
    expect(
      planAnnouncements({
        snapshot: called('called'),
        freshness: 'expired',
        now: NOW,
        announced: NOTHING_ANNOUNCED,
      }),
    ).toEqual([]);
  });

  it('says nothing twice about one call, however often the snapshot repeats', () => {
    const board = called('called');
    const spoken = plan(board).map((call) => call.key);
    expect(spoken).toHaveLength(1);

    // The polling transport re-delivers the same snapshot every three seconds.
    expect(plan(board, new Set(spoken))).toEqual([]);
  });

  it('says nothing about a call with an unreadable timestamp', () => {
    expect(plan(called('called', 'not-a-timestamp'))).toEqual([]);
  });

  it('says nothing about a call with neither a room nor a counter', () => {
    const nowhere = {
      ...called('called'),
      nowServing: [servingFixture({ status: 'called', roomLabel: '', counterLabel: '' })],
    };
    expect(plan(nowhere)).toEqual([]);
  });
});

describe('call identity', () => {
  it('changes when the same token is called again', () => {
    const first = servingFixture({ status: 'called', calledAt: '2026-08-19T14:06:50.000Z' });
    const again = servingFixture({ status: 'recalled', calledAt: '2026-08-19T14:06:58.000Z' });
    expect(callKey(first)).not.toBe(callKey(again));
  });
});

describe('where the configuration comes from', () => {
  it('uses the device configuration when the snapshot carries none', () => {
    const withoutAudio = { ...called('called'), audio: undefined };
    const calls = planAnnouncements({
      snapshot: withoutAudio,
      freshness: 'live',
      now: NOW,
      announced: NOTHING_ANNOUNCED,
      fallbackAudio: { enabled: true, locales: ['hi'], repeatCount: 2 },
    });

    expect(calls[0]?.utterances.map((u) => u.localeCode)).toEqual(['en-IN', 'hi']);
    expect(calls[0]?.repeatCount).toBe(2);
  });

  it('lets the board settings win over the device settings', () => {
    // `display_boards` is the authority (EN-018 §4); the device value only
    // covers the window before the console knows about the screen.
    const calls = planAnnouncements({
      snapshot: called('called'),
      freshness: 'live',
      now: NOW,
      announced: NOTHING_ANNOUNCED,
      fallbackAudio: { enabled: false, locales: ['hi'], repeatCount: 1 },
    });

    expect(calls[0]?.utterances.map((u) => u.localeCode)).toEqual(['en-IN', 'ta']);
  });
});
