'use client';

import type { ReactNode } from 'react';
import { ModuleNotLicensed, PermissionDenied } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { frontOfficeScreen } from '../screens';

/**
 * The screen-level permission gate.
 *
 * The same courtesy the admin console offers, for the same reason: navigation
 * already hides what a session cannot open, but a link gets pasted into a
 * handover note, bookmarked, or sent on WhatsApp to the colleague covering the
 * shift. The screen answers by explaining (`docs/06` §6.7) rather than by
 * rendering a broken page.
 *
 * It is **not** a security control. The API re-resolves permissions from the
 * database on every request, so a role revoked at 09:00 stops working at 09:00
 * whatever this component drew. Removing this makes the console rude; removing
 * the API's guard makes it insecure.
 */
export function FrontOfficeGate({
  screenKey,
  children,
}: {
  readonly screenKey: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  const screen = frontOfficeScreen(screenKey);
  const { granted, licensed } = useSession();

  if (!granted.has(screen.permission)) {
    return <PermissionDenied permission={screen.permission} inPlainWords={screen.deniedExplanation} />;
  }
  // Reached only by typing a URL — the navigation and the palette do not offer
  // a screen in a module this hospital has not licensed. The words are
  // commercial rather than "ask your administrator for access", because that
  // errand would go nowhere.
  if (screen.entitlement !== null && !licensed.has(screen.entitlement)) {
    return <ModuleNotLicensed entitlement={screen.entitlement} />;
  }
  return <>{children}</>;
}

/**
 * An action the session cannot perform, explained rather than hidden.
 *
 * `docs/06` §4.1 says never to render an item a user cannot use, and §6.7 says a
 * denial must explain itself. Those pull in opposite directions for a control
 * that is *expected* to be there — the refund button on a cash counter, the
 * variance approval on a shift — because its absence reads as a bug and sends
 * the cashier to borrow a supervisor's password. So the control is not rendered
 * and this is rendered in its place: the same footprint, no clickable affordance,
 * and the exact key to quote in an access request.
 */
export function ActionUnavailable({
  title,
  because,
  permission,
}: {
  readonly title: string;
  readonly because: string;
  readonly permission?: string;
}): React.JSX.Element {
  return (
    <div
      role="note"
      data-testid="action-unavailable"
      className="rounded-lg border border-dashed border-strong bg-layer-1 p-3"
    >
      <p className="text-sm font-medium text-fg-default">{title}</p>
      <p className="mt-1 text-sm text-fg-muted">{because}</p>
      {permission === undefined ? null : (
        <p className="mt-2 font-mono text-2xs text-fg-subtle">
          Held by another role, under <span data-testid="required-permission">{permission}</span>.
        </p>
      )}
    </div>
  );
}
