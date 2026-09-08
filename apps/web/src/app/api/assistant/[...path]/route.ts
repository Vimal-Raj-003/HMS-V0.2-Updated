import { NextResponse } from 'next/server';
import { API_ORIGIN } from '@/lib/api-origin';
import { clientAddressConfig, resolveClientAddress } from '@/lib/client-address';

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
 *   - It forwards the caller's address, but only when the deployment has said
 *     which proxy header it can believe. An unconfigured deployment forwards
 *     nothing rather than forwarding something the caller chose — see
 *     `lib/client-address.ts` for why the left-most `X-Forwarded-For` entry is
 *     a rate-limit bypass and not an IP address.
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

async function proxy(request: Request, segments: readonly string[]): Promise<Response> {
  const route = segments[0];
  if (segments.length !== 1 || route === undefined || !PUBLIC_ROUTES.has(route)) {
    return refuse(404, 'Not available', 'That address is not part of the public assistant.');
  }

  const headers = new Headers({ accept: 'application/json' });
  const contentType = request.headers.get('content-type');
  if (contentType !== null) headers.set('content-type', contentType);

  // Only what a proxy this deployment has declared trustworthy actually wrote —
  // see `lib/client-address.ts`. Taking the left-most `X-Forwarded-For` entry,
  // which is what this did first, hands the caller their own rate-limit key:
  // a fresh value per request is a fresh bucket per request, and the limiter in
  // front of a metered language model counts to one forever.
  //
  // `null` means the deployment has not said what is in front of it, and then
  // no address is forwarded at all. The API falls back to the socket address —
  // this process — so all public traffic shares one bucket. Restrictive, and
  // deliberately the safer failure: throttled real visitors get noticed and
  // fixed, an absent limiter gets noticed on the invoice.
  const caller = resolveClientAddress(request.headers, clientAddressConfig());
  // Set, never appended to: the value the API sees must be exactly the one
  // resolved here, with nothing the caller supplied left in front of it.
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
