import type { Metadata } from 'next';
import { PackagesScreen } from '@/features/rcm/components/packages-screen';
import { RcmGate } from '@/features/rcm/components/rcm-gate';

export const metadata: Metadata = { title: "Packages · Vim's HMS" };

/** No parameters — `docs/06` §6.5. */
export default function Page(): React.JSX.Element {
  return (
    <RcmGate screenKey="rcm-packages">
      <PackagesScreen />
    </RcmGate>
  );
}
