import { BoardSnapshotSchema, type BoardSnapshot } from './board-contract';
import type { BoardTransport, BoardTransportHandlers } from './transport';

export class UnauthorizedBoardError extends Error {
  constructor(message = 'Device token rejected') {
    super(message);
    this.name = 'UnauthorizedBoardError';
  }
}

export type SnapshotFetcher = (signal: AbortSignal) => Promise<BoardSnapshot>;

export interface PollingTransportOptions {
  readonly fetchSnapshot: SnapshotFetcher;
  readonly intervalMs: number;
  /** Failures back off geometrically up to this ceiling, then hold. */
  readonly maxIntervalMs: number;
}

/**
 * The default transport, and the one that must never give up. It polls
 * immediately on start (so a reconnect repaints at once rather than after a full
 * interval), backs off geometrically while the network is down, and returns to
 * the base interval on the first success.
 */
export function createPollingTransport(options: PollingTransportOptions): BoardTransport {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: AbortController | null = null;
  let handlers: BoardTransportHandlers | null = null;
  let failures = 0;
  let running = false;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const delayMs = (): number => {
    if (failures === 0) return options.intervalMs;
    const backoff = options.intervalMs * 2 ** Math.min(failures, 6);
    return Math.min(backoff, options.maxIntervalMs);
  };

  const schedule = (): void => {
    if (!running) return;
    clearTimer();
    timer = setTimeout(() => {
      void tick();
    }, delayMs());
  };

  const tick = async (): Promise<void> => {
    if (!running || handlers === null) return;
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    try {
      const snapshot = await options.fetchSnapshot(controller.signal);
      if (!running) return;
      failures = 0;
      handlers.onSnapshot(snapshot, new Date());
      handlers.onStatus('live', null);
    } catch (error) {
      if (!running) return;
      if (error instanceof UnauthorizedBoardError) {
        handlers.onStatus('unauthorized', error.message);
        running = false;
        clearTimer();
        return;
      }
      failures += 1;
      handlers.onStatus('reconnecting', error instanceof Error ? error.message : 'Board feed unreachable');
    } finally {
      if (inFlight === controller) inFlight = null;
    }
    schedule();
  };

  return {
    kind: 'polling',
    start(next) {
      handlers = next;
      running = true;
      failures = 0;
      next.onStatus('connecting', null);
      void tick();
    },
    refresh() {
      if (!running) return;
      clearTimer();
      failures = 0;
      void tick();
    },
    stop() {
      running = false;
      clearTimer();
      inFlight?.abort();
      inFlight = null;
      handlers = null;
    },
  };
}

/** `GET /display/boards/:id/state` with the device token (EN-018 §6). */
export function createHttpSnapshotFetcher(
  apiBaseUrl: string,
  boardId: string,
  token: string,
): SnapshotFetcher {
  return async (signal) => {
    const response = await fetch(`${apiBaseUrl}/display/boards/${encodeURIComponent(boardId)}/state`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new UnauthorizedBoardError();
    }
    if (!response.ok) {
      throw new Error(`Board feed returned ${String(response.status)}`);
    }
    const body: unknown = await response.json();
    const parsed = BoardSnapshotSchema.safeParse(body);
    if (!parsed.success) {
      // A captive portal answering with HTML must not be rendered as a board.
      throw new Error('Board feed returned an unreadable snapshot');
    }
    return parsed.data;
  };
}
