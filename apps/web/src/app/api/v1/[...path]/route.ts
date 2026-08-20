import { NextResponse } from 'next/server';
import { ACCESS_COOKIE } from '@/lib/session';
import { cookies } from 'next/headers';

/**
 * The browser's only door to `services/api`.
 *
 * Everything the admin console fetches from the client goes through here, for
 * the same reason the login route exists: the access token lives in an httpOnly
 * cookie, so no script in the page can read it, and therefore no script can send
 * it either. This route reads the cookie server-side and attaches the bearer
 * token, which keeps an XSS bug from becoming a session takeover and keeps the
 * API origin off the public internet in an on-prem deployment.
 *
 * It is a *transparent* proxy: status, `content-type` and body are passed
 * through untouched, so `application/problem+json` — with its `detail`,
 * `nextAction` and `reference` — reaches the screen intact. Rewriting an error
 * here would discard exactly the fields `docs/06` §1.1 requires a user-visible
 * failure to carry.
 */

const API_ORIGIN = process.env['API_ORIGIN'] ?? 'http://127.0.0.1:3001';

/**
 * Headers forwarded upstream.
 *
 * `x-reason` is the load-bearing one: the policy engine refuses every
 * reason-required permission (`admin.user.deactivate`, `admin.user.reset`,
 * `admin.role.assign`, `org.branch.manage`…) unless it is present, so dropping
 * it here would turn every reason dialog in the console into a 403.
 *
 * The list is an allow-list rather than a copy of the incoming headers because a
 * blind copy forwards `cookie` and `authorization` from the browser, which would
 * let a caller present their own credentials to the API and bypass the cookie.
 */
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'x-reason', 'idempotency-key'] as const;

/** Response headers worth surfacing; `x-trace-id` is the helpdesk reference. */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'x-trace-id'] as const;

function unauthenticated(): NextResponse {
  return NextResponse.json(
    {
      type: 'https://errors.vimshms.com/unauthenticated',
      title: 'Your session has ended',
      status: 401,
      detail: 'Sign in again to continue.',
      nextAction: 'Sign in',
      reference: 'no-session',
    },
    { status: 401, headers: { 'content-type': 'application/problem+json' } },
  );
}

async function proxy(request: Request, segments: readonly string[]): Promise<Response> {
  // Defence in depth. Next never produces a `..` segment from a catch-all match,
  // but a path that escapes `/api/v1` would reach unrelated API surface with a
  // valid token attached, so it is checked rather than assumed.
  if (segments.some((segment) => segment === '..' || segment.includes('/'))) {
    return NextResponse.json(
      {
        type: 'https://errors.vimshms.com/malformed-request',
        title: 'That address is not valid',
        status: 400,
        reference: 'client',
      },
      { status: 400, headers: { 'content-type': 'application/problem+json' } },
    );
  }

  const store = await cookies();
  const token = store.get(ACCESS_COOKIE)?.value;
  if (token === undefined) return unauthenticated();

  const headers = new Headers({ authorization: `Bearer ${token}` });
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  const search = new URL(request.url).search;
  const target = `${API_ORIGIN}/api/v1/${segments.map(encodeURIComponent).join('/')}${search}`;

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    ...(hasBody ? { body: await request.text() } : {}),
    cache: 'no-store',
  });

  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  // A tenant's data must never sit in a shared or browser cache.
  responseHeaders.set('cache-control', 'no-store');

  if (upstream.status === 204) return new NextResponse(null, { status: 204, headers: responseHeaders });
  return new NextResponse(await upstream.text(), { status: upstream.status, headers: responseHeaders });
}

interface RouteContext {
  readonly params: Promise<{ readonly path: readonly string[] }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, (await context.params).path);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, (await context.params).path);
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, (await context.params).path);
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, (await context.params).path);
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, (await context.params).path);
}
