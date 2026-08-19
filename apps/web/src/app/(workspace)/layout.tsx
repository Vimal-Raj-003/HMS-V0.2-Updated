import { redirect } from 'next/navigation';
import { readAccessToken } from '@/lib/session';
import { WorkspaceChrome } from './workspace-chrome';

/**
 * Every authenticated screen sits inside this layout.
 *
 * The token check here is a redirect, not a security control — the API decides
 * what the session may actually do. Its job is to avoid rendering a workspace
 * shell that will immediately 401 on its first fetch, which reads to a user as a
 * broken application rather than as a finished session.
 */
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const token = await readAccessToken();
  if (token === null) redirect('/login');
  return <WorkspaceChrome>{children}</WorkspaceChrome>;
}
