import { Queue, Worker, type ConnectionOptions, type Job, type JobsOptions } from 'bullmq';
import type { Logger } from 'pino';
import type { Pool } from 'pg';

import { printJobLogContext, printLogger } from './logger.js';
import {
  dispatchArtifact,
  renderPrintArtifact,
  type PrintPayloadSource,
  type TransportResolver,
} from './print-dispatcher.js';
import {
  cancelStalePrintJobs,
  emitPrintEvent,
  lockPrintJob,
  updatePrintJobStatus,
  type PrintJobRecord,
} from './print-job-repository.js';
import type { PdfRendererPort } from './pdf-renderer.js';
import {
  findPrinter,
  listAlternativePrinters,
  printerUnavailableReason,
  resolvePrinter,
  withPrintScope,
  type PrinterResolutionContext,
} from './printer-registry.js';
import {
  PrintPermanentError,
  PrinterUnavailableError,
  type PrintArtifact,
  type PrintJobStatus,
  type PrinterTarget,
  type PrinterUnavailableReason,
} from './types.js';

/**
 * The print queue processor (`EN-005 §3.3`, `phase-00 §0.4`).
 *
 * Three behaviours here are requirements, not choices:
 *
 * **A device fault never fails a job.** `docs/01 §7`: "Printer offline → job
 * stays in the print queue with retry + 'print elsewhere' option." So a
 * paper-out leaves `status = 'queued'`, increments `attempts`, records the
 * reason, and returns the list of printers that *could* take it. The user is
 * offered a choice; nothing is lost. Only when the retry window closes does the
 * job become `failed` and page IT.
 *
 * **The retry window is time, not tries.** `EN-005 §3.3.2` is precise: "retries
 * every 30 s for 10 min then failed with alert". Twenty-one attempts at a fixed
 * 30 s is exactly that window, and it is expressed as
 * `windowMs / intervalMs + 1` so changing the policy cannot desynchronise the
 * two halves.
 *
 * **Rendering happens outside the transaction.** A Chromium PDF render takes
 * ~1 s; holding a row lock (and a pooled connection) for it would let one busy
 * printer stall the connection pool. So the job is claimed in one short
 * transaction, rendered and dispatched with no database connection held, and the
 * outcome written in a second — and because the claim increments `attempts`, a
 * crash in between costs a retry rather than a duplicated receipt.
 */

export const PRINT_QUEUE_NAME = 'print.jobs';

/** `docs/07 §4`: token/receipt/label printing is the `interactive` class. */
export const PRINT_QUEUE_PRIORITY = 2;

export interface PrintRetryPolicy {
  /** `EN-005 §3.3.2`: retry every 30 s… */
  readonly intervalMs: number;
  /** …for 10 minutes, then fail with an alert. */
  readonly windowMs: number;
}

export const DEFAULT_PRINT_RETRY: PrintRetryPolicy = Object.freeze({ intervalMs: 30_000, windowMs: 600_000 });

export function maxAttemptsFor(policy: PrintRetryPolicy = DEFAULT_PRINT_RETRY): number {
  return Math.floor(policy.windowMs / policy.intervalMs) + 1;
}

/** `EN-005 §5`: a job still queued after this long is cancelled, not printed. */
export const STALE_JOB_HOURS = 24;

/**
 * What BullMQ carries. Deliberately only identifiers — `docs/04 §7` keeps PHI
 * out of logs, and Redis job data is dumped by every queue dashboard.
 * `createdAt` travels because `core.print_jobs` is partitioned on it and the
 * primary key is `(id, created_at)`.
 */
export interface PrintJobRef {
  readonly jobId: string;
  readonly createdAt: string;
  readonly hospitalId: string;
  readonly branchId: string;
}

export type PrintJobOutcome =
  | { readonly state: 'printed'; readonly jobId: string; readonly pages: number | null }
  | { readonly state: 'sent'; readonly jobId: string; readonly agentId: string | null }
  | {
      readonly state: 'deferred';
      readonly jobId: string;
      readonly reason: PrinterUnavailableReason;
      readonly attempts: number;
      readonly retryInMs: number;
      /** `docs/01 §7`'s "print elsewhere" offer. */
      readonly alternatives: readonly PrinterTarget[];
    }
  | { readonly state: 'failed'; readonly jobId: string; readonly reason: string; readonly permanent: boolean }
  | { readonly state: 'cancelled'; readonly jobId: string; readonly reason: string }
  | { readonly state: 'fallback_browser'; readonly jobId: string }
  | { readonly state: 'already_final'; readonly jobId: string; readonly status: PrintJobStatus }
  | { readonly state: 'missing'; readonly jobId: string };

export interface PrintProcessorDeps {
  readonly pool: Pool;
  readonly pdf: PdfRendererPort;
  readonly payloads: PrintPayloadSource;
  readonly transports: TransportResolver;
  readonly logger?: Logger;
  readonly retry?: PrintRetryPolicy;
  /** Injected so a test can age a job without waiting a day (`docs/09 §2`). */
  readonly now?: () => Date;
  /** Scope ids the job row does not carry (counter, location, department). */
  readonly resolutionContext?: Partial<PrinterResolutionContext>;
}

/** A job in one of these states is finished; re-running must not reprint it. */
const FINAL_STATUSES: ReadonlySet<PrintJobStatus> = new Set<PrintJobStatus>([
  'completed',
  'cancelled',
  'failed',
  'fallback_browser',
]);

function resolutionContextFor(job: PrintJobRecord, deps: PrintProcessorDeps): PrinterResolutionContext {
  return {
    hospitalId: job.hospitalId,
    branchId: job.branchId,
    docType: job.docType,
    userId: job.requestedBy,
    workstationId: job.workstationId,
    ...deps.resolutionContext,
  };
}

interface ClaimPlan {
  readonly job: PrintJobRecord;
  readonly printer: PrinterTarget;
  readonly copies: number;
}

type ClaimResult =
  | { readonly kind: 'proceed'; readonly plan: ClaimPlan }
  | { readonly kind: 'done'; readonly outcome: PrintJobOutcome };

/**
 * Phase 1 — claim the job, resolve its printer, and decide whether to print.
 *
 * Runs inside one short tenant-scoped transaction. Returns either a plan to
 * execute (with no locks held) or a finished outcome.
 */
async function claim(deps: PrintProcessorDeps, ref: PrintJobRef): Promise<ClaimResult> {
  const now = deps.now ?? ((): Date => new Date());
  const retry = deps.retry ?? DEFAULT_PRINT_RETRY;
  const maxAttempts = maxAttemptsFor(retry);

  return withPrintScope(
    deps.pool,
    { hospitalId: ref.hospitalId, branchIds: [ref.branchId] },
    async (client) => {
      const job = await lockPrintJob(client, ref.jobId, ref.createdAt);
      if (job === null) return { kind: 'done', outcome: { state: 'missing', jobId: ref.jobId } } as const;

      if (FINAL_STATUSES.has(job.status)) {
        return {
          kind: 'done',
          outcome: { state: 'already_final', jobId: job.id, status: job.status },
        } as const;
      }

      // EN-005 §5: yesterday's token must never print itself today.
      const ageMs = now().getTime() - job.createdAt.getTime();
      if (job.status === 'queued' && ageMs > STALE_JOB_HOURS * 3_600_000) {
        const reason = `Auto-cancelled: queued for more than ${STALE_JOB_HOURS} h (EN-005 §5).`;
        await updatePrintJobStatus(client, job, { status: 'cancelled', error: reason, completed: true });
        await emitPrintEvent(client, {
          hospitalId: job.hospitalId,
          branchId: job.branchId,
          eventType: 'print.job.cancelled',
          aggregateId: job.id,
          payload: { jobId: job.id, reason },
        });
        return { kind: 'done', outcome: { state: 'cancelled', jobId: job.id, reason } } as const;
      }

      const context = resolutionContextFor(job, deps);
      const printer =
        job.printerId !== null
          ? await findPrinter(client, job.printerId)
          : ((await resolvePrinter(client, context))?.printer ?? null);

      // EN-005 §3.3.3: no printer covers this workstation → the browser prints it.
      if (printer === null) {
        const reason =
          'No printer mapping covers this workstation; falling back to browser printing (EN-005 §3.3.3).';
        await updatePrintJobStatus(client, job, {
          status: 'fallback_browser',
          error: reason,
          completed: true,
        });
        return { kind: 'done', outcome: { state: 'fallback_browser', jobId: job.id } } as const;
      }

      const attempts = job.attempts + 1;
      const unavailable = printerUnavailableReason(printer, now());

      if (unavailable !== null) {
        const exhausted = attempts >= maxAttempts;
        const message = `Printer "${printer.name}" unavailable (${unavailable}).`;

        if (exhausted) {
          await updatePrintJobStatus(client, job, {
            status: 'failed',
            attempts,
            error: `${message} Retry window of ${retry.windowMs / 60_000} min exhausted.`,
            printerId: printer.printerId,
            completed: true,
          });
          await emitPrintEvent(client, {
            hospitalId: job.hospitalId,
            branchId: job.branchId,
            eventType: 'print.job.failed',
            aggregateId: job.id,
            payload: { jobId: job.id, error: unavailable, attempts },
          });
          return {
            kind: 'done',
            outcome: { state: 'failed', jobId: job.id, reason: unavailable, permanent: false },
          } as const;
        }

        // The job stays QUEUED. docs/01 §7 — never failed, never dropped.
        await updatePrintJobStatus(client, job, {
          status: 'queued',
          attempts,
          error: message,
          printerId: printer.printerId,
        });
        const alternatives = await listAlternativePrinters(client, context, printer.printerId, now());
        return {
          kind: 'done',
          outcome: {
            state: 'deferred',
            jobId: job.id,
            reason: unavailable,
            attempts,
            retryInMs: retry.intervalMs,
            alternatives,
          },
        } as const;
      }

      const claimed = await updatePrintJobStatus(client, job, {
        status: 'queued',
        attempts,
        error: null,
        printerId: printer.printerId,
        agentId: printer.agentId,
      });

      return {
        kind: 'proceed',
        plan: { job: claimed, printer, copies: Math.max(1, claimed.copies) },
      } as const;
    },
  );
}

/** Phase 3 — write the outcome back, with its outbox event, in one transaction. */
async function settle(
  deps: PrintProcessorDeps,
  plan: ClaimPlan,
  outcome:
    | { readonly kind: 'printed'; readonly pages: number | null }
    | { readonly kind: 'sent' }
    | { readonly kind: 'unavailable'; readonly reason: PrinterUnavailableReason }
    | { readonly kind: 'failed'; readonly message: string; readonly permanent: boolean },
): Promise<PrintJobOutcome> {
  const now = deps.now ?? ((): Date => new Date());
  const retry = deps.retry ?? DEFAULT_PRINT_RETRY;
  const maxAttempts = maxAttemptsFor(retry);
  const job = plan.job;

  return withPrintScope(
    deps.pool,
    { hospitalId: job.hospitalId, branchIds: [job.branchId] },
    async (client) => {
      switch (outcome.kind) {
        case 'printed': {
          await updatePrintJobStatus(client, job, {
            status: 'completed',
            error: null,
            pages: outcome.pages,
            completed: true,
          });
          await emitPrintEvent(client, {
            hospitalId: job.hospitalId,
            branchId: job.branchId,
            eventType: 'print.job.completed',
            aggregateId: job.id,
            payload: { jobId: job.id, pages: outcome.pages ?? 0 },
          });
          return { state: 'printed', jobId: job.id, pages: outcome.pages };
        }

        case 'sent': {
          await updatePrintJobStatus(client, job, { status: 'sent', error: null });
          if (plan.printer.agentId !== null) {
            await emitPrintEvent(client, {
              hospitalId: job.hospitalId,
              branchId: job.branchId,
              eventType: 'print.job.sent',
              aggregateId: job.id,
              payload: { jobId: job.id, agentId: plan.printer.agentId },
            });
          }
          return { state: 'sent', jobId: job.id, agentId: plan.printer.agentId };
        }

        case 'unavailable': {
          const exhausted = job.attempts >= maxAttempts;
          const message = `Printer "${plan.printer.name}" unavailable (${outcome.reason}).`;
          if (exhausted) {
            await updatePrintJobStatus(client, job, {
              status: 'failed',
              error: `${message} Retry window of ${retry.windowMs / 60_000} min exhausted.`,
              completed: true,
            });
            await emitPrintEvent(client, {
              hospitalId: job.hospitalId,
              branchId: job.branchId,
              eventType: 'print.job.failed',
              aggregateId: job.id,
              payload: { jobId: job.id, error: outcome.reason, attempts: job.attempts },
            });
            return { state: 'failed', jobId: job.id, reason: outcome.reason, permanent: false };
          }

          await updatePrintJobStatus(client, job, { status: 'queued', error: message });
          const alternatives = await listAlternativePrinters(
            client,
            resolutionContextFor(job, deps),
            plan.printer.printerId,
            now(),
          );
          return {
            state: 'deferred',
            jobId: job.id,
            reason: outcome.reason,
            attempts: job.attempts,
            retryInMs: retry.intervalMs,
            alternatives,
          };
        }

        case 'failed': {
          await updatePrintJobStatus(client, job, {
            status: 'failed',
            error: outcome.message,
            completed: true,
          });
          await emitPrintEvent(client, {
            hospitalId: job.hospitalId,
            branchId: job.branchId,
            eventType: 'print.job.failed',
            aggregateId: job.id,
            payload: { jobId: job.id, error: outcome.message.slice(0, 500), attempts: job.attempts },
          });
          return { state: 'failed', jobId: job.id, reason: outcome.message, permanent: outcome.permanent };
        }
      }
    },
  );
}

/**
 * Process one print job end to end.
 *
 * Exported separately from the BullMQ worker so the behaviour can be tested
 * against a real database without a Redis instance — the queue is transport, the
 * state machine is the thing worth asserting.
 */
export async function processPrintJob(deps: PrintProcessorDeps, ref: PrintJobRef): Promise<PrintJobOutcome> {
  const logger = deps.logger ?? printLogger;

  const claimed = await claim(deps, ref);
  if (claimed.kind === 'done') {
    logger.debug({ jobId: ref.jobId, outcome: claimed.outcome.state }, 'print job did not proceed');
    return claimed.outcome;
  }

  const plan = claimed.plan;
  logger.debug(printJobLogContext(plan.job), 'print job claimed');

  let artifact: PrintArtifact;
  try {
    const envelope = await deps.payloads.load(plan.job);
    artifact = await renderPrintArtifact(plan.job, envelope, deps.pdf);
  } catch (error) {
    const permanent = error instanceof PrintPermanentError;
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ ...printJobLogContext(plan.job), permanent }, 'print job render failed');
    return settle(deps, plan, { kind: 'failed', message, permanent });
  }

  try {
    const result = await dispatchArtifact(
      { job: plan.job, printer: plan.printer, artifact, copies: plan.copies },
      deps.transports,
    );
    if (result.state === 'printed') {
      return await settle(deps, plan, { kind: 'printed', pages: artifact.pages ?? result.pages ?? null });
    }
    return await settle(deps, plan, { kind: 'sent' });
  } catch (error) {
    if (error instanceof PrinterUnavailableError) {
      logger.warn(
        { ...printJobLogContext(plan.job), reason: error.reason },
        'printer unavailable; job stays queued',
      );
      return settle(deps, plan, { kind: 'unavailable', reason: error.reason });
    }
    const permanent = error instanceof PrintPermanentError;
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ ...printJobLogContext(plan.job), permanent }, 'print job dispatch failed');
    return settle(deps, plan, { kind: 'failed', message, permanent });
  }
}

/** Sweep of `EN-005 §5`, run on the maintenance schedule. */
export async function cancelStalePrintJobsForTenant(
  deps: Pick<PrintProcessorDeps, 'pool' | 'logger'>,
  hospitalId: string,
  branchIds: readonly string[],
  olderThanHours = STALE_JOB_HOURS,
): Promise<number> {
  const logger = deps.logger ?? printLogger;
  const cancelled = await withPrintScope(deps.pool, { hospitalId, branchIds }, async (client) => {
    const rows = await cancelStalePrintJobs(client, hospitalId, olderThanHours);
    for (const job of rows) {
      await emitPrintEvent(client, {
        hospitalId: job.hospitalId,
        branchId: job.branchId,
        eventType: 'print.job.cancelled',
        aggregateId: job.id,
        payload: { jobId: job.id, reason: `Queued for more than ${olderThanHours} h (EN-005 §5).` },
      });
    }
    return rows.length;
  });

  if (cancelled > 0) logger.info({ hospitalId, cancelled }, 'stale print jobs auto-cancelled');
  return cancelled;
}

// ── BullMQ wiring ────────────────────────────────────────────────────────────

/**
 * Queue options for a print job.
 *
 * `jobId` is the print job's own id, which makes enqueueing idempotent: an event
 * relayed twice (the outbox is at-least-once by design) cannot produce two
 * slips. Backoff is *fixed*, not exponential — a queue of tokens waiting on one
 * paper-out printer must all recover the moment paper is loaded, and exponential
 * backoff would leave the earliest job waiting the longest.
 */
export function printJobOptions(
  ref: PrintJobRef,
  retry: PrintRetryPolicy = DEFAULT_PRINT_RETRY,
): JobsOptions {
  return {
    jobId: ref.jobId,
    priority: PRINT_QUEUE_PRIORITY,
    attempts: maxAttemptsFor(retry),
    backoff: { type: 'fixed', delay: retry.intervalMs },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86_400 },
  };
}

export function createPrintQueue(connection: ConnectionOptions): Queue<PrintJobRef, PrintJobOutcome> {
  return new Queue<PrintJobRef, PrintJobOutcome>(PRINT_QUEUE_NAME, { connection });
}

export async function enqueuePrintJob(
  queue: Queue<PrintJobRef, PrintJobOutcome>,
  ref: PrintJobRef,
  retry: PrintRetryPolicy = DEFAULT_PRINT_RETRY,
): Promise<void> {
  await queue.add('print', ref, printJobOptions(ref, retry));
}

/**
 * The worker.
 *
 * A `deferred` outcome is rethrown so BullMQ schedules the next attempt: the row
 * in `core.print_jobs` is the record of truth and already says `queued`, while
 * the Redis job is what actually wakes up in 30 s. Returning normally would
 * leave the job correct in the database and forgotten by the queue.
 */
export function createPrintWorker(
  connection: ConnectionOptions,
  deps: PrintProcessorDeps,
  concurrency = 16,
): Worker<PrintJobRef, PrintJobOutcome> {
  return new Worker<PrintJobRef, PrintJobOutcome>(
    PRINT_QUEUE_NAME,
    async (job: Job<PrintJobRef, PrintJobOutcome>): Promise<PrintJobOutcome> => {
      const outcome = await processPrintJob(deps, job.data);
      if (outcome.state === 'deferred') {
        throw new PrinterUnavailableError(
          outcome.reason,
          null,
          `Print job ${outcome.jobId} deferred; retrying.`,
        );
      }
      return outcome;
    },
    { connection, concurrency },
  );
}
