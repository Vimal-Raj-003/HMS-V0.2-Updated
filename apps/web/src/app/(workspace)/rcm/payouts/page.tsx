import type { Metadata } from 'next';
import { PayoutsScreen } from '@/features/rcm/components/payouts-screen';
import { RcmGate } from '@/features/rcm/components/rcm-gate';

export const metadata: Metadata = { title: "Doctor payouts · Vim's HMS" };

/** No parameters — `docs/06` §6.5. A statement resolves to a doctor and a period. */
export default function Page(): React.JSX.Element {
  return (
    <RcmGate screenKey="rcm-payouts">
      <PayoutsScreen />
    </RcmGate>
  );
}
