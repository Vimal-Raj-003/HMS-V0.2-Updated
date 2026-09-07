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
  /**
   * The `module.*` keys this hospital's licence allows.
   *
   * A permission answers "may this person"; an entitlement answers "did this
   * hospital buy it". Both have to be true before a menu item is worth drawing,
   * and until Phase 8 only the first was actually checked — every screen
   * catalogue declared an `entitlement` that nothing read.
   */
  readonly enabledModules: readonly string[];
}

interface SessionContextValue extends WorkspaceSession {
  readonly granted: ReadonlySet<string>;
  readonly licensed: ReadonlySet<string>;
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
    () => ({
      ...session,
      granted: new Set(session.permissions),
      licensed: new Set(session.enabledModules),
    }),
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

/**
 * Whether the hospital's licence allows a module.
 *
 * `null` means the screen is not gated on a module at all — the queue console,
 * for instance, is part of the platform and has no separate licence — so it is
 * always allowed.
 *
 * Like `useCan`, this is not a security control: the API's licence guard is.
 * It decides what is worth drawing.
 */
export function useEntitled(entitlement: string | null): boolean {
  const { licensed } = useSession();
  return entitlement === null || licensed.has(entitlement);
}
