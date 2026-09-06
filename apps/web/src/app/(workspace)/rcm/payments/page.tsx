import type { Metadata } from 'next';
import { PaymentsScreen } from '@/features/rcm/components/payments-screen';
import { RcmGate } from '@/features/rcm/components/rcm-gate';

export const metadata: Metadata = { title: "Payments · Vim's HMS" };

/** No parameters — `docs/06` §6.5. */
export default function Page(): React.JSX.Element {
  return (
    <RcmGate screenKey="rcm-payments">
      <PaymentsScreen />
    </RcmGate>
  );
}
