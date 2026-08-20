import { createServer, type Server } from 'node:http';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

/**
 * Liveness and readiness for a process that serves no traffic.
 *
 * A worker still needs both, and they must mean different things
 * (`docs/10` §6): **readiness** gates a rolling deploy — "DB reachable +
 * migrations at expected version + Redis reachable" — while **liveness** only
 * answers "is this process wedged". Conflating them is how a database blip
 * turns into an orchestrator killing every worker replica at once, which is
 * strictly worse than the blip.
 *
 * Readiness also flips to 503 the instant SIGTERM arrives, before any draining
 * starts. That is the whole point of the grace period: the load balancer and
 * the orchestrator must learn we are going away *before* we stop doing work,
 * not after.
 */
export interface HealthDeps {
  readonly pool: Pool;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly port: number;
  /** Named liveness contributors — the poll loops and BullMQ workers. */
  readonly components: () => Readonly<Record<string, ComponentState>>;
}

export interface ComponentState {
  readonly running: boolean;
  readonly ticks?: number;
  readonly lastError?: string | null;
}

export interface HealthServer {
  listen(): Promise<number>;
  /** Flip readiness to 503 without stopping the server, so probes see the drain. */
  beginDraining(): void;
  close(): Promise<void>;
}

/** The schema objects this worker cannot run without. Cheaper and more honest
 * than a version number: it asks whether the migrations this code needs are
 * actually present, rather than whether a counter matches. */
const REQUIRED_FUNCTIONS = [
  'core.ensure_month_partition',
  'core.seal_audit_chain',
  'core.verify_audit_chain',
] as const;

export interface ReadinessReport {
  readonly ready: boolean;
  readonly database: boolean;
  readonly redis: boolean;
  readonly migrations: boolean;
  readonly missing: readonly string[];
}

export async function checkReadiness(pool: Pool, redis: Redis): Promise<ReadinessReport> {
  let database = false;
  let migrations = false;
  const missing: string[] = [];

  try {
    await pool.query('SELECT 1');
    database = true;
    const { rows } = await pool.query<{ present: string }>(
      `SELECT p.oid::regprocedure::text AS present
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname || '.' || p.proname = ANY($1::text[])`,
      [[...REQUIRED_FUNCTIONS]],
    );
    const found = new Set(rows.map((r) => r.present.split('(')[0]));
    for (const fn of REQUIRED_FUNCTIONS) if (!found.has(fn)) missing.push(fn);
    migrations = missing.length === 0;
  } catch {
    database = false;
  }

  let redisUp = false;
  try {
    redisUp = (await redis.ping()) === 'PONG';
  } catch {
    redisUp = false;
  }

  return {
    ready: database && migrations && redisUp,
    database,
    redis: redisUp,
    migrations,
    missing: Object.freeze(missing),
  };
}

export function createHealthServer(deps: HealthDeps): HealthServer {
  let draining = false;

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    if (path === '/healthz' || path === '/livez') {
      // Liveness never touches a dependency: an unreachable database is not a
      // reason to restart a process that is correctly waiting for it.
      send(200, { status: draining ? 'draining' : 'ok', components: deps.components() });
      return;
    }

    if (path === '/readyz') {
      if (draining) {
        send(503, { status: 'draining' });
        return;
      }
      void checkReadiness(deps.pool, deps.redis).then(
        (report) => send(report.ready ? 200 : 503, report),
        (error: unknown) =>
          send(503, {
            ready: false,
            error: error instanceof Error ? error.message : 'readiness check failed',
          }),
      );
      return;
    }

    send(404, { error: 'not found' });
  });

  return {
    listen(): Promise<number> {
      return new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(deps.port, '0.0.0.0', () => {
          const address = server.address();
          const port = typeof address === 'object' && address !== null ? address.port : deps.port;
          deps.logger.info({ event: 'worker.health.listening', port });
          resolve(port);
        });
      });
    },
    beginDraining(): void {
      draining = true;
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
