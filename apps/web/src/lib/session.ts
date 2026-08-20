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

/**
 * Whether the session cookies for this request may carry the `Secure` attribute.
 *
 * `Secure` is a property of the **transport**, not of the build mode. Deriving it
 * from `NODE_ENV` conflates the two, and the two come apart in exactly one place
 * that matters: a production build served over plain HTTP on loopback — which is
 * what `next start` does in the browser suite, in a local production smoke test,
 * and in an on-prem box being brought up before its certificate exists.
 *
 * Marking a cookie `Secure` on a plain-HTTP connection is not merely redundant,
 * it is wrong, and a browser is entitled to discard it. Chromium happens not to,
 * because it treats loopback as a potentially-trustworthy origin for this purpose;
 * WebKit (Safari, iPadOS) does not, and drops the `Set-Cookie` outright. That is
 * the whole of open question O-10: the cookie was never stored, so the middleware
 * correctly saw no session and sent the user back to `/login`.
 *
 * The rule below therefore withholds `Secure` only when the connection is plain
 * HTTP **to a loopback host**, which can never be a real deployment. Every other
 * shape — including a production build reached over plain HTTP on a routable
 * hostname — still gets `Secure`, so a deployment that has lost its TLS
 * termination fails loudly (the browser refuses the cookie and nobody can sign
 * in) rather than quietly serving sessions in clear text.
 *
 * A forged `Host: localhost` on a production request cannot be used against
 * anyone else: it would yield a cookie scoped to `localhost` in the attacker's
 * own browser, weakening only their own session.
 */
export function cookiesMaySkipSecure(request: Request): boolean {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  const host = url.hostname;
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '::1' ||
    host.endsWith('.localhost')
  );
}
