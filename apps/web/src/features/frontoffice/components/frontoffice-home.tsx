'use client';

import { Button, EmptyState } from '@vims/ui';
import Link from 'next/link';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { FRONT_OFFICE_SCREENS } from '../screens';

/**
 * The front-office hub.
 *
 * It renders only the tiles this session can actually open — `docs/06` §4.1,
 * "never render an item the user cannot use" — and, when that is none, says so
 * with the specific reason rather than showing an empty page a user reads as
 * broken.
 */
export function FrontOfficeHome(): React.JSX.Element {
  const { granted } = useSession();
  const available = FRONT_OFFICE_SCREENS.filter((screen) => granted.has(screen.permission));

  return (
    <section className="flex flex-col gap-4" data-testid="frontoffice-home">
      <PageHeader
        eyebrow="Front office"
        title="Front office"
        description="The appointment book, the queue console and the cash counter — the three screens a desk lives in all day."
      />

      {available.length === 0 ? (
        <EmptyState
          cause="None of the front-office screens are open to your roles."
          nextAction="Reception, counter and cashier work each carry their own permission. Ask your hospital administrator which one you need."
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {available.map((screen) => (
            <li
              key={screen.key}
              className="flex flex-col gap-2 rounded-lg border border-strong bg-layer-1 p-4"
            >
              <p className="text-md font-medium text-fg-default">{screen.label}</p>
              <p className="flex-1 text-sm text-fg-muted">{screen.summary}</p>
              <Button asChild variant="secondary" size="sm" className="self-start">
                <Link href={screen.href}>Open {screen.label.toLowerCase()}</Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
