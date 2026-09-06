import type { Metadata } from 'next';
import { CostCentresScreen } from '@/features/inventory/components/cost-centres-screen';
import { InventoryGate } from '@/features/inventory/components/inventory-gate';

export const metadata: Metadata = { title: "Cost centres · Vim's HMS" };

/** No parameters — `docs/06` §6.5, the same rule as the rest of Phase 4. */
export default function Page(): React.JSX.Element {
  return (
    <InventoryGate screenKey="inventory-cost-centres">
      <CostCentresScreen />
    </InventoryGate>
  );
}
