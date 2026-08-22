import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'vims:idempotent';

/**
 * How long a completed result stays replayable, and how long one in-flight
 * attempt may hold the key before another attempt is allowed to take it over.
 *
 * Both are per-route rather than global because they answer different questions.
 * `ttlHours` is "how long can a client still be retrying this?" — `docs/07` §4
 * fixes the default at 24 h, which covers a tablet that lost its network on
 * Friday evening and came back on Saturday morning. `lockSeconds` is "how long
 * could this handler legitimately still be running?" — it must exceed the
 * slowest realistic execution of the route, because when it elapses the next
 * attempt is allowed to run the handler again.
 */
export interface IdempotencyOptions {
  readonly ttlHours: number;
  readonly lockSeconds: number;
}

export const DEFAULT_IDEMPOTENCY_OPTIONS: IdempotencyOptions = {
  // docs/07 §4: "idempotency results cached 24 h".
  ttlHours: 24,
  // `DATABASE_STATEMENT_TIMEOUT_MS` defaults to 15 s, so a handler that is still
  // holding the key after 60 s has died rather than slowed down.
  lockSeconds: 60,
};

/**
 * Declares that a route requires an `Idempotency-Key` header.
 *
 * Mirrors `@Permission()` deliberately, including the boot-time assertion: the
 * options are validated when the controller module is loaded, so a route that
 * asks for a two-second lock or a thousand-hour TTL stops the process at start
 * rather than producing a subtly wrong retry window in production.
 *
 * `CLAUDE.md` §3 requires this on "all money-moving and order-creating
 * endpoints". The header is required and not merely honoured: a client that
 * forgets it gets a 400 it can fix, whereas silently accepting the request means
 * the one submission that gets retried is the one with no protection.
 */
export function Idempotent(options: Partial<IdempotencyOptions> = {}): CustomDecorator<string> {
  const merged: IdempotencyOptions = { ...DEFAULT_IDEMPOTENCY_OPTIONS, ...options };

  if (!Number.isInteger(merged.ttlHours) || merged.ttlHours < 1 || merged.ttlHours > 720) {
    throw new Error(
      `@Idempotent(): ttlHours must be a whole number of hours between 1 and 720, received ${String(merged.ttlHours)}.`,
    );
  }
  if (!Number.isInteger(merged.lockSeconds) || merged.lockSeconds < 5 || merged.lockSeconds > 900) {
    throw new Error(
      `@Idempotent(): lockSeconds must be a whole number of seconds between 5 and 900, received ${String(merged.lockSeconds)}.`,
    );
  }

  return SetMetadata(IDEMPOTENT_KEY, merged);
}
