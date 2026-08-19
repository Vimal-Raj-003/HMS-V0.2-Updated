import type { Logger } from 'pino';
import type { RoomName } from '../rooms/rooms.js';
import { INITIAL_CURSOR_SEQ, encodeCursor } from './cursor.js';

/**
 * Backpressure, per `docs/01` §6: "boards push diffs, not full snapshots;
 * max 1 push/sec per room (coalesced)".
 *
 * The shape that matters is **trailing** coalescing. A leading-edge throttle
 * would send the *first* state of a burst and drop the rest, so a bed board
 * taking forty updates in a second would render the oldest of them — which is
 * worse than not updating at all, because it is confidently wrong. Trailing
 * coalescing sends one push per window carrying the *merged latest* state.
 *
 * The guarantee this class provides, and that its tests assert:
 *   1. no two pushes to the same room are closer together than `intervalMs`;
 *   2. every push carries the newest information known at flush time;
 *   3. nothing is silently dropped — updates are *merged*, not discarded;
 *   4. rooms are independent (a busy ward board cannot starve the OT board).
 */
export interface RoomPushMessage<TDiff> {
  readonly room: RoomName;
  /** What the client sends back as `?since=` after a reconnect. */
  readonly cursor: string;
  readonly seq: number;
  /** ISO-8601 UTC. */
  readonly at: string;
  /** Coalesced count — how many source updates this push represents. */
  readonly coalesced: number;
  readonly diff: TDiff;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface CoalescingEmitterOptions<TDiff> {
  readonly intervalMs: number;
  /** Where a flushed push goes. Injected so the emitter never imports the gateway. */
  readonly publish: (room: RoomName, message: RoomPushMessage<TDiff>) => void;
  /**
   * How two updates in the same window combine. The default keeps the newer one
   * (last-write-wins), which is correct for a full replacement; board diffs use
   * `mergeBoardDiff` so that a change in the first update is not lost when the
   * second one touches a different bed.
   */
  readonly merge?: (previous: TDiff, next: TDiff) => TDiff;
  readonly clock?: Clock;
  readonly logger?: Logger;
}

interface RoomState<TDiff> {
  pending: TDiff | undefined;
  pendingCount: number;
  seq: number;
  lastEmitAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class CoalescingEmitter<TDiff> {
  private readonly state = new Map<RoomName, RoomState<TDiff>>();
  private readonly merge: (previous: TDiff, next: TDiff) => TDiff;
  private readonly clock: Clock;
  private closed = false;

  constructor(private readonly options: CoalescingEmitterOptions<TDiff>) {
    this.merge = options.merge ?? ((_previous, next) => next);
    this.clock = options.clock ?? systemClock;
  }

  /** Queue an update. Returns the number of updates now pending for the room. */
  push(room: RoomName, diff: TDiff): number {
    if (this.closed) return 0;
    const state = this.stateFor(room);
    state.pending = state.pending === undefined ? diff : this.merge(state.pending, diff);
    state.pendingCount += 1;

    if (state.timer === undefined) {
      const since = this.clock.now() - state.lastEmitAt;
      const wait =
        state.lastEmitAt === 0
          ? this.options.intervalMs
          : Math.max(0, this.options.intervalMs - since);
      state.timer = setTimeout(() => {
        state.timer = undefined;
        this.flush(room);
      }, wait);
      // A pending board push must never hold the process open at shutdown.
      state.timer.unref?.();
    }
    return state.pendingCount;
  }

  /** The cursor a client should send as `?since=` for this room right now. */
  cursorFor(room: RoomName): string {
    const state = this.state.get(room);
    if (state === undefined || state.seq === INITIAL_CURSOR_SEQ) {
      return encodeCursor({ emittedAt: 0, seq: INITIAL_CURSOR_SEQ });
    }
    return encodeCursor({ emittedAt: state.lastEmitAt, seq: state.seq });
  }

  /** The room's current sequence — used to decide whether a client must resync. */
  seqFor(room: RoomName): number {
    return this.state.get(room)?.seq ?? INITIAL_CURSOR_SEQ;
  }

  pendingFor(room: RoomName): number {
    return this.state.get(room)?.pendingCount ?? 0;
  }

  /**
   * Emit whatever is pending for a room immediately, ignoring the interval.
   * Only used on shutdown: a queued critical bed change should leave with the
   * process rather than die in a timer.
   */
  flush(room: RoomName): void {
    const state = this.state.get(room);
    if (state === undefined || state.pending === undefined) return;

    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }

    const diff = state.pending;
    const coalesced = state.pendingCount;
    state.pending = undefined;
    state.pendingCount = 0;
    state.seq += 1;
    state.lastEmitAt = this.clock.now();

    const message: RoomPushMessage<TDiff> = {
      room,
      cursor: encodeCursor({ emittedAt: state.lastEmitAt, seq: state.seq }),
      seq: state.seq,
      at: new Date(state.lastEmitAt).toISOString(),
      coalesced,
      diff,
    };
    this.options.publish(room, message);
    // No diff in the log line: a board diff can carry a patient name (docs/04 §4).
    this.options.logger?.debug({ event: 'realtime.room.push', room, seq: state.seq, coalesced });
  }

  flushAll(): void {
    for (const room of [...this.state.keys()]) this.flush(room);
  }

  /** Stops all timers. `flushPending` is what shutdown wants; tests use `false`. */
  close(flushPending = true): void {
    this.closed = true;
    if (flushPending) this.flushAll();
    for (const state of this.state.values()) {
      if (state.timer !== undefined) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      state.pending = undefined;
      state.pendingCount = 0;
    }
  }

  private stateFor(room: RoomName): RoomState<TDiff> {
    const existing = this.state.get(room);
    if (existing !== undefined) return existing;
    const created: RoomState<TDiff> = {
      pending: undefined,
      pendingCount: 0,
      seq: INITIAL_CURSOR_SEQ,
      lastEmitAt: 0,
      timer: undefined,
    };
    this.state.set(room, created);
    return created;
  }
}

/**
 * The board diff shape. `changed` is keyed by entity id (bed, token, task) and
 * holds only the fields that moved; `removed` lists ids that left the board.
 * Never a snapshot — `docs/01` §6 and `docs/07` §3 ("invalidate keys, do not
 * push payloads … the refetch is the authority").
 */
export interface BoardDiff {
  readonly changed: Readonly<Record<string, unknown>>;
  readonly removed: readonly string[];
}

export function emptyBoardDiff(): BoardDiff {
  return { changed: {}, removed: [] };
}

/**
 * Merge two diffs within one coalescing window.
 *
 * The ordering rules are the interesting part: a later *removal* wins over an
 * earlier change to the same id (the bed was freed), and a later *change* wins
 * over an earlier removal (the bed was re-occupied). Getting this backwards
 * leaves a discharged patient on a ward board.
 */
export function mergeBoardDiff(previous: BoardDiff, next: BoardDiff): BoardDiff {
  const changed: Record<string, unknown> = { ...previous.changed };
  for (const id of next.removed) delete changed[id];
  for (const [id, value] of Object.entries(next.changed)) changed[id] = value;

  const nextChangedIds = new Set(Object.keys(next.changed));
  const removed = new Set<string>();
  for (const id of previous.removed) if (!nextChangedIds.has(id)) removed.add(id);
  for (const id of next.removed) removed.add(id);

  return { changed, removed: [...removed] };
}
