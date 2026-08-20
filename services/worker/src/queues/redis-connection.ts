import type { ConnectionOptions } from 'bullmq';

/**
 * `REDIS_URL` → the connection BullMQ opens for itself.
 *
 * BullMQ is handed *options*, not a connected client: given options it opens
 * and owns one connection per Queue and per Worker, which is what the blocking
 * commands a Worker issues require. Sharing one client across Workers would
 * mean a `BRPOPLPUSH` in one queue blocks every other queue on the same socket
 * — the bulkhead of `docs/07` §4 undone by an optimisation. It also means
 * `queue.close()` / `worker.close()` really close something, which is what
 * makes the graceful shutdown observable rather than aspirational.
 *
 * `maxRetriesPerRequest: null` is mandatory for BullMQ: with a finite retry
 * budget a blocking command that outlives it throws, and the worker would treat
 * a transient reconnect as a job failure.
 */
export function redisConnectionOptions(url: string): ConnectionOptions {
  return { url, maxRetriesPerRequest: null };
}
