import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { createAccessTokenVerifier } from './auth/access-token.js';
import { loadEnv } from './config/env.js';
import { createGateway } from './gateway/gateway.js';
import { createLogger } from './logger.js';
import { eventToDiff } from './events/event-router.js';
import { createStreamConsumer } from './events/stream-consumer.js';
import { createRedisPresenceStore } from './presence/presence.js';

/**
 * Process entry point.
 *
 * The Redis adapter needs two connections — one publishing, one subscribing —
 * because a connection in subscribe mode cannot issue other commands. With it,
 * `io.to(room).emit()` on any instance reaches every client in that room on
 * every instance, which is what removes the need for sticky sessions
 * (`docs/01` §6).
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);

  const pub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  const sub = pub.duplicate();
  const presenceRedis = pub.duplicate();
  // Its own connection: `XREADGROUP ... BLOCK` parks the socket for up to a
  // second at a time, and sharing it with presence would stall every heartbeat
  // behind an idle stream read.
  const eventsRedis = pub.duplicate();

  for (const [name, client] of [
    ['pub', pub],
    ['sub', sub],
    ['presence', presenceRedis],
    ['events', eventsRedis],
  ] as const) {
    client.on('error', (error: Error) => {
      logger.error({ event: 'realtime.redis.error', client: name, message: error.message });
    });
  }

  const gateway = createGateway({
    env,
    logger,
    verifier: createAccessTokenVerifier({
      secret: env.JWT_ACCESS_SECRET,
      issuer: env.JWT_ISSUER,
    }),
    presence: createRedisPresenceStore(presenceRedis, {
      ttlSeconds: env.REALTIME_PRESENCE_TTL_SECONDS,
    }),
    installAdapter: (io) => {
      io.adapter(createAdapter(pub, sub));
    },
  });

  /**
   * The half of `docs/01 §3` step 10 that reads the stream.
   *
   * `services/worker` has relayed committed outbox rows to
   * `hms:events:<hospital>` since Phase 0 and nothing consumed them, so every
   * board in `docs/01 §6` was a screen that never updated and every budget in
   * `docs/07 §2.3` described a path that was not connected.
   *
   * The consumer name must be unique per pod or two pods would split one pod's
   * backlog between them and each would think it had delivered everything.
   * `HOSTNAME` is what Kubernetes sets to the pod name; the pid is the fallback
   * that keeps two local processes apart.
   */
  const consumerName = process.env['HOSTNAME'] ?? `realtime-${String(process.pid)}`;
  const events = createStreamConsumer({
    redis: eventsRedis,
    logger,
    consumer: consumerName,
    deliver: (room, event) => {
      gateway.emitter.push(room, eventToDiff(event));
    },
  });
  events.start();

  const port = await gateway.listen();
  logger.info({ event: 'realtime.started', port, nodeEnv: env.NODE_ENV, consumer: consumerName });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: 'realtime.shutdown.begin', signal });

    // A hard deadline: draining must not become hanging. The orchestrator will
    // SIGKILL us anyway, and dying at a time we chose is tidier than dying at
    // one we did not.
    const deadline = setTimeout(() => {
      logger.warn({ event: 'realtime.shutdown.forced' });
      process.exit(1);
    }, env.REALTIME_SHUTDOWN_GRACE_MS);
    deadline.unref?.();

    void (async (): Promise<void> => {
      try {
        // Stop reading before closing the gateway, so nothing is delivered to
        // an emitter that is shutting down.
        await events.stop();
        await gateway.close(signal);
        await Promise.all([pub.quit(), sub.quit(), presenceRedis.quit(), eventsRedis.quit()]);
        logger.info({ event: 'realtime.shutdown.complete', signal });
        clearTimeout(deadline);
        process.exit(0);
      } catch (error) {
        logger.error({
          event: 'realtime.shutdown.failed',
          message: error instanceof Error ? error.message : 'unknown',
        });
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // The logger may not exist yet (a bad env is the usual cause), and this is the
  // one place a bare stderr write is the honest thing to do.
  process.stderr.write(
    `${JSON.stringify({
      level: 'fatal',
      service: 'vims-realtime',
      event: 'realtime.boot.failed',
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
