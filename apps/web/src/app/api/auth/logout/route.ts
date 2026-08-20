import { NextResponse } from 'next/server';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  WORKSPACE_COOKIE,
  cookiesMaySkipSecure,
} from '@/lib/session';

export function POST(request: Request): NextResponse {
  const response = NextResponse.json({ ok: true });
  const secure = !cookiesMaySkipSecure(request);
  // Expire rather than merely forget: a cookie left in the jar keeps being sent.
  // The attributes must match the ones the login route wrote — a browser will
  // refuse to let a non-`Secure` `Set-Cookie` displace a `Secure` one, so an
  // expiry that drops the attribute can silently fail to end the session.
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, WORKSPACE_COOKIE]) {
    response.cookies.set(name, '', { path: '/', maxAge: 0, sameSite: 'strict', secure });
  }
  return response;
}
