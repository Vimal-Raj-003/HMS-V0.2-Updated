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
export function middleware(request: NextRequest): NextResponse {
  const hasSession = request.cookies.has(ACCESS_COOKIE);
  const { pathname } = request.nextUrl;

  if (!hasSession && !pathname.startsWith('/login')) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    // Bring the user back to what they were reaching for after they sign in.
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  if (hasSession && pathname.startsWith('/login')) {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|manifest.webmanifest|icons).*)'],
};
