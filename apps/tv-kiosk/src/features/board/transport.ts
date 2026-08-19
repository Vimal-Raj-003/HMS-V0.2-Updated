import type { BoardSnapshot } from './board-contract';

/**
 * How a board gets its data. Two implementations ship: Socket.IO (EN-018 §3.3,
 * sub-500 ms event-to-pixel) and HTTP polling (§3.3.4). Polling is the default,
 * and it is not a placeholder — a waiting-room TV on hospital Wi-Fi behind a
 * captive portal frequently cannot hold a WebSocket, and a board that polls every
 * three seconds is enormously better than one that quietly freezes at 09:12.
 */
export type BoardTransportKind = 'socket' | 'polling';

export type TransportStatus =
  /** Attempting the first successful exchange. */
  | 'connecting'
  /** Data is flowing. */
  | 'live'
  /** Was live, is retrying. The board keeps rendering, flagged as not live. */
  | 'reconnecting'
  /** This transport cannot work here at all; the runtime should fall back. */
  | 'unavailable'
  /** The device token was revoked or expired; the runtime must re-pair. */
  | 'unauthorized';

export interface BoardTransportHandlers {
  /** A full board state. Snapshots are idempotent and may repeat. */
  readonly onSnapshot: (snapshot: BoardSnapshot, receivedAt: Date) => void;
  /** `detail` is operator-facing text for the diagnostics card, never PHI. */
  readonly onStatus: (status: TransportStatus, detail: string | null) => void;
}

export interface BoardTransport {
  readonly kind: BoardTransportKind;
  /** Begin delivering snapshots. Calling twice is a programming error. */
  start(handlers: BoardTransportHandlers): void;
  /** Ask for a snapshot now — used on `online`, on tab visibility, on watchdog. */
  refresh(): void;
  /** Stop and release timers/sockets. Must be safe to call repeatedly. */
  stop(): void;
}

/**
 * Composes a preferred transport with a fallback that is built only if the
 * preferred one reports itself unusable. This is the whole degradation story in
 * one place: the socket gets a bounded chance to connect, and the moment it says
 * `unavailable` the board switches to polling without a reload and without the
 * screen ever going blank.
 */
export function withFallback(primary: BoardTransport, createFallback: () => BoardTransport): BoardTransport {
  let active: BoardTransport = primary;
  let switched = false;
  let stopped = false;

  const wrap = (target: BoardTransportHandlers): BoardTransportHandlers => ({
    onSnapshot: target.onSnapshot,
    onStatus: (status, detail) => {
      if (status === 'unavailable' && !switched && !stopped) {
        switched = true;
        active.stop();
        active = createFallback();
        target.onStatus('connecting', detail ?? 'Realtime unavailable — switched to polling');
        active.start(wrap(target));
        return;
      }
      target.onStatus(status, detail);
    },
  });

  return {
    get kind(): BoardTransportKind {
      return active.kind;
    },
    start(next) {
      active.start(wrap(next));
    },
    refresh() {
      active.refresh();
    },
    stop() {
      stopped = true;
      active.stop();
    },
  };
}
