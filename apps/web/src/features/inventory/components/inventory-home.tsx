'use client';

import { Button, EmptyState } from '@vims/ui';
import Link from 'next/link';
import { PageHeader } from '@/features/admin/components/page-header';
import { useSession } from '@/lib/session-context';
import { INVENTORY_AREA_LABELS, INVENTORY_SCREENS, type InventoryScreen } from '../screens';

/**
 * The stores and purchase hub. Only the tiles this session can open, and a
 * reason when that is none — `docs/06` §4.1 and §5.2 #36.
 */
const AREA_ORDER: readonly InventoryScreen['area'][] = ['stores', 'movements', 'purchase'];

export function InventoryHome(): React.JSX.Element {
  const { granted } = useSession();
  const available = INVENTORY_SCREENS.filter((screen) => granted.has(screen.permission));

  return (
    <section className="flex flex-col gap-4" data-testid="inventory-home">
      <PageHeader
        eyebrow="Phase 4 · stores & supply chain"
        title="Stores & purchase"
        description="Every unit received, issued, transferred, adjusted or written off, traceable to a batch, a person, a cost centre and a document."
      />

      {available.length === 0 ? (
        <EmptyState
          cause="None of the stores or purchase screens are open to your roles."
          nextAction="The item master, stock, indents, transfers, adjustments, purchase orders, goods receipt, the match queue and the vendor master each carry their own permission. Ask your hospital administrator which one you need."
        />
      ) : (
        AREA_ORDER.map((area) => {
          const inArea = available.filter((screen) => screen.area === area);
          if (inArea.length === 0) return null;
          return (
            <section key={area} className="flex flex-col gap-2" data-testid={`area-${area}`}>
              <h2 className="font-display text-2xs uppercase tracking-[0.08em] text-fg-subtle">
                {INVENTORY_AREA_LABELS[area]}
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
