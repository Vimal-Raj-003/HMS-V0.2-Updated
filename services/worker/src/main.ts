import { loadEnv } from './config/env.js';
import { createLogger, writeBootFailure } from './logger.js';
import { createWorkerRuntime, type StartedWorker } from './worker.js';

/**
 * Process entry point for `services/worker`.
 *
 * `package.json` has pointed `start` at `node dist/main.js` since Phase 0
 * opened; until now there was no such file, so the outbox relay, the audit
 * chain sealer and the print queue were built, tested and never once run
 * outside a test. This mounts them.
 *
 * The three boot rules here are all lessons the 2026-08-19 session paid for in
 * `services/api`:
 *
 *  - **A bad environment stops the process before it takes a job**, because a
 *    worker that starts half-configured does not crash — it quietly relays
 *    nothing, and nobody notices until an event that should have gone out did
 *    not (`docs/04` §6).
 *  - **Boot failures go straight to stderr.** A buffered logger discarded the
 *    API's boot failure and the process exited having printed nothing.
 *  - **SIGTERM is a graceful drain, with a deadline.** Draining must not become
 *    hanging: the orchestrator will SIGKILL us anyway, and dying at a moment we
 *    chose is tidier than dying at one we did not.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const started: StartedWorker = await createWorkerRuntime(env, logger).start();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    const deadline = setTimeout(() => {
      logger.warn({ event: 'worker.shutdown.forced', graceMs: env.WORKER_SHUTDOWN_GRACE_MS });
      process.exit(1);
    }, env.WORKER_SHUTDOWN_GRACE_MS);
    deadline.unref();

    void started.shutdown(signal).then(
      () => {
        clearTimeout(deadline);
        process.exit(0);
      },
      (error: unknown) => {
        logger.error({
          event: 'worker.shutdown.failed',
          message: error instanceof Error ? error.message : 'unknown',
        });
        clearTimeout(deadline);
        process.exit(1);
      },
    );
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // An unhandled rejection in a background loop would otherwise leave the
  // process alive and idle — the worst possible state for a relay, because
  // liveness probes pass while nothing is being published.
  process.on('unhandledRejection', (reason: unknown) => {
    logger.fatal({
      event: 'worker.unhandled_rejection',
      message: reason instanceof Error ? reason.message : String(reason),
    });
    shutdown('unhandledRejection');
  });
}

main().catch((error: unknown) => {
  writeBootFailure('worker.boot.failed', error);
  process.exit(1);
});
