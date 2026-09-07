import { cookies } from 'next/headers';
import { ACCESS_COOKIE } from './session';
import { API_ORIGIN } from './api-origin';

/**
 * Server-side call to `services/api` on behalf of the signed-in user.
 *
 * The access token is read from the httpOnly cookie here, in the server
 * component, and forwarded as a bearer token. The browser never holds it, so an
 * XSS bug in any page — including one rendering an uploaded document or a
 * hospital-authored report template — cannot lift the session.
 */
export async function serverFetch<T>(path: string): Promise<T | null> {
  const store = await cookies();
  const token = store.get(ACCESS_COOKIE)?.value;
  if (token === undefined) return null;

  const response = await fetch(`${API_ORIGIN}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    // A workspace must never render another user's cached session.
    cache: 'no-store',
  });

  if (!response.ok) return null;
  return (await response.json()) as T;
}

export interface SessionSummary {
  readonly user: { readonly id: string; readonly displayName: string };
  readonly hospitalId: string;
  readonly branchId: string | null;
  readonly branches: readonly string[];
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly homeWorkspace: string | null;
  /** The `module.*` keys this hospital's licence allows. */
  readonly enabledModules: readonly string[];
}

export async function fetchSession(): Promise<SessionSummary | null> {
  return serverFetch<SessionSummary>('/api/v1/me');
}
