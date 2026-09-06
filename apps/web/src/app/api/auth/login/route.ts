import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ACCESS_COOKIE, REFRESH_COOKIE, WORKSPACE_COOKIE, cookiesMaySkipSecure } from '@/lib/session';
import { API_ORIGIN } from '@/lib/api-origin';

/**
 * Login proxy.
 *
 * The browser never talks to `services/api` directly for authentication, and it
 * never sees a token. It posts here; this route calls the API server-side and
 * puts the tokens into httpOnly cookies. That is what keeps the session out of
 * reach of any script running in the page.
 *
 * It also means the API's origin need not be exposed to the internet at all in
 * an on-prem deployment — the browser only ever needs the web origin.
 */
const bodySchema = z.object({
  hospitalId: z.string().uuid(),
  identifier: z.string().min(1),
  password: z.string().min(1),
});

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  user: { id: string; displayName: string; mustChangePassword: boolean };
  roles: string[];
  homeWorkspace: string | null;
  branches: string[];
}

export async function POST(request: Request): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        type: 'https://errors.vimshms.com/validation-failed',
        title: 'Some details need correcting',
        status: 400,
        reference: 'client',
        errors: parsed.error.issues.map((i) => ({ path: i.path.join('/'), message: i.message })),
      },
      { status: 400, headers: { 'content-type': 'application/problem+json' } },
    );
  }

  const upstream = await fetch(`${API_ORIGIN}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(parsed.data),
    cache: 'no-store',
  });

  if (!upstream.ok) {
    // The API's problem+json is passed through unchanged: it already carries the
    // detail, next action and the trace reference the user reads to the helpdesk.
    const problem: unknown = await upstream.json().catch(() => ({
      type: 'about:blank',
      title: 'Sign-in unavailable',
      status: upstream.status,
      reference: upstream.headers.get('x-trace-id') ?? 'unknown',
    }));
    return NextResponse.json(problem, {
      status: upstream.status,
      headers: { 'content-type': 'application/problem+json' },
    });
  }

  const result = (await upstream.json()) as LoginResponse;
  const secure = !cookiesMaySkipSecure(request);
  const response = NextResponse.json({
    user: result.user,
    roles: result.roles,
    homeWorkspace: result.homeWorkspace,
    branches: result.branches,
  });

  const base = { httpOnly: true, sameSite: 'strict', secure, path: '/' } as const;
  response.cookies.set(ACCESS_COOKIE, result.accessToken, { ...base, maxAge: result.expiresInSeconds });
  response.cookies.set(REFRESH_COOKIE, result.refreshToken, { ...base, maxAge: 60 * 60 * 24 * 30 });
  // Not httpOnly: the shell needs to render the right nav before its first fetch,
  // and a workspace key is not a credential.
  response.cookies.set(WORKSPACE_COOKIE, result.homeWorkspace ?? 'dashboard', {
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: result.expiresInSeconds,
  });

  return response;
}
