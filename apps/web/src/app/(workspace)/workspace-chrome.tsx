'use client';

import { RoleNav } from '@vims/ui';
import { usePathname, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { PHASE0_NAV } from '@/lib/nav';
import { Providers } from '@/lib/providers';
import { SessionProvider, type WorkspaceSession } from '@/lib/session-context';
import { CommandPalette } from './command-palette';

interface WorkspaceChromeProps {
  readonly session: WorkspaceSession;
  readonly children: React.ReactNode;
}

/**
 * The application chrome: header, permission-driven navigation, work area.
 *
 * The nav is filtered by `RoleNav` against the session's real permission set,
 * which is why two roles signing in on the same machine see genuinely different
 * menus rather than the same menu with things disabled.
 *
 * The session is put into context here rather than threaded through props: every
 * admin screen needs the permission set to decide what to draw, and the tenant id
 * to scope its query cache. A screen that has to be handed both eventually gets
 * shipped without one of them.
 */
export function WorkspaceChrome({ session, children }: WorkspaceChromeProps): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const [signingOut, setSigningOut] = useState(false);
  const granted = useMemo(() => new Set(session.permissions), [session.permissions]);
  // A module the hospital has not licensed leaves no door behind: not a menu
  // item, not a palette entry, not a greyed-out row somebody asks about.
  const licensed = useMemo(() => new Set(session.enabledModules), [session.enabledModules]);

  // `RoleNav` highlights by item key, so the active key is derived from the
  // route rather than stored — a stored one goes stale on back/forward.
  const activeKey =
    PHASE0_NAV.flatMap((item) => [item, ...(item.children ?? [])]).find(
      (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
    )?.key ?? 'dashboard';

  async function signOut(): Promise<void> {
    setSigningOut(true);
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    router.replace('/login');
    router.refresh();
  }

  return (
    <SessionProvider session={session}>
      <Providers>
        <div className="min-h-dvh">
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:rounded focus:bg-layer-1 focus:px-3 focus:py-2"
          >
            Skip to content
          </a>

          <header className="flex h-14 items-center justify-between border-b border-control px-4">
            <span className="font-semibold tracking-tight">Vim&rsquo;s HMS</span>
            <div className="flex items-center gap-3">
              <CommandPalette />
              <span data-testid="session-user" className="text-sm text-fg-subtle">
                {session.displayName}
              </span>
              <span data-testid="session-roles" className="sr-only">
                {session.roles.join(',')}
              </span>
              <button
                type="button"
                onClick={() => void signOut()}
                disabled={signingOut}
                className="h-9 rounded-md border border-control px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          </header>

          <div className="flex">
            <div data-testid="role-nav" className="hidden w-56 shrink-0 border-e border-control p-3 md:block">
              <RoleNav
                items={PHASE0_NAV}
                grantedPermissions={granted}
                licensedModules={licensed}
                activeKey={activeKey}
                label="Main"
              />
            </div>
            <main id="main" className="min-w-0 flex-1 p-6">
              {children}
            </main>
          </div>
        </div>
      </Providers>
    </SessionProvider>
  );
}
