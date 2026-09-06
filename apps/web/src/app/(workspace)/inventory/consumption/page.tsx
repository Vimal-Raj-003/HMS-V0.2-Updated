import type { Metadata } from 'next';
import { ConsumptionScreen } from '@/features/inventory/components/consumption-screen';
import { InventoryGate } from '@/features/inventory/components/inventory-gate';

export const metadata: Metadata = { title: "Consumption & cost centres · Vim's HMS" };

/**
 * No parameters, for the reason in the consignment route: a consumption entry
 * can name the patient it was charged to, and `docs/06` §6.5 keeps that out of
 * the address bar.
 */
export default function Page(): React.JSX.Element {
  return (
    <InventoryGate screenKey="inventory-consumption">
      <ConsumptionScreen />
    </InventoryGate>
  );
}
