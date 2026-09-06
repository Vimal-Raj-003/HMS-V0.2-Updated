import type { Metadata } from 'next';
import { ConsignmentScreen } from '@/features/inventory/components/consignment-screen';
import { InventoryGate } from '@/features/inventory/components/inventory-gate';

export const metadata: Metadata = { title: "Consignment · Vim's HMS" };

/**
 * The route takes **no parameters** — the same rule as the rest of Phase 4
 * (`docs/06` §6.5, no PHI in the URL). It matters more here than on most store
 * screens: a consignment usage carries the patient the implant went into, so a
 * usage id in the address bar would put a clinical fact in a proxy log. The id
 * lives in component state and in a request body.
 */
export default function Page(): React.JSX.Element {
  return (
    <InventoryGate screenKey="inventory-consignment">
      <ConsignmentScreen />
    </InventoryGate>
  );
}
