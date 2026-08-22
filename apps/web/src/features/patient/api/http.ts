import { ApiProblem } from '@/lib/api';
import type { ProblemDetails } from '@vims/contracts';

/**
 * The same HTTP client `@/lib/api` provides, plus the one header it cannot send.
 *
 * `POST /patients`, `POST /patients/merge` and `POST /patients/unmerge` are
 * `@Idempotent()` in `patient.controller.ts`, and the interceptor **fails closed**:
 * a request without an `Idempotency-Key` is refused with 400
 * `idempotency-key-missing`. `ApiRequest` in `@/lib/api` has no field for that
 * header, and `apps/web/src/lib` is outside this change's remit, so the header is
 * added here rather than by editing a file another change owns.
 *
 * Everything else is deliberately identical, including throwing `ApiProblem`
 * from `@/lib/api` rather than a local subclass — `ProblemCard` does an
 * `instanceof` check, and a second class would render every failure on these
 * three routes as the generic "This did not load" with no reference id.
 *
 * When `apiFetch` grows an `idempotencyKey` option this file becomes a one-line
 * delegation and should be deleted.
 */

export interface IdempotentRequest {
  readonly method: 'POST';
  readonly body: unknown;
  /** `x-reason`, for the reason-required permission keys. */
  readonly reason?: string;
  /**
   * One key per **submission**, not per retry (`docs/06` §6.6). Reusing it for a
   * retry of the same body replays the first answer; reusing it for a *different*
   * body is refused, which is why the desk mints a new one when the operator
   * changes the request — for instance by adding a duplicate override.
   */
  readonly idempotencyKey: string;
}

export async function idempotentFetch<T>(path: string, request: IdempotentRequest): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
    'idempotency-key': request.idempotencyKey,
  };
  if (request.reason !== undefined) headers['x-reason'] = request.reason;

  const response = await fetch(path, {
    method: request.method,
    headers,
    // Session tokens live in httpOnly cookies, so they are never readable by
    // script — which is what makes an XSS bug non-fatal for the session.
    credentials: 'same-origin',
    body: JSON.stringify(request.body),
  });

  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('problem+json') || contentType.includes('json')) {
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
 * A fresh idempotency key.
 *
 * `crypto.randomUUID` where the browser has it — every browser this product
 * supports does, over HTTPS. The fallback exists for the one case that is not a
 * browser: a jsdom test environment whose `crypto` shim predates the method.
 * It is deliberately not `Math.random`, which `docs/09` §2 bans for making a
 * failing test irreproducible, and which ESLint refuses to compile.
 */
export function newIdempotencyKey(): string {
  const webCrypto = globalThis.crypto as Crypto | undefined;
  if (webCrypto !== undefined && typeof webCrypto.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }
  fallbackCounter += 1;
  return `vims-${Date.now().toString(36)}-${fallbackCounter.toString(36).padStart(6, '0')}`;
}
