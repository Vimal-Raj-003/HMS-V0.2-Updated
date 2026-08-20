'use client';

import { Badge, EmptyState } from '@vims/ui';
import Link from 'next/link';
import { ArrowRight, ShieldQuestion } from '@/lib/icons';
import { ADMIN_SCREENS } from '../screens';
import { useSession } from '@/lib/session-context';
import { PageHeader } from './page-header';

/**
 * The admin console home (EN-007 §8).
 *
 * Deliberately a directory rather than a dashboard of counters. Phase 0 has no
 * read model behind an "active users" or "MFA coverage" tile, and a tile showing
 * a number computed by a live count on every page load is the exact pattern
 * `docs/07` forbids. The tiles arrive with the summary tables that feed them.
 */
export function ConsoleHome(): React.JSX.Element {
  const { granted, roles } = useSession();
  const screens = ADMIN_SCREENS.filter((screen) => granted.has(screen.permission));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="EN-007"
        title="Administration"
        description="The control plane of this hospital: who exists, what they may do, how the system is configured, and a record of every change to all three."
        meta={<Badge tone="neutral">signed in as {roles.length === 0 ? 'no role' : roles.join(', ')}</Badge>}
      />

      {screens.length === 0 ? (
        <EmptyState
          icon={<ShieldQuestion />}
          cause="None of the administration screens is open to your roles."
          nextAction="If you need one, ask your hospital administrator to raise an access request naming the screen."
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="console-tiles">
          {screens.map((screen) => (
            <li key={screen.key}>
              <Link
                href={screen.href}
                className="flex h-full flex-col gap-1 rounded-lg border border-default bg-layer-1 p-4 hover:bg-layer-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <span className="flex items-center justify-between gap-2 text-md font-medium text-fg-default">
                  {screen.label}
                  <ArrowRight className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
                </span>
                <span className="text-sm text-fg-muted">{screen.summary}</span>
                <span className="mt-auto pt-2 font-mono text-3xs text-fg-subtle">{screen.permission}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
