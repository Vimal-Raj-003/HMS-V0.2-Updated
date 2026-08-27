'use client';

import { Button, EmptyState } from '@vims/ui';
import Link from 'next/link';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { PHARMACY_AREA_LABELS, PHARMACY_SCREENS, type PharmacyScreen } from '../screens';

/**
 * The pharmacy hub.
 *
 * It renders only the tiles this session can actually open — `docs/06` §4.1,
 * "never render an item the user cannot use" — and, when that is none, says so
 * with the specific reason rather than showing an empty page a user reads as
 * broken.
 *
 * The eight screens are held by different hands on purpose: a counter
 * pharmacist, a pharmacy in-charge, a returns approver, a drug inspector's
 * escort and a cashier. Almost no session sees all eight, and that is the design
 * — the register is behind step-up authentication, and approving a return is
 * never the same key as raising one.
 */
const AREA_ORDER: readonly PharmacyScreen['area'][] = ['counter', 'stock', 'registers'];

export function PharmacyHome(): React.JSX.Element {
  const { granted } = useSession();
  const available = PHARMACY_SCREENS.filter((screen) => granted.has(screen.permission));

  return (
    <section className="flex flex-col gap-4" data-testid="pharmacy-home">
      <PageHeader
        eyebrow="Phase 4 · pharmacy"
        title="Pharmacy"
        description="From the prescription queue to the bag in the patient's hand, and everything the law asks you to write down along the way."
      />

      {available.length === 0 ? (
        <EmptyState
          cause="None of the pharmacy screens are open to your roles."
          nextAction="Dispensing, selling over the counter, approving a return, reading the controlled-drug register and closing the day each carry their own permission. Ask your hospital administrator which one you need."
        />
      ) : (
        AREA_ORDER.map((area) => {
          const inArea = available.filter((screen) => screen.area === area);
          if (inArea.length === 0) return null;
          return (
            <section key={area} className="flex flex-col gap-2" data-testid={`area-${area}`}>
              <h2 className="font-display text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {PHARMACY_AREA_LABELS[area]}
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {inArea.map((screen) => (
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
            </section>
          );
        })
      )}
    </section>
  );
}
