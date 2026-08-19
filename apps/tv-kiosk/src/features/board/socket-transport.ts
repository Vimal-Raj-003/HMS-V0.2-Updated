import { BoardSnapshotSchema } from './board-contract';
import type { BoardTransport, BoardTransportHandlers } from './transport';

/**
 * The slice of a Socket.IO client this app actually uses. Depending on a local
 * structural type rather than on `socket.io-client`'s generics keeps the board
 * testable with a fake, and keeps `services/realtime` free to be built after this
 * app without blocking it.
 */
export interface BoardSocket {
  readonly connected: boolean;
  on(event: string, listener: (payload: unknown) => void): void;
  emit(event: string, payload: unknown): void;
  disconnect(): void;
}

export interface SocketConnectOptions {
  readonly boardId: string;
  readonly token: string;
}

export type SocketConnector = (url: string, options: SocketConnectOptions) => Promise<BoardSocket>;

export interface SocketTransportOptions {
  readonly url: string;
  readonly boardId: string;
  readonly token: string;
  readonly connect: SocketConnector;
  /**
   * How long the socket gets to prove itself before the runtime falls back to
   * polling. Bounded on purpose: an unattended screen must not sit on
   * "connecting" while a firewall silently drops the upgrade.
   */
  readonly connectTimeoutMs: number;
}

/**
 * Subscribes to the board room `display:<boardId>` (EN-018 §3.2.3) and forwards
 * every snapshot. Anything that means "this will not work here" — connect error,
 * timeout, disconnect by the server — is reported as `unavailable` so the
 * composed transport can switch to polling.
 */
export function createSocketTransport(options: SocketTransportOptions): BoardTransport {
  let socket: BoardSocket | null = null;
  let handlers: BoardTransportHandlers | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let gaveUp = false;

  const clearConnectTimeout = (): void => {
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
    }
  };

  const giveUp = (detail: string): void => {
    if (gaveUp || !running) return;
    gaveUp = true;
    clearConnectTimeout();
    socket?.disconnect();
    socket = null;
    handlers?.onStatus('unavailable', detail);
  };

  const acceptSnapshot = (payload: unknown): void => {
    const parsed = BoardSnapshotSchema.safeParse(payload);
    if (!parsed.success) {
      handlers?.onStatus('reconnecting', 'Realtime sent an unreadable snapshot');
      return;
    }
    clearConnectTimeout();
    handlers?.onSnapshot(parsed.data, new Date());
    handlers?.onStatus('live', null);
  };

  const attach = (connected: BoardSocket): void => {
    connected.on('board.snapshot', acceptSnapshot);
    connected.on('connect', () => {
      // A reconnect must re-join the room and pull a full snapshot: patches
      // applied to a stale base are how boards start showing wrong tokens.
      connected.emit('board.subscribe', { boardId: options.boardId });
    });
    connected.on('disconnect', () => {
      handlers?.onStatus('reconnecting', 'Realtime disconnected');
    });
    connected.on('connect_error', () => {
      giveUp('Realtime refused the connection');
    });
    connected.on('board.unauthorized', () => {
      clearConnectTimeout();
      handlers?.onStatus('unauthorized', 'Device token revoked');
    });
    connected.emit('board.subscribe', { boardId: options.boardId });
  };

  return {
    kind: 'socket',
    start(next) {
      handlers = next;
      running = true;
      gaveUp = false;
      next.onStatus('connecting', null);
      timeout = setTimeout(() => {
        giveUp('Realtime did not deliver a snapshot in time');
      }, options.connectTimeoutMs);

      void options
        .connect(options.url, { boardId: options.boardId, token: options.token })
        .then((connected) => {
          if (!running) {
            connected.disconnect();
            return;
          }
          socket = connected;
          attach(connected);
        })
        .catch((error: unknown) => {
          giveUp(error instanceof Error ? error.message : 'Realtime client unavailable');
        });
    },
    refresh() {
      socket?.emit('board.resync', { boardId: options.boardId });
    },
    stop() {
      running = false;
      clearConnectTimeout();
      socket?.disconnect();
      socket = null;
      handlers = null;
    },
  };
}

/**
 * Loads `socket.io-client` lazily so a board that never enables the socket never
 * pays for the bundle.
 */
export const defaultSocketConnector: SocketConnector = async (url, options) => {
  const mod = await import('socket.io-client');
  const socket = mod.io(url, {
    transports: ['websocket'],
    auth: { token: options.token, boardId: options.boardId },
    reconnection: true,
    reconnectionDelayMax: 10_000,
    withCredentials: false,
  });
  return {
    get connected(): boolean {
      return socket.connected;
    },
    on(event: string, listener: (payload: unknown) => void): void {
      socket.on(event, listener);
    },
    emit(event: string, payload: unknown): void {
      socket.emit(event, payload);
    },
    disconnect(): void {
      socket.disconnect();
    },
  };
};
