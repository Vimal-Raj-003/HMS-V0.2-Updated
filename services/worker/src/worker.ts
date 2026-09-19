import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import type { Logger } from 'pino';

import { maintenanceUrl, type WorkerEnv } from './config/env.js';
import { createHealthServer, type ComponentState, type HealthServer } from './health/health.js';
import { CRITICAL_QUEUES, escalateOverdueCriticalValues } from './escalation/critical-value-escalation.js';
import { sealAuditChains } from './maintenance/audit-chain-sealer.js';
import { ensureMonthPartitions } from './maintenance/partition-maintenance.js';
import { postLedgerEntries } from './finance/ledger-poster.js';
import { sweepPublicRateLimits } from './maintenance/rate-limit-sweeper.js';
import { PlaywrightPdfRenderer } from './print/pdf-renderer.js';
import { MapTransportResolver } from './print/print-dispatcher.js';
import { createPrintWorker, type PrintJobOutcome, type PrintJobRef } from './print/print-queue.js';
import { RedisPayloadSource } from './print/redis-payload-source.js';
import { PRIORITY_CLASSES, PRIORITY_CLASS_NAMES, jobOptionsFor } from './queues/priority-classes.js';
import { redisConnectionOptions } from './queues/redis-connection.js';
import { relayOnce } from './relay/outbox-relay.js';
import { createPollLoop, type PollLoop } from './runtime/poll-loop.js';

/**
 * The worker process, assembled.
 *
 * `docs/01` §1 gives this process four standing duties, and every one of them
 * already existed in this package as a tested function with nothing to call it:
 *
 *  | duty                  | class (`docs/07` §4) | driver                       |
 *  |-----------------------|----------------------|------------------------------|
 *  | outbox relay          | `standard`           | poll loop, 1 s idle interval |
 *  | audit chain sealer    | `maintenance`        | BullMQ scheduler, 60 s       |
 *  | partition premake     | `maintenance`        | BullMQ scheduler, 1 h        |
 *  | print queue           | `interactive`        | BullMQ worker, concurrency 16|
 *
 * **Why the relay is a loop and the rest are jobs.** A queue-driven relay needs
 * something to enqueue it; the only thing that knows there is outbox work to do
 * is the relay itself, so a scheduler would just be a slower loop with a Redis
 * round-trip in front. The sealer and the partition premake are the opposite:
 * they are periodic regardless of load, and putting them in the `maintenance`
 * queue gives them the §4 concurrency of 2 and — because a BullMQ job scheduler
 * is a single shared key — makes N worker replicas run one sealer, not N.
 */
export interface WorkerRuntime {
  start(): Promise<StartedWorker>;
}

export interface StartedWorker {
  /** The port the health server actually bound (0 in env → an ephemeral port). */
  readonly healthPort: number;
  readonly mounted: readonly string[];
  shutdown(signal: string): Promise<void>;
}

export const AUDIT_SEAL_JOB = 'audit.seal';
export const PARTITION_ENSURE_JOB = 'partition.ensure';
/** PE-009 §C: drops rate-limit counters for callers who stopped calling. */
export const RATE_LIMIT_SWEEP_JOB = 'ratelimit.sweep';
/** NC-009 §3.2: turns money events into journals. */
export const LEDGER_POST_JOB = 'ledger.post';
/**
 * `docs/07 §4` lists "EWS escalation" and "critical result fan-out" under the
 * `critical` class, so this belongs there and not in `maintenance`. A ladder
 * that escalates a potassium of 7.4 must not queue behind a partition premake.
 */
export const CRITICAL_ESCALATION_JOB = 'critical.escalate';

interface MaintenanceJobData {
  readonly reason: string;
}

interface MaintenanceJobResult {
  readonly job: string;
  readonly detail: Readonly<Record<string, number>>;
}

export function createWorkerRuntime(env: WorkerEnv, logger: Logger): WorkerRuntime {
  return {
    async start(): Promise<StartedWorker> {
      const connection = redisConnectionOptions(env.REDIS_URL);

      // Two pools, deliberately. The print path runs as `hms_app` under
      // `SET LOCAL app.hospital_id` (RLS applies); the relay, the sealer and the
      // partition premake are cross-tenant by nature and use the maintenance
      // role. Running the print path on the maintenance connection would make
      // every RLS test in this repo prove nothing about production.
      const appPool = new Pool({
        connectionString: env.DATABASE_URL,
        max: env.DATABASE_POOL_MAX,
        application_name: 'vims-worker-app',
        statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
      });
      const maintenancePool = new Pool({
        connectionString: maintenanceUrl(env),
        max: env.DATABASE_POOL_MAX,
        application_name: 'vims-worker-maintenance',
        statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
      });

      // The relay's stream writer, and the health probe's ping. Separate from
      // BullMQ's connections so a blocking queue command cannot delay a publish.
      const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
      redis.on('error', (error: Error) => {
        logger.error({ event: 'worker.redis.error', message: error.message });
      });

      const mounted: string[] = [];
      const loops: PollLoop[] = [];
      const queues: Queue[] = [];
      const closers: Array<() => Promise<void>> = [];

      // ── standard: the outbox relay ───────────────────────────────────────
      const relayLoop = createPollLoop({
        name: 'worker.outbox-relay',
        intervalMs: env.OUTBOX_POLL_INTERVAL_MS,
        logger,
        tick: async (): Promise<boolean> => {
          const result = await relayOnce(maintenancePool, redis, {
            batchSize: env.OUTBOX_BATCH_SIZE,
            maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
          });
          if (result.published > 0 || result.failed > 0 || result.deadLettered > 0) {
            logger.info({
              event: 'worker.outbox.relayed',
              published: result.published,
              failed: result.failed,
              deadLettered: result.deadLettered,
            });
          }
          // A full batch means there is almost certainly more waiting; skip the
          // idle wait so a burst drains at Redis speed rather than 200/second.
          return result.published >= env.OUTBOX_BATCH_SIZE;
        },
      });
      loops.push(relayLoop);
      mounted.push('outbox-relay(standard)');

      // ── the five priority classes ────────────────────────────────────────
      // Every class gets its queue, so a producer in `services/api` addresses a
      // name that exists and a dashboard shows five bulkheads rather than one.
      // Only classes with a Phase-0 processor get a Worker: an idle Worker is a
      // blocking Redis connection that would fail any job it did receive.
      const classQueues = new Map<string, Queue>();
      for (const name of PRIORITY_CLASS_NAMES) {
        const queue = new Queue(PRIORITY_CLASSES[name].queueName, { connection });
        classQueues.set(name, queue);
        queues.push(queue);
      }

      // ── maintenance: audit sealing + partition premake ───────────────────
      const maintenanceQueue = classQueues.get('maintenance');
      if (maintenanceQueue === undefined) throw new Error('maintenance queue was not created');

      const maintenanceWorker = new Worker<MaintenanceJobData, MaintenanceJobResult>(
        PRIORITY_CLASSES.maintenance.queueName,
        async (job: Job<MaintenanceJobData, MaintenanceJobResult>): Promise<MaintenanceJobResult> => {
          switch (job.name) {
            case AUDIT_SEAL_JOB: {
              const sealed = await sealAuditChains(maintenancePool);
              const rows = sealed.reduce((total, s) => total + s.sealed, 0);
              if (rows > 0) {
                logger.info({ event: 'worker.audit.sealed', tenants: sealed.length, rows });
              }
              return { job: job.name, detail: { tenants: sealed.length, rows } };
            }
            case PARTITION_ENSURE_JOB: {
              const result = await ensureMonthPartitions(maintenancePool, {
                monthsAhead: env.PARTITION_PREMAKE_MONTHS,
                monthsBehind: env.PARTITION_BACKFILL_MONTHS,
              });
              if (result.created.length > 0) {
                logger.info({ event: 'worker.partitions.created', partitions: result.created });
              }
              // ADR-0008 traded a clinical outage for a monitored anomaly. This
              // is the monitor; a silent default partition would be the outage
              // arriving late instead of early.
              if (result.nonEmptyDefaults.length > 0) {
                logger.warn({
                  event: 'worker.partitions.default_not_empty',
                  partitions: result.nonEmptyDefaults,
                });
              }
              return {
                job: job.name,
                detail: {
                  ensured: result.ensured,
                  created: result.created.length,
                  nonEmptyDefaults: result.nonEmptyDefaults.length,
                },
              };
            }
            case LEDGER_POST_JOB: {
              const result = await postLedgerEntries(maintenancePool);
              if (result.posted > 0) {
                logger.info({ event: 'worker.ledger.posted', journals: result.posted });
              }
              // An event that cannot be valued or has nowhere to land is the
              // finance exception worklist, and silence about it is how a
              // period close fails to tie out three weeks later.
              for (const problem of result.problems) {
                logger.warn({ event: 'worker.ledger.unpostable', detail: problem });
              }
              return {
                job: job.name,
                detail: { posted: result.posted, skipped: result.skipped, problems: result.problems.length },
              };
            }
            case RATE_LIMIT_SWEEP_JOB: {
              const swept = await sweepPublicRateLimits(maintenancePool);
              if (swept.deleted > 0) {
                logger.info({ event: 'worker.ratelimit.swept', rows: swept.deleted });
              }
              return { job: job.name, detail: { deleted: swept.deleted } };
            }
            default:
              throw new Error(`No handler is registered for maintenance job "${job.name}".`);
          }
        },
        { connection, concurrency: PRIORITY_CLASSES.maintenance.concurrency },
      );
      maintenanceWorker.on('failed', (job, error: Error) => {
        logger.error({
          event: 'worker.maintenance.failed',
          job: job?.name ?? 'unknown',
          attempts: job?.attemptsMade ?? 0,
          message: error.message,
        });
      });
      closers.push(() => maintenanceWorker.close());

      await maintenanceQueue.upsertJobScheduler(
        AUDIT_SEAL_JOB,
        { every: env.AUDIT_SEAL_INTERVAL_MS },
        { name: AUDIT_SEAL_JOB, data: { reason: 'schedule' }, opts: jobOptionsFor('maintenance') },
      );
      await maintenanceQueue.upsertJobScheduler(
        PARTITION_ENSURE_JOB,
        { every: env.PARTITION_MAINTENANCE_INTERVAL_MS },
        { name: PARTITION_ENSURE_JOB, data: { reason: 'schedule' }, opts: jobOptionsFor('maintenance') },
      );
      // Hourly. The rows are tiny and bounded by distinct callers, so this is
      // tidiness rather than pressure relief; anything more frequent would be
      // a delete looking for work.
      const RATE_LIMIT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
      await maintenanceQueue.upsertJobScheduler(
        RATE_LIMIT_SWEEP_JOB,
        { every: RATE_LIMIT_SWEEP_INTERVAL_MS },
        { name: RATE_LIMIT_SWEEP_JOB, data: { reason: 'schedule' }, opts: jobOptionsFor('maintenance') },
      );
      mounted.push(`public-rate-limit-sweeper(maintenance,${String(RATE_LIMIT_SWEEP_INTERVAL_MS)}ms)`);

      // Every two minutes. Frequent enough that a controller looking at the
      // ledger sees this morning's takings, infrequent enough that it is not
      // polling the outbox for its own sake.
      const LEDGER_POST_INTERVAL_MS = 2 * 60 * 1000;
      await maintenanceQueue.upsertJobScheduler(
        LEDGER_POST_JOB,
        { every: LEDGER_POST_INTERVAL_MS },
        { name: LEDGER_POST_JOB, data: { reason: 'schedule' }, opts: jobOptionsFor('maintenance') },
      );
      mounted.push(`ledger-poster(maintenance,${String(LEDGER_POST_INTERVAL_MS)}ms)`);
      mounted.push(`audit-chain-sealer(maintenance,${env.AUDIT_SEAL_INTERVAL_MS}ms)`);
      mounted.push(`partition-maintenance(maintenance,${env.PARTITION_MAINTENANCE_INTERVAL_MS}ms)`);

      // ── critical: the critical-value ladder ──────────────────────────────
      //
      // The database raises the alert in the same transaction as the value, so
      // storing a critical result and owing a phone call cannot come apart. What
      // no trigger can do is notice that nobody answered — `due_by` was written
      // at detection and, until this was mounted, nothing ever read it.
      const criticalQueue = classQueues.get('critical');
      if (criticalQueue === undefined) throw new Error('critical queue was not created');

      const criticalWorker = new Worker<MaintenanceJobData, MaintenanceJobResult>(
        PRIORITY_CLASSES.critical.queueName,
        async (job: Job<MaintenanceJobData, MaintenanceJobResult>): Promise<MaintenanceJobResult> => {
          if (job.name !== CRITICAL_ESCALATION_JOB) {
            throw new Error(`No handler is registered for critical job "${job.name}".`);
          }
          const detail: Record<string, number> = {};
          for (const queue of CRITICAL_QUEUES) {
            const result = await escalateOverdueCriticalValues(maintenancePool, queue);
            detail[`${queue.aggregate}.escalated`] = result.escalated;
            detail[`${queue.aggregate}.atTopTier`] = result.atTopTier;
            if (result.escalated > 0) {
              // Ids and counts only. The analyte, the value and a radiologist's
              // finding text are all PHI and none of them belong in a log line.
              logger.warn({
                event: 'worker.critical.escalated',
                queue: queue.table,
                escalated: result.escalated,
              });
            }
          }
          return { job: job.name, detail };
        },
        { connection, concurrency: PRIORITY_CLASSES.critical.concurrency },
      );
      criticalWorker.on('failed', (job, error: Error) => {
        logger.error({
          event: 'worker.critical.failed',
          job: job?.name ?? 'unknown',
          attempts: job?.attemptsMade ?? 0,
          message: error.message,
        });
      });
      closers.push(() => criticalWorker.close());

      await criticalQueue.upsertJobScheduler(
        CRITICAL_ESCALATION_JOB,
        { every: env.CRITICAL_ESCALATION_INTERVAL_MS },
        { name: CRITICAL_ESCALATION_JOB, data: { reason: 'schedule' }, opts: jobOptionsFor('critical') },
      );
      mounted.push(`critical-value-escalation(critical,${env.CRITICAL_ESCALATION_INTERVAL_MS}ms)`);

      // ── interactive: the print queue ─────────────────────────────────────
      let printWorker: Worker<PrintJobRef, PrintJobOutcome> | null = null;
      let pdfRenderer: PlaywrightPdfRenderer | null = null;
      if (env.PRINT_WORKER_ENABLED) {
        // Constructed, not launched: `PlaywrightPdfRenderer` starts Chromium on
        // its first render, so a pod with no print traffic never pays for one
        // and a pod with no browser installed fails on a job rather than at boot.
        pdfRenderer = new PlaywrightPdfRenderer();
        printWorker = createPrintWorker(
          connection,
          {
            pool: appPool,
            pdf: pdfRenderer,
            payloads: new RedisPayloadSource(redis),
            // Phase 0 has no LAN print-agent transport (`EN-005 §3.3.3`). With
            // no transport registered the dispatcher raises a permanent error
            // naming the browser-print fallback, which is the honest outcome —
            // a registered no-op transport would report every job as printed.
            transports: new MapTransportResolver(),
            logger,
          },
          env.PRINT_CONCURRENCY,
        );
        printWorker.on('failed', (job, error: Error) => {
          logger.error({
            event: 'worker.print.failed',
            jobId: job?.id ?? 'unknown',
            attempts: job?.attemptsMade ?? 0,
            message: error.message,
          });
        });
        const worker = printWorker;
        closers.push(() => worker.close());
        mounted.push(`print-queue(interactive,concurrency=${env.PRINT_CONCURRENCY})`);
      }

      // ── health ───────────────────────────────────────────────────────────
      const health: HealthServer = createHealthServer({
        pool: maintenancePool,
        redis,
        logger,
        port: env.PORT,
        components: (): Readonly<Record<string, ComponentState>> => {
          const state: Record<string, ComponentState> = {};
          for (const loop of loops) {
            state[loop.name] = { running: loop.running, ticks: loop.ticks, lastError: loop.lastError };
          }
          state['worker.maintenance'] = { running: maintenanceWorker.isRunning() };
          if (printWorker !== null) state['worker.print'] = { running: printWorker.isRunning() };
          return state;
        },
      });
      const healthPort = await health.listen();

      for (const loop of loops) loop.start();

      logger.info({
        event: 'worker.started',
        nodeEnv: env.NODE_ENV,
        healthPort,
        mounted,
        classes: PRIORITY_CLASS_NAMES.map(
          (n) => `${n}:p${PRIORITY_CLASSES[n].priority}/c${PRIORITY_CLASSES[n].concurrency}`,
        ),
      });

      let shuttingDown: Promise<void> | null = null;

      return {
        healthPort,
        mounted: Object.freeze([...mounted]),
        shutdown(signal: string): Promise<void> {
          shuttingDown ??= (async (): Promise<void> => {
            logger.info({ event: 'worker.shutdown.begin', signal });
            // Order matters. Readiness goes red first so the orchestrator stops
            // routing and stops counting us before any work is refused; then we
            // stop *taking* work; only then do we tear down what in-flight work
            // still needs.
            health.beginDraining();
            await Promise.all([
              ...loops.map((loop) => loop.stop()),
              // BullMQ's close() waits for active jobs to finish by default —
              // this is the "finish in-flight work" half of the contract.
              ...closers.map((close) => close()),
            ]);
            await Promise.all(queues.map((queue) => queue.close()));
            if (pdfRenderer !== null) await pdfRenderer.close();
            await health.close();
            await Promise.all([appPool.end(), maintenancePool.end()]);
            redis.disconnect();
            logger.info({ event: 'worker.shutdown.complete', signal });
          })();
          return shuttingDown;
        },
      };
    },
  };
}
