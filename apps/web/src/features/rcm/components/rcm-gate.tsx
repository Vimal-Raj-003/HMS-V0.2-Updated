'use client';

import type { ReactNode } from 'react';
import { PermissionDenied } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { rcmScreen } from '../screens';

/**
 * The screen-level permission gate — a courtesy, not a control. The API's policy
 * guard is the control, and it re-reads the session's grants from the database
 * on every request.
 */
export function RcmGate({
  screenKey,
  children,
}: {
  readonly screenKey: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  const screen = rcmScreen(screenKey);
  const { granted } = useSession();

  if (!granted.has(screen.permission)) {
    return <PermissionDenied permission={screen.permission} inPlainWords={screen.deniedExplanation} />;
  }
  return <>{children}</>;
}
