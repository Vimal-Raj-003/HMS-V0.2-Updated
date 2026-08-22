import { describe, expect, it } from 'vitest';
import type { TokenClass, TokenStatus, TokenView } from '../api/types';
import {
  REASON_IN_AUDIT_TRAIL,
  buildQueueEntries,
  currentlyServing,
  priorityLaneOf,
  toQueueEntry,
} from './queue-console';

const NOW = new Date('2026-08-24T05:00:00.000Z');

function token(overrides: Partial<TokenView> = {}): TokenView {
  return {
    id: 'token-1',
    queue_id: 'queue-1',
    branch_id: 'branch-1',
    series_date: '2026-08-24',
    token_no: 1,
    token_display: 'C-1',
    patient_id: null,
    visit_id: null,
    appointment_id: null,
    counter_id: null,
    room_key: null,
    source: 'desk',
    class: 'regular',
    priority_rank: 500,
    status: 'waiting',
    est_wait_sec_at_issue: 600,
    actual_wait_sec: null,
    skip_count: 0,
    recall_count: 0,
    issued_at: '2026-08-24T04:30:00.000Z',
    called_at: null,
    service_end_at: null,
    ...overrides,
  };
}

describe('priority lanes', () => {
  /**
   * Nine token classes, five lanes. The collapse is asserted here so it stays a
   * decision rather than an accident — and every tile still shows the exact class
   * as a chip, so nothing is hidden by it.
   */
  it('maps every class to a lane, and never silently to the wrong icon', () => {
    const expected: Record<TokenClass, string> = {
      regular: 'walk-in',
      appointment: 'appointment',
      priority_emergency: 'emergency',
      priority_senior: 'senior-citizen',
      priority_pregnant: 'senior-citizen',
      priority_disabled: 'differently-abled',
      priority_infant: 'senior-citizen',
      priority_staff: 'walk-in',
      priority_vip: 'walk-in',
    };
    for (const [tokenClass, lane] of Object.entries(expected)) {
      expect(priorityLaneOf(tokenClass as TokenClass)).toBe(lane);
    }
  });

  it('always shows the exact class on the tile', () => {
    const entry = toQueueEntry(token({ class: 'priority_pregnant' }), 1, { now: NOW });
    expect(entry.flags).toContain('Pregnant');
    expect(entry.maskedLabel).toContain('Pregnant');
  });
});

describe('token state', () => {
  it('never puts a patient label on a counter screen', () => {
    const entry = toQueueEntry(token({ patient_id: 'p-1' }), 1, { now: NOW });
    expect(entry.maskedLabel).toBe('Walk-in · Desk');
    expect(entry.maskedLabel).not.toContain('p-1');
  });

  it('counts the wait from issue, and never negative on a skewed clock', () => {
    expect(toQueueEntry(token(), 1, { now: NOW }).waitedMinutes).toBe(30);
    expect(
      toQueueEntry(token({ issued_at: '2026-08-24T06:00:00.000Z' }), 1, { now: NOW }).waitedMinutes,
    ).toBe(0);
  });

  /**
   * `TokenView` carries no reason column, so a skip the console has just made is
   * shown from what the console submitted, and anything older says where the
   * reason actually lives. A `skipped` tile with no reason at all would breach
   * the component's own contract.
   */
  it('shows the reason it just submitted, and otherwise says where the reason is', () => {
    const skipped = token({ status: 'skipped' });
    const withReason = toQueueEntry(skipped, 0, {
      now: NOW,
      knownReasons: new Map([['token-1', 'patient_absent: called three times']]),
    });
    expect(withReason.state).toEqual({
      kind: 'skipped',
      reason: 'patient_absent: called three times',
    });

    const without = toQueueEntry(skipped, 0, { now: NOW });
    expect(without.state).toEqual({ kind: 'skipped', reason: REASON_IN_AUDIT_TRAIL });
  });

  it('treats a transfer as done here rather than as a no-show', () => {
    expect(toQueueEntry(token({ status: 'transferred' }), 0, { now: NOW }).state.kind).toBe('completed');
    expect(toQueueEntry(token({ status: 'no_show' }), 0, { now: NOW }).state.kind).toBe('no-show');
    expect(toQueueEntry(token({ status: 'expired' }), 0, { now: NOW }).state.kind).toBe('no-show');
  });

  it('measures the seconds since a call, which drives the 90-second announcement rule', () => {
    const called = token({ status: 'called', called_at: '2026-08-24T04:59:00.000Z', room_key: 'Room 3' });
    expect(toQueueEntry(called, 0, { now: NOW }).state).toEqual({
      kind: 'called',
      room: 'Room 3',
      secondsSinceCall: 60,
    });
  });
});

describe('the console list', () => {
  /**
   * Positions are over the waiting set only. A "position 7" that counted three
   * already-served tokens tells the patient the wrong thing, and they will hold
   * the desk to it.
   */
  it('numbers positions over the waiting tokens only, in call order', () => {
    const entries = buildQueueEntries(
      [
        token({ id: 'a', token_no: 1, priority_rank: 500 }),
        token({ id: 'b', token_no: 2, priority_rank: 100, class: 'priority_emergency' }),
        token({ id: 'c', token_no: 3, status: 'served' }),
      ],
      { now: NOW },
    );

    expect(entries.map((entry) => entry.tokenId)).toEqual(['b', 'a', 'c']);
    expect(entries[0]?.state).toEqual({ kind: 'waiting', position: 1 });
    expect(entries[1]?.state).toEqual({ kind: 'waiting', position: 2 });
    expect(entries[2]?.state.kind).toBe('completed');
  });
});

describe('what the counter is serving', () => {
  const called = (id: string, at: string, status: TokenStatus = 'called'): TokenView =>
    token({ id, status, called_at: at });

  it('prefers the token this console called', () => {
    const tokens = [called('a', '2026-08-24T04:50:00.000Z'), called('b', '2026-08-24T04:55:00.000Z')];
    expect(currentlyServing(tokens, 'a')?.id).toBe('a');
  });

  it('falls back to the most recently called', () => {
    const tokens = [called('a', '2026-08-24T04:50:00.000Z'), called('b', '2026-08-24T04:55:00.000Z')];
    expect(currentlyServing(tokens, null)?.id).toBe('b');
  });

  it('ignores a preferred token that has already been completed', () => {
    const tokens = [token({ id: 'a', status: 'served' }), called('b', '2026-08-24T04:55:00.000Z')];
    expect(currentlyServing(tokens, 'a')?.id).toBe('b');
  });

  it('returns nothing when nobody is at the window', () => {
    expect(currentlyServing([token()], null)).toBeNull();
  });
});
