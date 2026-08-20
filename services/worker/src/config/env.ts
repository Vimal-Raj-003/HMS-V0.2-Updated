import { z } from 'zod';

/**
 * Environment contract for `services/worker`.
 *
 * Deliberately the same shape, the same failure mode and the same variable
 * names as `services/api/src/core/config/env.ts`: parsed once at boot, never
 * read from `process.env` again, and a malformed value stops the process before
 * it takes a single job. `docs/04` §6 treats a half-configured service as a
 * security incident, because the failure surfaces later as a wrong answer
 * rather than as a crash — and for this process a "wrong answer" is an event
 * that was never relayed or an audit row that was never sealed.
 *
 * `DATABASE_URL` here is the **application** role (`hms_app`, NOBYPASSRLS). The
 * relay and the sealer additionally need to see every tenant's rows, which is
 * why they run through `DATABASE_MAINTENANCE_URL` when it is set — a separate,
 * explicitly-granted role rather than a quietly-elevated application one
 * (`docs/04` §6). When it is absent the app URL is used, which is correct for a
 * single-tenant on-prem deployment and wrong for nothing.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Liveness/readiness only. No business endpoint is ever served from here. */
  PORT: z.coerce.number().int().min(1).max(65535).default(3003),

  DATABASE_URL: z.string().url(),
  /**
   * Optional. The role the relay, the sealer and the partition job use.
   * `docs/07` §4 sizes a worker pod at 6 connections; the default matches.
   */
  DATABASE_MAINTENANCE_URL: z.string().url().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(6),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(30_000),

  REDIS_URL: z.string().url(),

  /**
   * `docs/07` §4 puts the outbox relay in the `standard` class. The poll
   * interval is the *idle* interval: a batch that filled completely is followed
   * immediately by another, so a burst drains at Redis speed and an empty table
   * costs one indexed query per interval (`idx_outbox_unpublished`).
   */
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1_000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(5_000).default(200),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(10),

  /**
   * `EN-024` §14: an unsealed audit backlog is an alertable anomaly, because an
   * unsealed row is not yet covered by the tamper-evidence the §65B evidence
   * chain depends on. Every 60 s bounds the exposure without turning the sealer
   * into a hot loop.
   */
  AUDIT_SEAL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),

  /**
   * ADR-0008: the worker owns partition maintenance, not `pg_partman`. Hourly,
   * because the function is idempotent and returns early when the partition
   * exists — the cost of running it too often is one catalogue lookup per
   * table, and the cost of running it too rarely is a clinical transaction
   * landing in a DEFAULT partition.
   */
  PARTITION_MAINTENANCE_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  /** `docs/07` §4: "premake 3 months ahead". One behind, for back-dated catch-up entry. */
  PARTITION_PREMAKE_MONTHS: z.coerce.number().int().min(1).max(24).default(3),
  PARTITION_BACKFILL_MONTHS: z.coerce.number().int().min(0).max(24).default(1),

  /** `docs/07` §4 `interactive` class concurrency. */
  PRINT_CONCURRENCY: z.coerce.number().int().min(1).max(200).default(16),
  /**
   * The print worker needs a Chromium (`playwright install chromium`) and a LAN
   * transport that Phase 0 does not have. It is mounted by default because the
   * queue must exist for the API to enqueue into, and can be switched off for a
   * pod that has no browser.
   */
  PRINT_WORKER_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === 'boolean' ? v : v !== 'false'))
    .default(true),

  /**
   * How long SIGTERM waits for in-flight jobs before it stops waiting. Longer
   * than the API's, because a print render or a relay batch is measured in
   * seconds and being SIGKILLed mid-batch costs a duplicate publish.
   */
  WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(30_000),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type WorkerEnv = z.infer<typeof envSchema>;

export class EnvironmentError extends Error {
  constructor(issues: string) {
    super(`Invalid environment:\n${issues}`);
    this.name = 'EnvironmentError';
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new EnvironmentError(issues);
  }
  return parsed.data;
}

/** The connection the relay, sealer and partition job use. */
export function maintenanceUrl(env: WorkerEnv): string {
  return env.DATABASE_MAINTENANCE_URL ?? env.DATABASE_URL;
}
