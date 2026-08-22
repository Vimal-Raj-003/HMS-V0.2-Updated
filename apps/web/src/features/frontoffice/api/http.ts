import type { ProblemDetails } from '@vims/contracts';
import { ApiProblem } from '@/lib/api';

/**
 * The front office's HTTP call, which is `@/lib/api`'s `apiFetch` plus the one
 * header it has no parameter for: `Idempotency-Key`.
 *
 * Three of this feature's endpoints are marked `Idem = Y` by their module specs
 * — `POST /appointments`, `POST /queue/tokens` and `POST /cash/payments` — and
 * they are the three where a retry is expensive in a way a user notices: a
 * duplicate booking costs a patient their slot, a duplicate token puts one
 * person twice in a queue, and a duplicate receipt charges a patient twice for
 * one consultation. The proxy in `app/api/v1/[...path]` already forwards the
 * header; the client simply had no way to set it, and `@/lib/api` is outside
 * this task's boundary.
 *
 * Everything else is identical to `apiFetch` on purpose — same same-origin
 * proxy, same httpOnly cookie, same `ApiProblem` carrying `detail`, `nextAction`
 * and `reference`, because a screen that loses those fields cannot render the
 * error `docs/06` §1.1 requires.
 */
export interface FrontOfficeRequest {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** Sent as `x-reason`; required by the policy engine for every `requiresReason` key. */
  readonly reason?: string;
  /** Sent as `Idempotency-Key`; the caller generates and **retains** it across retries. */
  readonly idempotencyKey?: string;
}

export async function request<T>(path: string, options: FrontOfficeRequest = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.reason !== undefined) headers['x-reason'] = options.reason;
  if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;

  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    credentials: 'same-origin',
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('json')) {
      const problem = (await response.json()) as ProblemDetails;
      throw new ApiProblem(problem, response.status);
    }
    throw new ApiProblem(
      {
        type: 'about:blank',
        title: 'Something went wrong',
        status: response.status,
        reference: response.headers.get('x-trace-id') ?? 'unknown',
      },
      response.status,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * A stable idempotency key for one user intent.
 *
 * `crypto.randomUUID` rather than a counter or a timestamp: the key must be
 * unique across two counters submitting in the same millisecond, and it must be
 * generated **once per intent** and reused by every retry of that intent — a key
 * regenerated on retry is exactly the same thing as having no key at all.
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered === '' ? '' : `?${rendered}`;
}
