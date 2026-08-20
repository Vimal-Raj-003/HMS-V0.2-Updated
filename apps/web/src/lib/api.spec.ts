import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem, apiFetch } from './api';

/**
 * The HTTP client, and specifically the two things every reason-required screen
 * depends on: that `x-reason` actually leaves the browser, and that a failure
 * arrives as a problem the UI can render rather than as `Error('Request failed')`.
 */

function jsonResponse(body: unknown, init: { status: number; contentType: string }): Response {
  return new Response(JSON.stringify(body), {
    status: init.status,
    headers: { 'content-type': init.contentType },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch', () => {
  it('sends the reason as the x-reason header, which is what the policy engine reads', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true }, { status: 200, contentType: 'application/json' }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/v1/admin/users/u1/deactivate', {
      method: 'POST',
      body: { reason: 'Left the hospital' },
      reason: 'Left the hospital',
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-reason']).toBe('Left the hospital');
    expect(headers['content-type']).toBe('application/json');
    expect(init.credentials).toBe('same-origin');
  });

  it('omits the header entirely when there is no reason, rather than sending an empty one', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: true }, { status: 200, contentType: 'application/json' }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/v1/admin/users');

    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-reason']).toBeUndefined();
  });

  it('turns problem+json into an ApiProblem carrying the helpdesk reference', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            type: 'https://errors.vimshms.com/permission-denied',
            title: 'You do not have permission to do this',
            status: 403,
            detail: 'A reason is required for this action.',
            nextAction: 'Say why, then try again.',
            reference: 'trace-4471',
          },
          { status: 403, contentType: 'application/problem+json' },
        ),
      ),
    );

    const error = await apiFetch('/api/v1/admin/roles').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiProblem);
    const problem = error as ApiProblem;
    expect(problem.status).toBe(403);
    expect(problem.reference).toBe('trace-4471');
    expect(problem.message).toBe('A reason is required for this action.');
    expect(problem.problem.nextAction).toBe('Say why, then try again.');
  });

  it('still produces a reference when the server did not send problem+json at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('gateway blew up', { status: 502, headers: { 'x-trace-id': 'trace-99' } }),
        ),
    );

    const problem = (await apiFetch('/api/v1/admin/roles').catch((c: unknown) => c)) as ApiProblem;
    expect(problem.reference).toBe('trace-99');
    expect(problem.status).toBe(502);
  });

  it('exposes field errors by path so a form can put each one under its own input', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            type: 'https://errors.vimshms.com/validation-failed',
            title: 'Some details need correcting',
            status: 400,
            reference: 'trace-1',
            errors: [{ path: 'permissions', message: 'Not in the catalogue.' }],
          },
          { status: 400, contentType: 'application/problem+json' },
        ),
      ),
    );

    const problem = (await apiFetch('/api/v1/admin/roles').catch((c: unknown) => c)) as ApiProblem;
    expect(problem.fieldErrors.get('permissions')).toBe('Not in the catalogue.');
  });

  it('returns nothing for a 204 rather than trying to parse an empty body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(
      apiFetch('/api/v1/admin/users/u1/roles/r1', { method: 'DELETE', reason: 'x' }),
    ).resolves.toBeUndefined();
  });
});
