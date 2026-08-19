import { z } from 'zod';

/**
 * Environment contract for `services/realtime`.
 *
 * The JWT variables are deliberately **the same names and the same semantics**
 * as `services/api/src/core/config/env.ts`. A realtime gateway that verified a
 * different token, or verified the same token differently, would be a second
 * authentication system: one of the two would eventually drift, and the drift
 * would surface as either a locked-out clinician or an unauthenticated socket.
 * There is exactly one access token in this product, and this file names it the
 * same way the API does.
 *
 * Parsed once at boot; `process.env` is never read again (`docs/04` §6 — a
 * service that starts half-configured fails later as a wrong answer instead of
 * as a crash).
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3002),

  REDIS_URL: z.string().url(),

  /** Same secret and issuer as the API: one token, one verifier contract. */
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default('vims-hms'),

  /**
   * `docs/01` §6: "max 1 push/sec per room (coalesced)". This is the *floor* on
   * the spacing between two pushes to one room, not a polling interval.
   */
  REALTIME_PUSH_INTERVAL_MS: z.coerce.number().int().min(1).default(1_000),

  /** Bounds the work one `subscribe` frame can ask for. */
  REALTIME_MAX_ROOMS_PER_SOCKET: z.coerce.number().int().min(1).default(64),

  /**
   * `docs/01` §6: "clients reconcile with a REST snapshot on reconnect
   * (`?since=<cursor>`)". The gateway hands the client the path to call and the
   * cursor to send, so the reconnect story is not folklore in a frontend README.
   */
  REALTIME_SNAPSHOT_PATH: z.string().default('/api/v1/realtime/snapshot'),

  /** Comma-separated allow-list; empty means same-origin only. */
  REALTIME_CORS_ORIGINS: z
    .string()
    .default('')
    .transform((raw) => raw.split(',').map((o) => o.trim()).filter((o) => o.length > 0)),

  REALTIME_PING_INTERVAL_MS: z.coerce.number().int().min(1_000).default(25_000),
  REALTIME_PING_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(20_000),

  /** How long a SIGTERM waits for in-flight sockets before it stops waiting. */
  REALTIME_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(10_000),

  /** Presence keys expire so a hard-killed pod cannot leave a user "online" forever. */
  REALTIME_PRESENCE_TTL_SECONDS: z.coerce.number().int().min(10).default(120),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type RealtimeEnv = z.infer<typeof envSchema>;

export class EnvironmentError extends Error {
  constructor(issues: string) {
    super(`Invalid environment:\n${issues}`);
    this.name = 'EnvironmentError';
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): RealtimeEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new EnvironmentError(issues);
  }
  return parsed.data;
}
