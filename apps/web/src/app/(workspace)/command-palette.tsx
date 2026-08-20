'use client';

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Kbd,
} from '@vims/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ADMIN_SCREENS } from '@/features/admin/screens';
import { useSession } from '@/lib/session-context';

/**
 * The ⌘K palette (`docs/06` §6.1, §6.5).
 *
 * It lists only what the session can actually open. A palette is a navigation
 * surface, so §4.1's rule — never render an item the user cannot use — applies to
 * it exactly as it does to the left nav; a palette that offers every screen and
 * lets the API refuse teaches staff that the product is broken.
 *
 * The shortcut is suppressed while the user is typing into a field, because
 * `⌘K` inside a search box in a browser is the browser's, and stealing it from
 * a half-typed patient name is worse than not having the palette.
 */
export function CommandPalette(): React.JSX.Element {
  const router = useRouter();
  const { granted } = useSession();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setOpen((current) => !current);
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
    };
  }, []);

  const screens = ADMIN_SCREENS.filter((screen) => granted.has(screen.permission));

  return (
    <>
      <button
        type="button"
        data-testid="open-command-palette"
        onClick={() => {
          setOpen(true);
        }}
        className="hidden h-9 items-center gap-2 rounded-md border border-control px-3 text-sm text-fg-muted hover:bg-layer-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:flex"
      >
        Search
        <span className="flex items-center gap-0.5">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Command palette"
        description="Jump to a screen. Only the screens your roles allow are listed."
        closeLabel="Close the command palette"
      >
        <CommandInput placeholder="Type a screen or what you want to do…" />
        <CommandList>
          <CommandEmpty>Nothing matches. Screens you cannot open are not listed here at all.</CommandEmpty>
          <CommandGroup heading="Go to">
            <CommandItem
              value="dashboard home workspace"
              onSelect={() => {
                setOpen(false);
                router.push('/dashboard');
              }}
            >
              <span className="flex min-w-0 flex-col">
                <span>Dashboard</span>
                <span className="truncate text-xs text-fg-muted">Your role&rsquo;s home workspace.</span>
              </span>
            </CommandItem>
            {screens.length === 0 ? null : (
              <CommandItem
                value="administration admin console control plane"
                onSelect={() => {
                  setOpen(false);
                  router.push('/admin');
                }}
              >
                <span className="flex min-w-0 flex-col">
                  <span>Administration</span>
                  <span className="truncate text-xs text-fg-muted">
                    The console home: every admin screen your roles can open.
                  </span>
                </span>
              </CommandItem>
            )}
            {screens.map((screen) => (
              <CommandItem
                key={screen.key}
                value={`${screen.label} ${screen.keywords.join(' ')}`}
                onSelect={() => {
                  setOpen(false);
                  router.push(screen.href);
                }}
              >
                <span className="flex min-w-0 flex-col">
                  <span>{screen.label}</span>
                  <span className="truncate text-xs text-fg-muted">{screen.summary}</span>
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
