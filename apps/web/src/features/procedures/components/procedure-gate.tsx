'use client';

import type { ReactNode } from 'react';
import { ModuleNotLicensed, PermissionDenied } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { procedureScreen } from '../screens';

/**
 * The screen-level gate — a courtesy, not a control. The API's policy and
 * licence guards are the controls, and they re-resolve on every request.
 */
export function ProcedureGate({
  screenKey,
  children,
}: {
  readonly screenKey: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  const screen = procedureScreen(screenKey);
  const { granted, licensed } = useSession();

  if (!granted.has(screen.permission)) {
    return <PermissionDenied permission={screen.permission} inPlainWords={screen.deniedExplanation} />;
  }
  if (screen.entitlement !== null && !licensed.has(screen.entitlement)) {
    return <ModuleNotLicensed entitlement={screen.entitlement} />;
  }
  return <>{children}</>;
}
