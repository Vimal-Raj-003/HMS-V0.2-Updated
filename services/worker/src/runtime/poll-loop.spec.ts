import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createPollLoop } from './poll-loop.js';

const silent = pino({ level: 'silent' });

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('the poll loop', () => {
  it('never overlaps a tick with itself', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let ticks = 0;

    const loop = createPollLoop({
      name: 'test.overlap',
      intervalMs: 1,
      logger: silent,
      tick: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise<void>((r) => setTimeout(r, 5));
        concurrent -= 1;
        ticks += 1;
        return false;
      },
    });

    loop.start();
    await new Promise<void>((r) => setTimeout(r, 60));
    await loop.stop();

    expect(maxConcurrent).toBe(1);
    expect(ticks).toBeGreaterThan(1);
  });

  /**
   * The property the graceful shutdown depends on: `stop()` does not resolve
   * while a tick is still running, so `main.ts` cannot close the pool underneath
   * an in-flight `COMMIT`.
   */
  it('waits for the in-flight tick before stop() resolves', async () => {
    const gate = deferred();
    let finished = false;

    const loop = createPollLoop({
      name: 'test.drain',
      intervalMs: 10_000,
      logger: silent,
      tick: async () => {
        await gate.promise;
        finished = true;
        return false;
      },
    });

    loop.start();
    await new Promise<void>((r) => setTimeout(r, 10));

    const stopping = loop.stop();
    expect(finished).toBe(false);
    gate.resolve();
    await stopping;
    expect(finished).toBe(true);
    expect(loop.running).toBe(false);
  });

  it('skips the idle wait when the tick reports more work', async () => {
    let ticks = 0;
    const loop = createPollLoop({
      name: 'test.burst',
      intervalMs: 10_000,
      logger: silent,
      tick: () => {
        ticks += 1;
        return Promise.resolve(ticks < 5);
      },
    });

    loop.start();
    await new Promise<void>((r) => setTimeout(r, 30));
    await loop.stop();
    expect(ticks).toBe(5);
  });

  it('backs off after a failing tick instead of hot-looping', async () => {
    let ticks = 0;
    const loop = createPollLoop({
      name: 'test.error',
      intervalMs: 1,
      errorIntervalMs: 10_000,
      logger: silent,
      tick: () => {
        ticks += 1;
        return Promise.reject(new Error('database is down'));
      },
    });

    loop.start();
    await new Promise<void>((r) => setTimeout(r, 40));
    expect(ticks).toBe(1);
    expect(loop.lastError).toBe('database is down');
    await loop.stop();
  });
});
