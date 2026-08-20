'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

/**
 * The signed-in session, as the client half of the workspace sees it.
 *
 * It exists so that `docs/06` §4.1 — "never render an item the user cannot use"
 * — can be honoured by any component, not only by the navigation. A screen that
 * has to thread a permission set down through five props eventually stops doing
 * it, and the control that leaks through is always the dangerous one.
 *
 * `hospitalId` is here for a second reason: every TanStack Query cache key is
 * prefixed with it (`CLAUDE.md` §2). Two hospitals reached from the same browser
 * — which a group administrator does daily — must never share a cached list.
 */
export interface WorkspaceSession {
  readonly userId: string;
  readonly displayName: string;
  readonly hospitalId: string;
  readonly branchId: string | null;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

interface SessionContextValue extends WorkspaceSession {
  readonly granted: ReadonlySet<string>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({
  session,
  children,
}: {
  readonly session: WorkspaceSession;
  readonly children: ReactNode;
}): React.JSX.Element {
  const value = useMemo<SessionContextValue>(
    () => ({ ...session, granted: new Set(session.permissions) }),
    [session],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside <SessionProvider>.');
  return value;
}

/**
 * Whether the session holds a permission key.
 *
 * Deliberately *not* a security control — the API's policy guard is, and it
 * re-resolves permissions from the database on every request so a role revoked
 * at 09:00 stops working at 09:00. This only decides what is worth drawing.
 */
export function useCan(permission: string): boolean {
  return useSession().granted.has(permission);
}
