'use client';

import type { ReactNode } from 'react';
import { ModuleNotLicensed, PermissionDenied } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { inventoryScreen } from '../screens';

/**
 * The screen-level permission gate — see the note in
 * `features/pharmacy/components/pharmacy-gate.tsx`. It is a courtesy, not a
 * control: the API's policy guard is the control, and it re-reads the session's
 * grants from the database on every request.
 */
export function InventoryGate({
  screenKey,
  children,
}: {
  readonly screenKey: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  const screen = inventoryScreen(screenKey);
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
