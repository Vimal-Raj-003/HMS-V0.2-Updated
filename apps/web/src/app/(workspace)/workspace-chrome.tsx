'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The application chrome: header, role navigation, main work area.
 *
 * `docs/06` §4.1 is explicit that the left nav is generated from permissions and
 * that an item the user cannot use is never rendered. That matters more than it
 * sounds: a greyed-out "Approve refund" teaches staff to hunt for a workaround,
 * and in a hospital the workaround is usually somebody else's password.
 *
 * The nav below is a Phase-0 placeholder driven by a static list; it becomes the
 * permission-driven `RoleNav` from `@vims/ui` once the API exposes the session's
 * resolved permission set.
 */
export function WorkspaceChrome({ children }: { children: React.ReactNode }): React.JSX.Element {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut(): Promise<void> {
    setSigningOut(true);
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    router.replace('/login');
    router.refresh();
  }

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>

      <header className="flex h-14 items-center justify-between border-b border-control px-4">
        <div className="flex items-center gap-3">
          <span className="font-semibold tracking-tight">Vim&rsquo;s HMS</span>
        </div>
        <button
          type="button"
          onClick={() => void signOut()}
          disabled={signingOut}
          className="h-9 rounded-md border border-control px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </header>

      <div className="flex">
        <nav aria-label="Main" className="hidden w-56 shrink-0 border-e border-control p-3 md:block">
          <ul className="space-y-1 text-sm">
            <li>
              <a
                href="/dashboard"
                className="block rounded-md px-3 py-2 hover:bg-sunken focus-visible:outline focus-visible:outline-2"
              >
                Dashboard
              </a>
            </li>
          </ul>
        </nav>
        <main id="main" className="min-w-0 flex-1 p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
