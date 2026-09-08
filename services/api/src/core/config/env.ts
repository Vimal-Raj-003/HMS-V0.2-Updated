import { z } from 'zod';

/**
 * Environment contract.
 *
 * Parsed once at boot and never read from `process.env` again. A missing or
 * malformed variable must stop the process *before* it accepts traffic:
 * `docs/04` §6 treats a service that starts with a half-configured secret as a
 * security incident, because the failure surfaces later as a wrong answer rather
 * than as a crash.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  API_PREFIX: z.string().default('api/v1'),

  /** Connection used by the application role `hms_app` — NOBYPASSRLS. */
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  /** Statement timeout for application queries (docs/07 §5 sets 15 s). */
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000),

  REDIS_URL: z.string().url(),

  /**
   * Access tokens are short-lived (15 min per CLAUDE.md §2) and signed with a
   * secret that must differ from the refresh secret: if one leaks, the other
   * must not also be compromised.
   */
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .default(60 * 60 * 24 * 30),
  JWT_ISSUER: z.string().default('vims-hms'),

  /** Idle timeout, docs/05: 15 minutes for clinical screens. */
  SESSION_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(60).default(900),
  SESSION_ABSOLUTE_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(600)
    .default(60 * 60 * 12),
  SESSION_MAX_CONCURRENT: z.coerce.number().int().min(1).default(5),

  /** docs/05: lockout after 5 failed attempts. */
  AUTH_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  AUTH_LOCKOUT_SECONDS: z.coerce.number().int().min(30).default(900),
  AUTH_PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).default(12),

  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_DEFAULT_MAX: z.coerce.number().int().min(1).default(300),
  /** Login and OTP are credential-stuffing targets and get a much tighter budget. */
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(10),

  /** OpenAPI is auth-gated outside development (phase-00 §0.3). */
  OPENAPI_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
    .default(false),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // ── PE-009 · the public assistant ──────────────────────────────────────────
  //
  // Every one of these is optional, and that is the point: with no key
  // configured the assistant still answers, from the hospital's own directory
  // and a written script, and says so. A landing page that breaks because a
  // third-party model is unreachable is a landing page that goes down when
  // somebody else's API does.
  ASSISTANT_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === 'boolean' ? v : v !== 'false'))
    .default(true),
  /**
   * Any OpenAI-shaped `/chat/completions` endpoint — DeepSeek
   * (`https://api.deepseek.com/v1`) is the one this was written against, but
   * nothing here is specific to it. On-prem deployments point this at a model
   * inside their own network, which for a hospital is often the only acceptable
   * answer.
   */
  ASSISTANT_LLM_BASE_URL: z.string().url().optional(),
  ASSISTANT_LLM_API_KEY: z.string().min(8).optional(),
  ASSISTANT_LLM_MODEL: z.string().default('deepseek-chat'),
  /** A visitor will not wait, and neither should a request thread. */
  ASSISTANT_LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(12_000),

  /** Per caller, per window. A public endpoint that reaches a model is a bill. */
  ASSISTANT_RATE_WINDOW_SECONDS: z.coerce.number().int().min(10).default(300),
  ASSISTANT_RATE_CHAT_MAX: z.coerce.number().int().min(1).default(20),
  ASSISTANT_RATE_REQUEST_MAX: z.coerce.number().int().min(1).default(5),
});

export type Env = z.infer<typeof envSchema>;

export class EnvironmentError extends Error {
  constructor(issues: string) {
    super(`Invalid environment:\n${issues}`);
    this.name = 'EnvironmentError';
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new EnvironmentError(issues);
  }
  return parsed.data;
}

export const ENV = Symbol('ENV');
