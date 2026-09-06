import type { Metadata } from 'next';
import { LeakageScreen } from '@/features/rcm/components/leakage-screen';
import { RcmGate } from '@/features/rcm/components/rcm-gate';

export const metadata: Metadata = { title: "Revenue leakage · Vim's HMS" };

/** No parameters — `docs/06` §6.5. A finding resolves to an encounter. */
export default function Page(): React.JSX.Element {
  return (
    <RcmGate screenKey="rcm-leakage">
      <LeakageScreen />
    </RcmGate>
  );
}
