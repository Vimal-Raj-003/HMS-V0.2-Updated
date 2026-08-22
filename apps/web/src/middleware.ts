import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE } from '@/lib/session';

/**
 * Routes an unauthenticated visitor to `/login` and an authenticated one away
 * from it.
 *
 * This is **navigation**, not authorisation. The middleware only sees whether a
 * cookie is present; it does not and must not verify it. Every actual decision is
 * made by the API's guard chain against a verified token (`docs/01` §3 steps 2,
 * 3 and 6). Treating a cookie's presence as proof of anything here would put the
 * security boundary in the browser's reach.
 */
/**
 * Paths that must work without a session.
 *
 * `/offline` is the important one and the easy one to miss: it is shown when
 * there is no network, and a redirect to `/login` in that state produces a
 * browser error page instead — the exact failure the offline shell exists to
 * prevent. You cannot sign in while offline, so requiring a session to see the
 * offline page is circular.
 *
 * `/` is the landing page: the front door has to open for someone who has never
 * signed in, which is the entire population it is written for. Note that `/` is
 * matched exactly -- `startsWith('//')` is never true -- so adding it here opens
 * the root and nothing beneath it.
 */
const PUBLIC_PATHS = ['/', '/login', '/offline'];

export function middleware(request: NextRequest): NextResponse {
  const hasSession = request.cookies.has(ACCESS_COOKIE);
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    // A signed-in user has no use for the sign-in screen or the front door;
    // send them to the work they came back for. `/offline` is deliberately not
    // in this list -- it must render whether or not there is a session.
    if (hasSession && (pathname === '/' || pathname.startsWith('/login'))) {
      const url = request.nextUrl.clone();
      url.pathname = '/dashboard';
      url.search = '';
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  if (!hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    // Bring the user back to what they were reaching for after they sign in.
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Everything excluded here is served as a static asset and must never be
  // redirected. The service-worker scripts are the subtle ones: a browser
  // refuses to register a worker whose script was reached via a redirect
  // ("The script resource is behind a redirect, which is disallowed"), so a
  // middleware that bounced /sw.js to /login silently disabled the entire PWA —
  // the file was served with a 200 and HTML in it, and nothing else complained.
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|manifest.webmanifest|icons|sw.js|sw.js.map|swe-worker-.*|workbox-.*).*)',
  ],
};
