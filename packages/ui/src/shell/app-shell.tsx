'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';

/**
 * `AppShell` — docs/06 §4.1.
 *
 *   TOP BAR 56 px · LEFT NAV 240 px (56 px rail) · PATIENT BANNER (sticky) ·
 *   WORK AREA (min 640 px) · RIGHT CONTEXT RAIL 320 px (collapsible) · STATUS STRIP 28 px
 *
 * Responsive rules from §4.3: 3-pane at `xl`, 2-pane at `md` with the rail as a
 * slide-over, single pane plus bottom nav at `xs`.
 *
 * Keyboard (§6.1): `[` toggles the left nav, `]` toggles the context rail. Both are
 * ignored while the user is typing, and both are also exposed as props so the same
 * state can be driven from the command palette.
 */
export interface AppShellProps {
  readonly topBar: ReactNode;
  readonly nav: ReactNode;
  /** Sticky patient banner; omitted on non-patient screens. */
  readonly banner?: ReactNode;
  readonly children: ReactNode;
  readonly contextRail?: ReactNode;
  /** §4.1 status strip: socket, offline queue, print agent, shift, build version. */
  readonly statusStrip?: ReactNode;
  /** §5.2 #33 — bottom-docked shortcut strip. */
  readonly keyboardHints?: ReactNode;
  /** §4.3 `xs` — bottom nav, max 5 items. */
  readonly bottomNav?: ReactNode;
  readonly navCollapsed?: boolean;
  readonly onNavCollapsedChange?: (collapsed: boolean) => void;
  readonly railOpen?: boolean;
  readonly onRailOpenChange?: (open: boolean) => void;
  /** Landmark names, from the caller's i18n catalogue. */
  readonly labels: {
    readonly application: string;
    readonly workArea: string;
    readonly contextRail: string;
    readonly statusStrip: string;
  };
  readonly className?: string;
}

function useToggleShortcut(key: string, onToggle: (() => void) | undefined): void {
  useEffect(() => {
    if (onToggle === undefined) return undefined;
    const handler = (event: KeyboardEvent): void => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if (event.key === key && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        onToggle();
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
    };
  }, [key, onToggle]);
}

export function AppShell({
  topBar,
  nav,
  banner,
  children,
  contextRail,
  statusStrip,
  keyboardHints,
  bottomNav,
  navCollapsed,
  onNavCollapsedChange,
  railOpen,
  onRailOpenChange,
  labels,
  className,
}: AppShellProps): React.JSX.Element {
  const [internalNavCollapsed, setInternalNavCollapsed] = useState(false);
  const [internalRailOpen, setInternalRailOpen] = useState(true);

  const navIsCollapsed = navCollapsed ?? internalNavCollapsed;
  const railIsOpen = railOpen ?? internalRailOpen;

  useToggleShortcut('[', () => {
    const next = !navIsCollapsed;
    setInternalNavCollapsed(next);
    onNavCollapsedChange?.(next);
  });
  useToggleShortcut(']', () => {
    const next = !railIsOpen;
    setInternalRailOpen(next);
    onRailOpenChange?.(next);
  });

  return (
    <div
      data-slot="app-shell"
      data-nav-collapsed={navIsCollapsed ? 'true' : 'false'}
      data-rail-open={railIsOpen ? 'true' : 'false'}
      aria-label={labels.application}
      className={cn('flex h-dvh w-full flex-col bg-canvas text-fg-default', className)}
    >
      <header
        data-slot="app-shell-topbar"
        className="flex h-14 shrink-0 items-center gap-3 border-b border-default bg-layer-1 px-3 z-appbar"
      >
        {topBar}
      </header>

      <div className="flex min-h-0 flex-1">
        {/* §4.3 — the left nav becomes the bottom nav below `md`. */}
        <div className="hidden md:flex">{nav}</div>

        <div className="flex min-w-0 flex-1 flex-col">
          {banner}
          <main
            data-slot="app-shell-work-area"
            aria-label={labels.workArea}
            tabIndex={-1}
            className="min-h-0 flex-1 overflow-auto p-3 xl:min-w-160"
          >
            {children}
          </main>
        </div>

        {contextRail === undefined ? null : (
          <aside
            data-slot="app-shell-context-rail"
            aria-label={labels.contextRail}
            hidden={!railIsOpen}
            className={cn(
              'w-80 shrink-0 overflow-y-auto border-s border-default bg-layer-1 p-3',
              // §4.3 — below `xl` the rail overlays rather than pushes.
              'max-xl:absolute max-xl:inset-inline-end-0 max-xl:top-14 max-xl:bottom-7 max-xl:z-rail-overlay max-xl:shadow-e3',
              'max-md:hidden',
            )}
          >
            {contextRail}
          </aside>
        )}
      </div>

      {keyboardHints}

      {bottomNav === undefined ? null : (
        <div data-slot="app-shell-bottom-nav" className="md:hidden">
          {bottomNav}
        </div>
      )}

      {statusStrip === undefined ? null : (
        <footer
          data-slot="app-shell-status-strip"
          aria-label={labels.statusStrip}
          className="flex h-7 shrink-0 items-center gap-3 border-t border-default bg-layer-1 px-3 text-2xs text-fg-muted"
        >
          {statusStrip}
        </footer>
      )}
    </div>
  );
}
