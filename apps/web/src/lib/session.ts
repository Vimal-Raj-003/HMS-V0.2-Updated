import { cookies } from 'next/headers';

/**
 * Session cookies.
 *
 * The access and refresh tokens are **httpOnly**, so no script in the page can
 * read them. `docs/04` treats an XSS bug as survivable only if it cannot lift the
 * session: a token in `localStorage` turns any injected script into a full
 * account takeover, and a hospital renders a lot of third-party-authored content
 * (report templates, letterheads, uploaded documents).
 *
 * `sameSite: 'strict'` because every clinical action is state-changing and none
 * of them should ever be triggered by a cross-site navigation.
 */
export const ACCESS_COOKIE = 'vims_at';
export const REFRESH_COOKIE = 'vims_rt';
export const WORKSPACE_COOKIE = 'vims_ws';

export interface SessionCookieOptions {
  readonly accessTtlSeconds: number;
  readonly refreshTtlSeconds: number;
  readonly secure: boolean;
}

export async function readAccessToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(ACCESS_COOKIE)?.value ?? null;
}

export async function readWorkspace(): Promise<string | null> {
  const store = await cookies();
  return store.get(WORKSPACE_COOKIE)?.value ?? null;
}
