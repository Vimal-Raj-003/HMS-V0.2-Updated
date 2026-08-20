/**
 * HTTP status -> `ErrorClass`, once, for all three HTTP messaging adapters.
 *
 * `adapter/types.ts` says why this must not be re-decided per adapter: the retry
 * policy, the circuit breaker and the DLQ all key off the class, so "is this
 * worth retrying?" is answered by the hub rather than eleven times,
 * inconsistently, inside eleven adapters. Three adapters agreeing on the mapping
 * only because they were written the same afternoon is not agreement.
 */
import type { DispatchFailure, ErrorClass } from '../../adapter/types.js';
import { isRetryableErrorClass } from '../../adapter/types.js';
import { HttpTransportError, type HttpResponse } from './transport.js';

export function classifyHttpStatus(status: number): ErrorClass {
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 422) return 'validation';
  if (status >= 400 && status < 500) return 'semantic_4xx';
  if (status >= 500) return 'partner_5xx';
  // A 3xx from a messaging API means the endpoint moved; that is a
  // configuration fault, not a transient one.
  return 'semantic_4xx';
}

/** `Retry-After` in seconds or as an HTTP date. Providers use both. */
export function retryAfterMs(response: HttpResponse, now: Date): number | undefined {
  const header = response.headers['retry-after'];
  if (header === undefined) return undefined;
  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && String(seconds) === header.trim()) return seconds * 1000;
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - now.getTime());
  return undefined;
}

export function failureFromResponse(input: {
  readonly response: HttpResponse;
  readonly latencyMs: number;
  readonly now: Date;
  readonly code?: string;
  readonly message?: string;
}): DispatchFailure {
  const errorClass = classifyHttpStatus(input.response.status);
  const delay = retryAfterMs(input.response, input.now);
  return {
    status: 'failed',
    errorClass,
    ...(input.code === undefined ? {} : { code: input.code }),
    ...(input.message === undefined ? {} : { message: input.message }),
    retryable: isRetryableErrorClass(errorClass),
    ...(delay === undefined ? {} : { retryAfterMs: delay }),
    latencyMs: input.latencyMs,
    httpStatus: input.response.status,
  };
}

export function failureFromTransport(error: unknown, latencyMs: number): DispatchFailure {
  if (error instanceof HttpTransportError) {
    return {
      status: 'failed',
      errorClass: error.kind,
      message: error.message,
      retryable: true,
      latencyMs,
    };
  }
  // An adapter that throws something else has a defect; `poison` puts it in
  // front of a human instead of looping (dispatcher `callAdapter`).
  return {
    status: 'failed',
    errorClass: 'poison',
    message: error instanceof Error ? error.message : 'non-Error thrown by the transport',
    retryable: false,
    latencyMs,
  };
}

/** Parses a JSON body without letting a malformed one throw out of `send()`. */
export function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}
