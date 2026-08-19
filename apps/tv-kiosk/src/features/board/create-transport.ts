import { createHttpSnapshotFetcher, createPollingTransport, type SnapshotFetcher } from './polling-transport';
import { createSocketTransport, defaultSocketConnector, type SocketConnector } from './socket-transport';
import { withFallback, type BoardTransport } from './transport';
import type { KioskEnv } from '../../lib/env';
import type { DeviceCredential } from '../pairing/pairing-contract';

export interface TransportFactoryOptions {
  readonly env: KioskEnv;
  readonly credential: DeviceCredential;
  /** Overridable for tests; defaults to the HTTP board-state endpoint. */
  readonly fetchSnapshot?: SnapshotFetcher;
  /** Overridable for tests; defaults to the lazy `socket.io-client` connector. */
  readonly connectSocket?: SocketConnector;
}

/**
 * Polling unless the board is explicitly configured for the socket *and* a
 * realtime URL exists. When the socket is chosen it is wrapped so that failing to
 * connect degrades to polling instead of to a frozen screen.
 */
export function createBoardTransport(options: TransportFactoryOptions): BoardTransport {
  const { env, credential } = options;
  const fetchSnapshot =
    options.fetchSnapshot ?? createHttpSnapshotFetcher(env.apiBaseUrl, credential.boardId, credential.token);

  const buildPolling = (): BoardTransport =>
    createPollingTransport({
      fetchSnapshot,
      intervalMs: env.pollIntervalMs,
      maxIntervalMs: Math.max(env.pollIntervalMs, 30_000),
    });

  if (env.transportPreference !== 'socket' || env.realtimeUrl === null) {
    return buildPolling();
  }

  const socket = createSocketTransport({
    url: env.realtimeUrl,
    boardId: credential.boardId,
    token: credential.token,
    connect: options.connectSocket ?? defaultSocketConnector,
    connectTimeoutMs: 8000,
  });

  return withFallback(socket, buildPolling);
}
