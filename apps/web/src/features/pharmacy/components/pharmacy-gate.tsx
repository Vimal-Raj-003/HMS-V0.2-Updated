'use client';

import type { ReactNode } from 'react';
import { PermissionDenied } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { pharmacyScreen } from '../screens';

/**
 * The screen-level permission gate.
 *
 * The same courtesy the admin, front-office, clinical and diagnostics consoles
 * offer, for the same reason: navigation already hides what a session cannot
 * open, but a link gets pasted into a handover note, bookmarked, or sent to the
 * pharmacist covering the night shift. The screen answers by explaining
 * (`docs/06` §6.7) rather than by rendering a broken page.
 *
 * It is **not** a security control. The API re-resolves permissions from the
 * database on every request, so a role revoked at 09:00 stops working at 09:00
 * whatever this component drew. Removing this makes the console rude; removing
 * the API's guard makes it unsafe.
 */
export function PharmacyGate({
  screenKey,
  children,
}: {
  readonly screenKey: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  const screen = pharmacyScreen(screenKey);
  const { granted } = useSession();

  if (!granted.has(screen.permission)) {
    return <PermissionDenied permission={screen.permission} inPlainWords={screen.deniedExplanation} />;
  }
  return <>{children}</>;
}
