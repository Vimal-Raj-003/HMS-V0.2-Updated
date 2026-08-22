import { createHash } from 'node:crypto';

/**
 * What "the same request" means, reduced to 64 hex characters.
 *
 * The fingerprint is the half of idempotency that protects the *patient* rather
 * than the server. Replaying a stored response for a repeat of the same key is
 * only correct if the repeat really is the same request; if the body changed,
 * replaying means the caller believes it submitted ₹5,000 and the server
 * answered with the receipt for ₹500. That is a client bug, and the only safe
 * response is to refuse loudly — which requires being able to tell the two
 * apart, which is what this computes.
 *
 * Key ordering is normalised because `{"a":1,"b":2}` and `{"b":2,"a":1}` are the
 * same request and a naive `JSON.stringify` would call them different, turning
 * every retry from a client that serialises non-deterministically into a 409.
 * Array order is *not* normalised: `[dose1, dose2]` is not `[dose2, dose1]`.
 */
export interface FingerprintInput {
  readonly method: string;
  readonly route: string;
  /** Path parameters — `/cash/receipts/:id/void` is a different request per id. */
  readonly params: unknown;
  readonly query: unknown;
  readonly body: unknown;
}

export function fingerprintRequest(input: FingerprintInput): string {
  const canonical = stableStringify({
    method: input.method.toUpperCase(),
    route: input.route,
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Deterministic JSON: object keys sorted, `undefined` collapsed to `null`.
 *
 * Written out rather than pulled from a dependency because the output is stored
 * in a column and compared against rows written by an older deployment — a
 * library upgrade that changed the encoding would turn every in-flight retry
 * into a 409 at exactly the moment of a rollout.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      // NaN and ±Infinity have no JSON form; they cannot reach here from a
      // parsed request body, and collapsing them to null keeps the function
      // total rather than throwing inside an interceptor.
      return Number.isFinite(value) ? String(value) : 'null';
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'object': {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
      return `{${parts.join(',')}}`;
    }
    case 'undefined':
    case 'symbol':
    case 'function':
      // None of these can appear in a parsed request body; they are listed so
      // the exhaustiveness check keeps this total if a case is ever added.
      return 'null';
  }

  // Unreachable: the switch covers every `typeof` result. Present because the
  // compiler cannot prove that over `unknown`, and a function that falls off the
  // end would return `undefined` into a hash input.
  return 'null';
}

/**
 * The header, validated.
 *
 * `null` means "not supplied"; a string means a usable key. Anything else — an
 * empty string, whitespace, a 4 KB blob, a repeated header — is rejected by the
 * caller with a 400 rather than being silently trimmed into something that
 * collides with another client's key.
 */
export type KeyCheck =
  | { readonly kind: 'ok'; readonly key: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly detail: string };

/** VARCHAR(200) in `core.idempotency_keys`; a UUID or ULID is ~36. */
const MAX_KEY_LENGTH = 200;
const MIN_KEY_LENGTH = 8;
/** Printable ASCII only: the value is echoed into problem details and logs. */
const KEY_PATTERN = /^[\x21-\x7e]+$/;

export function checkIdempotencyKey(raw: string | readonly string[] | undefined): KeyCheck {
  if (raw === undefined) return { kind: 'missing' };
  if (Array.isArray(raw)) {
    return { kind: 'invalid', detail: 'The Idempotency-Key header was sent more than once.' };
  }
  const value = (raw as string).trim();
  if (value.length === 0) return { kind: 'missing' };
  if (value.length < MIN_KEY_LENGTH) {
    return {
      kind: 'invalid',
      detail: `An idempotency key must be at least ${String(MIN_KEY_LENGTH)} characters — a short key collides with another submission.`,
    };
  }
  if (value.length > MAX_KEY_LENGTH) {
    return {
      kind: 'invalid',
      detail: `An idempotency key may be at most ${String(MAX_KEY_LENGTH)} characters.`,
    };
  }
  if (!KEY_PATTERN.test(value)) {
    return { kind: 'invalid', detail: 'An idempotency key may contain printable ASCII characters only.' };
  }
  return { kind: 'ok', key: value };
}
