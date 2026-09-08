import { NextResponse } from 'next/server';
import { API_ORIGIN } from '@/lib/api-origin';

/**
 * The landing page's door to the assistant — and the only proxy here that does
 * not require a session.
 *
 * `/api/v1/[...path]` attaches the access-token cookie and returns 401 without
 * one, which is correct for every screen behind the login and useless for a
 * visitor who has never had an account. So this is a second, deliberately
 * narrow proxy:
 *
 *   - It forwards to `/api/v1/assistant/*` and nowhere else. The allow-list is
 *     the four public routes by name, not a prefix match, so a future
 *     authenticated route that happens to start with "assistant" cannot be
 *     reached through here by accident.
 *   - It attaches **no** authorization header. There is nothing to attach, and
 *     that is the point: this path cannot escalate, because it has no
 *     credential to escalate with.
 *   - It forwards the caller's address. Without this every visitor would arrive
 *     at the API wearing the Next server's IP, the rate limiter would see one
 *     enormous caller, and the first person to ask three questions would lock
 *     out everybody else in the country.
 */

/** By name, not by prefix. */
const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  'directory',
  'availability',
  'chat',
  'appointment-requests',
]);

function refuse(status: number, title: string, detail: string): NextResponse {
  return NextResponse.json(
    { type: 'https://errors.vimshms.com/not-found', title, status, detail, reference: 'client' },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

/**
 * The address the API should rate-limit against.
 *
 * The left-most entry of `x-forwarded-for` is the original client where a
 * trusted edge wrote the chain. This is a landing page behind Cloudflare or
 * Nginx in every documented deployment; where it is not, `x-real-ip` or the
 * platform header is used, and if none is present the API falls back to the
 * socket address, which is the Next server — pessimistic, and it fails closed.
 */
function callerAddress(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded !== null && forwarded.trim() !== '') {
    const first = forwarded.split(',')[0]?.trim();
    if (first !== undefined && first !== '') return first;
  }
  const real = request.headers.get('x-real-ip');
  return real !== null && real.trim() !== '' ? real.trim() : null;
}

async function proxy(request: Request, segments: readonly string[]): Promise<Response> {
  const route = segments[0];
  if (segments.length !== 1 || route === undefined || !PUBLIC_ROUTES.has(route)) {
    return refuse(404, 'Not available', 'That address is not part of the public assistant.');
  }

  const headers = new Headers({ accept: 'application/json' });
  const contentType = request.headers.get('content-type');
  if (contentType !== null) headers.set('content-type', contentType);

  const caller = callerAddress(request);
  if (caller !== null) headers.set('x-forwarded-for', caller);

  const search = new URL(request.url).search;
  const target = `${API_ORIGIN}/api/v1/assistant/${route}${search}`;

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      ...(hasBody ? { body: await request.text() } : {}),
      cache: 'no-store',
    });
  } catch {
    // The API being down should not render a blank chat panel with no
    // explanation. The widget shows this `detail` as the assistant's reply.
    return refuse(
      503,
      'The assistant is offline',
      'I cannot reach the hospital’s systems just now. Please call the hospital directly, or try again in a few minutes.',
    );
  }

  const responseHeaders = new Headers({ 'cache-control': 'no-store' });
  const upstreamType = upstream.headers.get('content-type');
  if (upstreamType !== null) responseHeaders.set('content-type', upstreamType);

  return new NextResponse(await upstream.text(), {
    status: upstream.status,
    headers: responseHeaders,
  });
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
