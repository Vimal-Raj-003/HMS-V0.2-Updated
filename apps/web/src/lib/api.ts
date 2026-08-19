import type { ProblemDetails } from '@vims/contracts';

/**
 * The HTTP client every screen uses.
 *
 * It exists mainly to make one thing impossible to skip: an error response is
 * `application/problem+json`, and the UI needs `detail`, `nextAction` and
 * `reference` from it. Throwing a bare `Error('Request failed')` would discard
 * exactly the fields `docs/06` §1.1 says a clinical error message must carry —
 * what happened, what to do, and the reference to read to the helpdesk.
 */
export class ApiProblem extends Error {
  constructor(
    readonly problem: ProblemDetails,
    readonly status: number,
  ) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiProblem';
  }

  /** The support reference a user reads out. Always present by contract. */
  get reference(): string {
    return this.problem.reference;
  }

  get fieldErrors(): ReadonlyMap<string, string> {
    const map = new Map<string, string>();
    for (const error of this.problem.errors ?? []) map.set(error.path, error.message);
    return map;
  }
}

export interface ApiRequest {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** Reason for a break-glass or reason-required action; sent as `x-reason`. */
  readonly reason?: string;
}

export async function apiFetch<T>(path: string, request: ApiRequest = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (request.body !== undefined) headers['content-type'] = 'application/json';
  if (request.reason !== undefined) headers['x-reason'] = request.reason;

  const response = await fetch(path, {
    method: request.method ?? 'GET',
    headers,
    // Session tokens live in httpOnly cookies, so they are never readable by
    // script — which is what makes an XSS bug non-fatal for the session.
    credentials: 'same-origin',
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
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
