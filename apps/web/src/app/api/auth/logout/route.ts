import { NextResponse } from 'next/server';
import { ACCESS_COOKIE, REFRESH_COOKIE, WORKSPACE_COOKIE } from '@/lib/session';

export function POST(): NextResponse {
  const response = NextResponse.json({ ok: true });
  // Expire rather than merely forget: a cookie left in the jar keeps being sent.
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, WORKSPACE_COOKIE]) {
    response.cookies.set(name, '', { path: '/', maxAge: 0 });
  }
  return response;
}
