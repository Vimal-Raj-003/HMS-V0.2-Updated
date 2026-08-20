import type { Logger } from 'pino';

/**
 * A stoppable poll loop with the two properties a graceful shutdown needs:
 * **stop accepting new work immediately**, and **finish the tick that is
 * already running**.
 *
 * `setInterval` gives neither. It fires again while the previous tick is still
 * in flight (so a slow relay batch overlaps itself and publishes twice), and
 * `clearInterval` says nothing about whether a tick is currently executing — so
 * a process that cleared its interval and exited can still be mid-`COMMIT`.
 *
 * So: run, await, then wait. `stop()` flips the flag and returns the promise of
 * the tick in progress, which is what `main.ts` awaits before closing the pool.
 */
export interface PollLoopOptions {
  readonly name: string;
  readonly intervalMs: number;
  readonly logger: Logger;
  /**
   * Return `true` to say "there is more work right now" and skip the idle wait.
   * A full outbox batch does this, so a burst drains at Redis speed instead of
   * one batch per interval.
   */
  readonly tick: () => Promise<boolean>;
  /** Backoff after a failed tick, so a database outage is not a hot loop. */
  readonly errorIntervalMs?: number;
}

export interface PollLoop {
  readonly name: string;
  start(): void;
  /** Resolves when the in-flight tick has finished. */
  stop(): Promise<void>;
  readonly running: boolean;
  /** Ticks completed since start — the readiness probe's proof of liveness. */
  readonly ticks: number;
  readonly lastError: string | null;
}

export function createPollLoop(options: PollLoopOptions): PollLoop {
  const errorIntervalMs = options.errorIntervalMs ?? Math.max(options.intervalMs, 5_000);
  let stopped = true;
  let inFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let wake: (() => void) | null = null;
  let ticks = 0;
  let lastError: string | null = null;

  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref();
      wake = resolve;
    });
  }

  async function run(): Promise<void> {
    while (!stopped) {
      let again = false;
      try {
        again = await options.tick();
        ticks += 1;
        lastError = null;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        options.logger.error({ event: `${options.name}.tick.failed`, message: lastError });
        if (!stopped) await sleep(errorIntervalMs);
        continue;
      }
      if (stopped) break;
      if (!again) await sleep(options.intervalMs);
    }
  }

  return {
    name: options.name,
    start(): void {
      if (!stopped) return;
      stopped = false;
      inFlight = run();
      options.logger.info({ event: `${options.name}.started`, intervalMs: options.intervalMs });
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      // Wake the idle wait so shutdown is not gated on a full interval.
      wake?.();
      await inFlight;
      inFlight = null;
      options.logger.info({ event: `${options.name}.stopped`, ticks });
    },
    get running(): boolean {
      return !stopped;
    },
    get ticks(): number {
      return ticks;
    },
    get lastError(): string | null {
      return lastError;
    },
  };
}
