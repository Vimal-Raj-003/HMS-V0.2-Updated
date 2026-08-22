import type { ProblemDetails } from '@vims/contracts';
import { ApiProblem } from '@/lib/api';

/**
 * The clinical feature's HTTP call: `@/lib/api`'s `apiFetch` plus the one header
 * it has no parameter for, `Idempotency-Key`.
 *
 * Almost every write in this feature is `@Idempotent()` on the API side, and the
 * idempotency interceptor **fails closed** — a POST without the header is
 * refused with 400 rather than executed. That is not incidental here: a tablet
 * that loses its network mid-save must not produce two observation sets a doctor
 * then has to reconcile, and a retried prescription must not become two scripts
 * at the pharmacy counter.
 *
 * `@/lib/api` is outside this change's remit, so the header is added here rather
 * than by editing a file another change owns. When `apiFetch` grows an
 * `idempotencyKey` option this file becomes a one-line delegation.
 *
 * `ApiProblem` is deliberately the one from `@/lib/api` rather than a local
 * subclass: `ProblemCard` does an `instanceof` check, and a second class would
 * render every clinical refusal as the generic "This did not load" with no
 * reference id and no `nextAction` — which on a hard stop is the difference
 * between an instruction and a shrug.
 */
export interface ClinicalRequest {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** Sent as `x-reason`; the policy engine demands it for every `requiresReason` key. */
  readonly reason?: string;
  /** Sent as `Idempotency-Key`. One key per **intent**, reused by every retry of it. */
  readonly idempotencyKey?: string;
}

export async function request<T>(path: string, options: ClinicalRequest = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.reason !== undefined) headers['x-reason'] = options.reason;
  if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;

  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    // Session tokens live in httpOnly cookies, so they are never readable by
    // script — which is what makes an XSS bug non-fatal for the session.
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

let fallbackCounter = 0;

/**
 * A fresh idempotency key, minted **once per intent**.
 *
 * A key regenerated on retry is exactly the same thing as having no key at all,
 * so callers hold theirs across retries. `crypto.randomUUID` everywhere it
 * exists; the fallback is for a jsdom environment whose `crypto` shim predates
 * the method. It is deliberately not `Math.random`, which `docs/09` §2 bans for
 * making a failing test irreproducible and which ESLint refuses to compile.
 */
export function newIdempotencyKey(): string {
  const webCrypto = globalThis.crypto as Crypto | undefined;
  if (webCrypto !== undefined && typeof webCrypto.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }
  fallbackCounter += 1;
  return `vims-${Date.now().toString(36)}-${fallbackCounter.toString(36).padStart(6, '0')}`;
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
