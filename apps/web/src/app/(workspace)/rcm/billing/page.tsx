import type { Metadata } from 'next';
import { BillingScreen } from '@/features/rcm/components/billing-screen';
import { RcmGate } from '@/features/rcm/components/rcm-gate';

export const metadata: Metadata = { title: "Billing · Vim's HMS" };

/**
 * No parameters. `docs/06` §6.5 keeps PHI out of the address bar, and a bill id
 * resolves to a patient and an amount — both of which a proxy log should never
 * see.
 */
export default function Page(): React.JSX.Element {
  return (
    <RcmGate screenKey="rcm-billing">
      <BillingScreen />
    </RcmGate>
  );
}
