import { describe, expect, it } from 'vitest';
import { delay, IDS } from '../__tests__/harness.js';
import { rooms, type RoomName } from '../rooms/rooms.js';
import {
  CoalescingEmitter,
  emptyBoardDiff,
  mergeBoardDiff,
  type BoardDiff,
  type RoomPushMessage,
} from './coalescing-emitter.js';
import { decodeCursor, encodeCursor, isCursorCurrent, INITIAL_CURSOR_SEQ } from './cursor.js';

const wardBoard: RoomName = rooms.ward(IDS.hospitalA, IDS.branchA1, 'ward-3b');
const otBoard: RoomName = rooms.ot(IDS.hospitalA, IDS.branchA1);

interface Captured {
  readonly at: number;
  readonly message: RoomPushMessage<BoardDiff>;
}

function harness(intervalMs: number): {
  emitter: CoalescingEmitter<BoardDiff>;
  sent: Captured[];
} {
  const sent: Captured[] = [];
  const emitter = new CoalescingEmitter<BoardDiff>({
    intervalMs,
    merge: mergeBoardDiff,
    publish: (_room, message) => sent.push({ at: Date.now(), message }),
  });
  return { emitter, sent };
}

const bed = (id: string, status: string): BoardDiff => ({ changed: { [id]: { status } }, removed: [] });

describe('backpressure — docs/01 §6: max 1 push/sec per room, coalesced', () => {
  it('collapses a 100-emit burst into ONE push carrying the LAST state', async () => {
    const { emitter, sent } = harness(1_000);

    for (let i = 0; i < 100; i += 1) emitter.push(wardBoard, bed('bed-12', `state-${i}`));

    // Trailing, not leading: nothing has gone out yet, so the client cannot be
    // shown the *first* of a hundred states.
    expect(sent).toHaveLength(0);
    expect(emitter.pendingFor(wardBoard)).toBe(100);

    await delay(1_300);

    expect(sent).toHaveLength(1);
    const [first] = sent;
    expect(first?.message.coalesced).toBe(100);
    expect(first?.message.diff.changed['bed-12']).toEqual({ status: 'state-99' });
    expect(first?.message.seq).toBe(1);
  });

  it('emits at most once per second while updates keep arriving', async () => {
    const { emitter, sent } = harness(1_000);
    const startedAt = Date.now();

    let i = 0;
    const ticker = setInterval(() => {
      i += 1;
      emitter.push(wardBoard, bed('bed-12', `state-${i}`));
    }, 10);
    await delay(2_600);
    clearInterval(ticker);
    emitter.close(false);

    const elapsedSeconds = (Date.now() - startedAt) / 1_000;
    // ~260 source updates in the window; the room must not have seen more than
    // one push per second of it.
    expect(i).toBeGreaterThan(100);
    expect(sent.length).toBeLessThanOrEqual(Math.ceil(elapsedSeconds));

    for (let n = 1; n < sent.length; n += 1) {
      const previous = sent[n - 1];
      const current = sent[n];
      expect(current !== undefined && previous !== undefined).toBe(true);
      // Timer resolution jitter is a few ms; the floor is the interval.
      expect((current?.at ?? 0) - (previous?.at ?? 0)).toBeGreaterThanOrEqual(990);
    }

    // Every push carries the newest state known *at its flush time*, never a
    // stale one. With one source update every 10 ms, the state number a flush
    // at t carries must be ~t/10 — a leading-edge throttle would carry ~1.
    const stateOf = (m: Captured): number =>
      Number(String((m.message.diff.changed['bed-12'] as { status: string }).status).replace('state-', ''));

    expect(sent.length).toBeGreaterThan(1);
    expect(stateOf(sent[0] as Captured)).toBeGreaterThan(50);
    for (const message of sent) {
      const expectedAtFlush = (message.at - startedAt) / 10;
      expect(stateOf(message)).toBeGreaterThan(expectedAtFlush - 25);
    }
    // Monotonic: a push never carries an older state than the one before it.
    expect(sent.map(stateOf)).toEqual([...sent.map(stateOf)].sort((a, b) => a - b));
  });

  it('keeps rooms independent — a busy ward cannot starve the OT board', async () => {
    const { emitter, sent } = harness(200);
    for (let n = 0; n < 50; n += 1) emitter.push(wardBoard, bed('bed-1', `w${n}`));
    emitter.push(otBoard, bed('ot-1', 'in-progress'));

    await delay(400);

    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.message.room).sort()).toEqual([otBoard, wardBoard].sort());
  });

  it('merges diffs rather than dropping them', async () => {
    const { emitter, sent } = harness(200);
    emitter.push(wardBoard, bed('bed-1', 'occupied'));
    emitter.push(wardBoard, bed('bed-2', 'cleaning'));
    emitter.push(wardBoard, { changed: {}, removed: ['bed-3'] });

    await delay(400);

    expect(sent).toHaveLength(1);
    const diff = sent[0]?.message.diff;
    expect(Object.keys(diff?.changed ?? {}).sort()).toEqual(['bed-1', 'bed-2']);
    expect(diff?.removed).toEqual(['bed-3']);
  });

  it('flushes what is pending on close, so a queued bed change is not lost', () => {
    const { emitter, sent } = harness(1_000);
    emitter.push(wardBoard, bed('bed-9', 'released'));
    emitter.close(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message.diff.changed['bed-9']).toEqual({ status: 'released' });
  });

  it('ignores pushes after close', () => {
    const { emitter, sent } = harness(50);
    emitter.close(false);
    expect(emitter.push(wardBoard, bed('bed-1', 'x'))).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

describe('mergeBoardDiff ordering rules', () => {
  it('a later removal wins over an earlier change (bed freed)', () => {
    const merged = mergeBoardDiff(bed('bed-1', 'occupied'), { changed: {}, removed: ['bed-1'] });
    expect(merged.changed).toEqual({});
    expect(merged.removed).toEqual(['bed-1']);
  });

  it('a later change wins over an earlier removal (bed re-occupied)', () => {
    const merged = mergeBoardDiff({ changed: {}, removed: ['bed-1'] }, bed('bed-1', 'occupied'));
    expect(merged.changed).toEqual({ 'bed-1': { status: 'occupied' } });
    expect(merged.removed).toEqual([]);
  });

  it('is a no-op against an empty diff', () => {
    expect(mergeBoardDiff(emptyBoardDiff(), bed('bed-1', 'x'))).toEqual(bed('bed-1', 'x'));
  });
});

describe('reconnect cursor (?since=)', () => {
  it('round-trips and is opaque', () => {
    const cursor = encodeCursor({ emittedAt: 1_700_000_000_000, seq: 7 });
    expect(cursor).not.toContain(':');
    expect(decodeCursor(cursor)).toEqual({ emittedAt: 1_700_000_000_000, seq: 7 });
  });

  it('rejects a malformed cursor rather than guessing', () => {
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('!!!!')).toBeNull();
    expect(decodeCursor(Buffer.from('abc.def').toString('base64url'))).toBeNull();
  });

  it('advances by exactly one per push and is what the client sends back', async () => {
    const { emitter, sent } = harness(100);
    expect(decodeCursor(emitter.cursorFor(wardBoard))?.seq).toBe(INITIAL_CURSOR_SEQ);

    emitter.push(wardBoard, bed('bed-1', 'a'));
    await delay(200);
    emitter.push(wardBoard, bed('bed-1', 'b'));
    await delay(300);

    expect(sent.map((s) => s.message.seq)).toEqual([1, 2]);
    expect(emitter.cursorFor(wardBoard)).toBe(sent.at(-1)?.message.cursor);
    expect(emitter.seqFor(wardBoard)).toBe(2);
  });

  it('tells a client holding a stale cursor that it must resync', async () => {
    const { emitter, sent } = harness(100);
    emitter.push(wardBoard, bed('bed-1', 'a'));
    await delay(200);
    const afterFirst = sent[0]?.message.cursor ?? '';
    emitter.push(wardBoard, bed('bed-1', 'b'));
    await delay(200);

    expect(isCursorCurrent(afterFirst, emitter.seqFor(wardBoard))).toBe(false);
    expect(isCursorCurrent(emitter.cursorFor(wardBoard), emitter.seqFor(wardBoard))).toBe(true);
    expect(isCursorCurrent(undefined, emitter.seqFor(wardBoard))).toBe(false);
    expect(isCursorCurrent(undefined, INITIAL_CURSOR_SEQ)).toBe(true);
  });
});
