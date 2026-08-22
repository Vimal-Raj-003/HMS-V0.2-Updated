import type { Metadata } from 'next';
import { CashCounterScreen } from '@/features/frontoffice/components/cash-counter-screen';
import { FrontOfficeGate } from '@/features/frontoffice/components/frontoffice-gate';

export const metadata: Metadata = { title: "Cash counter · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <FrontOfficeGate screenKey="cash">
      <CashCounterScreen />
    </FrontOfficeGate>
  );
}
