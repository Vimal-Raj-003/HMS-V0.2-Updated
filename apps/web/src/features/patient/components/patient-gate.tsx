'use client';

import type { ReactNode } from 'react';
import { useSession } from '@/lib/session-context';
import { PermissionDenied } from '@/features/admin/components/problem-card';

/**
 * The screen-level permission gate for the front office.
 *
 * Identical in intent to `features/admin`'s `AdminGate`, and reusing that
 * feature's `PermissionDenied` rather than cloning it: the component is generic
 * — it renders a missing permission key and a plain-words explanation — and two
 * copies would drift into two different denial experiences, which is exactly the
 * inconsistency `docs/06` §6.7 is written to prevent.
 *
 * This is a *courtesy*, not a control. The API refuses the request regardless,
 * from a permission set it re-resolves from the database on every call. Removing
 * this gate would make the workspace rude; removing the API's guard would make it
 * insecure.
 */
export function PatientGate({
  permission,
  deniedExplanation,
  children,
}: {
  readonly permission: string;
  readonly deniedExplanation: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  const { granted } = useSession();
  if (!granted.has(permission)) {
    return <PermissionDenied permission={permission} inPlainWords={deniedExplanation} />;
  }
  return <>{children}</>;
}
