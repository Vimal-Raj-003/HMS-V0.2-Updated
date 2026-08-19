import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedBoardError, createPollingTransport } from '../features/board/polling-transport';
import type { TransportStatus } from '../features/board/transport';
import { snapshot } from './fixtures';

describe('createPollingTransport', () => {
  it('polls immediately on start so a reconnect repaints at once', async () => {
    const fetchSnapshot = vi.fn(() => Promise.resolve(snapshot()));
    const transport = createPollingTransport({
      fetchSnapshot,
      intervalMs: 10_000,
      maxIntervalMs: 30_000,
    });

    const received = await new Promise<string>((resolve) => {
      transport.start({
        onSnapshot: (next) => resolve(next.boardId),
        onStatus: () => undefined,
      });
    });

    expect(received).toBe('board-opd-a');
    transport.stop();
  });

  it('reports reconnecting rather than dying when the network is down', async () => {
    const statuses: TransportStatus[] = [];
    const transport = createPollingTransport({
      fetchSnapshot: () => Promise.reject(new Error('offline')),
      intervalMs: 10_000,
      maxIntervalMs: 30_000,
    });

    await new Promise<void>((resolve) => {
      transport.start({
        onSnapshot: () => undefined,
        onStatus: (status) => {
          statuses.push(status);
          if (status === 'reconnecting') resolve();
        },
      });
    });

    expect(statuses).toEqual(['connecting', 'reconnecting']);
    transport.stop();
  });

  it('surfaces a revoked device token instead of retrying forever', async () => {
    const transport = createPollingTransport({
      fetchSnapshot: () => Promise.reject(new UnauthorizedBoardError()),
      intervalMs: 10_000,
      maxIntervalMs: 30_000,
    });

    const status = await new Promise<TransportStatus>((resolve) => {
      transport.start({
        onSnapshot: () => undefined,
        onStatus: (next) => {
          if (next !== 'connecting') resolve(next);
        },
      });
    });

    expect(status).toBe('unauthorized');
    transport.stop();
  });
});
