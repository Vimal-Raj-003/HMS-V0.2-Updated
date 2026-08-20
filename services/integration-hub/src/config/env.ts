import { z } from 'zod';

/**
 * Environment contract for `services/integration-hub`.
 *
 * Same shape and same failure mode as `services/api/src/core/config/env.ts` and
 * `services/worker/src/config/env.ts`: parsed once at boot, never read from
 * `process.env` again, and a malformed value stops the process before it can
 * accept a message. `docs/04` §6 — a service that starts half-configured fails
 * later as a wrong answer instead of as a crash, and for this process a wrong
 * answer is a partner message silently not delivered.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Liveness/readiness only. The MLLP/ASTM listeners arrive with Phase 3. */
  PORT: z.coerce.number().int().min(1).max(65535).default(3004),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(4),

  /** How often the connector health sweep runs (`EN-017` §3.6). */
  IHUB_HEALTH_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),
  IHUB_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(15_000),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type IntegrationHubEnv = z.infer<typeof envSchema>;

export class EnvironmentError extends Error {
  constructor(issues: string) {
    super(`Invalid environment:\n${issues}`);
    this.name = 'EnvironmentError';
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): IntegrationHubEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new EnvironmentError(issues);
  }
  return parsed.data;
}
