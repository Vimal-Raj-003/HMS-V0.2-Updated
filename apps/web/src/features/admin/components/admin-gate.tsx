'use client';

import type { ReactNode } from 'react';
import { useSession } from '@/lib/session-context';
import { adminScreen } from '../screens';
import { PermissionDenied } from './problem-card';

/**
 * The screen-level permission gate.
 *
 * The navigation already hides what a session cannot open, but a link can be
 * pasted, bookmarked or sent in a handover note, so the screen itself has to
 * answer for the case. It answers by explaining — `docs/06` §6.7 — rather than
 * by rendering a broken page or redirecting somewhere confusing.
 *
 * This is a *courtesy*, not a control. The API refuses the request regardless,
 * from a permission set it re-resolves from the database on every call. Removing
 * this gate would make the console rude; removing the API's guard would make it
 * insecure.
 */
export function AdminGate({
  screenKey,
  children,
}: {
  readonly screenKey: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  const screen = adminScreen(screenKey);
  const { granted } = useSession();

  if (!granted.has(screen.permission)) {
    return <PermissionDenied permission={screen.permission} inPlainWords={screen.deniedExplanation} />;
  }
  return <>{children}</>;
}
