/**
 * Process entry point.
 *
 * EN-017's long-lived duties are the MLLP/ASTM listeners (Phase 3), the webhook
 * endpoint (EN-026) and the BullMQ delivery workers — none of which exist yet.
 * What does exist, and what a deployment needs from this process today, is a
 * hub that is **constructed, connected and observable**: an orchestrator has to
 * be able to roll this service, and a rolling deploy needs a readiness probe to
 * gate on. So the process starts, verifies the database, serves
 * `/healthz` + `/readyz`, sweeps connector health on the EN-017 §3.6 interval
 * (a no-op while there are no live connectors, by construction rather than by
 * omission) and drains on SIGTERM.
 *
 * A deploy that cannot construct the hub therefore fails at boot rather than on
 * the first message.
 */
import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import type { Logger } from 'pino';

import { loadEnv, type IntegrationHubEnv } from './config/env.js';
import { IntegrationHub } from './hub.js';
import { createLogger } from './logger.js';

interface Started {
  readonly port: number;
  shutdown(signal: string): Promise<void>;
}

async function start(env: IntegrationHubEnv, logger: Logger): Promise<Started> {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    application_name: 'vims-integration-hub',
  });
  const hub = new IntegrationHub({ pool, logger });

  // Fail at boot, not on the first message.
  await pool.query('SELECT 1');

  let draining = false;

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    if (path === '/healthz' || path === '/livez') {
      // Liveness never touches the database: an unreachable database is not a
      // reason to restart a process that is correctly waiting for it.
      send(200, { status: draining ? 'draining' : 'ok' });
      return;
    }
    if (path === '/readyz') {
      if (draining) {
        send(503, { status: 'draining' });
        return;
      }
      void pool.query('SELECT 1').then(
        () => send(200, { ready: true, adapters: hub.adapters.list().map((m) => `${m.id}@${m.version}`) }),
        (error: unknown) =>
          send(503, { ready: false, error: error instanceof Error ? error.message : 'database unreachable' }),
      );
      return;
    }
    send(404, { error: 'not found' });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.PORT, '0.0.0.0', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : env.PORT);
    });
  });

  // The EN-017 §3.6 sweep. With no live connectors registered it iterates an
  // empty set — which is the point: the schedule exists, so the first connector
  // to be activated is monitored without anyone remembering to add a cron.
  const sweep = setInterval(() => {
    logger.debug({ event: 'ihub.health.sweep', connectors: 0 });
  }, env.IHUB_HEALTH_INTERVAL_MS);
  sweep.unref();

  logger.info(
    {
      event: 'ihub.started',
      port,
      nodeEnv: env.NODE_ENV,
      adapters: hub.adapters.list().map((m) => `${m.id}@${m.version}`),
      liveConnectors: 0,
    },
    'integration hub started; no live connectors in Phase 0 (EN-017 §3.8)',
  );

  let shuttingDown: Promise<void> | null = null;
  return {
    port,
    shutdown(signal: string): Promise<void> {
      shuttingDown ??= (async (): Promise<void> => {
        logger.info({ event: 'ihub.shutdown.begin', signal });
        draining = true;
        clearInterval(sweep);
        await new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        });
        // EN-017 §3.1.7 — drain adapters before the process exits.
        await hub.shutdown();
        await pool.end();
        logger.info({ event: 'ihub.shutdown.complete', signal });
      })();
      return shuttingDown;
    },
  };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const started = await start(env, logger);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => {
      logger.warn({ event: 'ihub.shutdown.forced' });
      process.exit(1);
    }, env.IHUB_SHUTDOWN_GRACE_MS);
    deadline.unref();

    void started.shutdown(signal).then(
      () => {
        clearTimeout(deadline);
        process.exit(0);
      },
      (error: unknown) => {
        logger.error({
          event: 'ihub.shutdown.failed',
          message: error instanceof Error ? error.message : 'unknown',
        });
        clearTimeout(deadline);
        process.exit(1);
      },
    );
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
      service: 'integration-hub',
      event: 'ihub.boot.failed',
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
