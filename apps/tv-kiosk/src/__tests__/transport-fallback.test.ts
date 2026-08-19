import { describe, expect, it, vi } from 'vitest';
import { createBoardTransport } from '../features/board/create-transport';
import type { BoardSnapshot } from '../features/board/board-contract';
import type { BoardTransport, TransportStatus } from '../features/board/transport';
import { withFallback } from '../features/board/transport';
import { parseKioskEnv } from '../lib/env';
import { CREDENTIAL, createManualTransport, snapshot } from './fixtures';

const socketEnv = parseKioskEnv({
  apiUrl: 'https://hms.example/api/v1',
  realtimeUrl: 'https://realtime.example',
  transport: 'socket',
  pollIntervalMs: '10',
  staleAfterMs: undefined,
  expiredAfterMs: undefined,
});

describe('withFallback', () => {
  it('runs the preferred transport while it works', () => {
    const primary = createManualTransport('socket');
    const fallbackFactory = vi.fn(() => createManualTransport('polling').transport);
    const composed = withFallback(primary.transport, fallbackFactory);

    const seen: BoardSnapshot[] = [];
    composed.start({ onSnapshot: (next) => seen.push(next), onStatus: () => undefined });
    primary.emit(snapshot(), new Date());

    expect(fallbackFactory).not.toHaveBeenCalled();
    expect(composed.kind).toBe('socket');
    expect(seen).toHaveLength(1);
  });

  it('switches to the fallback the moment the preferred transport reports itself unusable', () => {
    const primary = createManualTransport('socket');
    const fallback = createManualTransport('polling');
    const composed = withFallback(primary.transport, () => fallback.transport);

    const statuses: TransportStatus[] = [];
    const seen: BoardSnapshot[] = [];
    composed.start({ onSnapshot: (next) => seen.push(next), onStatus: (s) => statuses.push(s) });

    primary.setStatus('unavailable', 'WebSocket blocked by the hospital proxy');

    expect(primary.isStarted()).toBe(false);
    expect(fallback.isStarted()).toBe(true);
    expect(composed.kind).toBe('polling');
    // The board is never told "unavailable" — it is told the feed is coming back.
    expect(statuses).not.toContain('unavailable');

    fallback.emit(snapshot(), new Date());
    expect(seen).toHaveLength(1);
  });
});

describe('createBoardTransport', () => {
  it('chooses polling by default, which is what an unconfigured board gets', () => {
    const env = parseKioskEnv({
      apiUrl: undefined,
      realtimeUrl: undefined,
      transport: undefined,
      pollIntervalMs: undefined,
      staleAfterMs: undefined,
      expiredAfterMs: undefined,
    });
    const transport = createBoardTransport({
      env,
      credential: CREDENTIAL,
      fetchSnapshot: () => Promise.resolve(snapshot()),
    });
    expect(transport.kind).toBe('polling');
    transport.stop();
  });

  it('stays on polling when the socket is asked for but no realtime URL is configured', () => {
    const env = parseKioskEnv({
      apiUrl: undefined,
      realtimeUrl: '   ',
      transport: 'socket',
      pollIntervalMs: undefined,
      staleAfterMs: undefined,
      expiredAfterMs: undefined,
    });
    expect(env.transportPreference).toBe('polling');
  });

  it('falls back to polling when services/realtime cannot be reached at all', async () => {
    const fetchSnapshot = vi.fn(() => Promise.resolve(snapshot()));
    const transport: BoardTransport = createBoardTransport({
      env: socketEnv,
      credential: CREDENTIAL,
      fetchSnapshot,
      // `services/realtime` may not exist yet; that must not blank the board.
      connectSocket: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    expect(transport.kind).toBe('socket');

    const seen: BoardSnapshot[] = [];
    await new Promise<void>((resolve) => {
      transport.start({
        onSnapshot: (next) => {
          seen.push(next);
          resolve();
        },
        onStatus: () => undefined,
      });
    });

    expect(transport.kind).toBe('polling');
    expect(fetchSnapshot).toHaveBeenCalled();
    expect(seen[0]?.nowServing[0]?.tokenDisplay).toBe('C-45');
    transport.stop();
  });
});
