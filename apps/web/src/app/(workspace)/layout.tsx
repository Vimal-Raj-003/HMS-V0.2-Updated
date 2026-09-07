import { redirect } from 'next/navigation';
import { fetchSession } from '@/lib/server-api';
import { readAccessToken } from '@/lib/session';
import { WorkspaceChrome } from './workspace-chrome';

/**
 * Every authenticated screen sits inside this layout.
 *
 * The session is fetched server-side, so the first paint already has the right
 * navigation — no flash of a menu the user cannot use, and no round trip before
 * the shell is usable. The cookie check is a redirect, not a security control:
 * the API's guard chain decides what the session may actually do.
 */
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const token = await readAccessToken();
  if (token === null) redirect('/login');

  const session = await fetchSession();
  // A cookie that the API rejects means the session ended between the two calls.
  if (session === null) redirect('/login');

  return (
    <WorkspaceChrome
      session={{
        userId: session.user.id,
        displayName: session.user.displayName,
        hospitalId: session.hospitalId,
        branchId: session.branchId,
        roles: session.roles,
        permissions: session.permissions,
        enabledModules: session.enabledModules,
      }}
    >
      {children}
    </WorkspaceChrome>
  );
}
