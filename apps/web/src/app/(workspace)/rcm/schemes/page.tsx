import type { Metadata } from 'next';
import { RcmGate } from '@/features/rcm/components/rcm-gate';
import { SchemesScreen } from '@/features/rcm/components/schemes-screen';

export const metadata: Metadata = { title: "Government schemes · Vim's HMS" };

/** No parameters — `docs/06` §6.5. A scheme case resolves to a patient. */
export default function Page(): React.JSX.Element {
  return (
    <RcmGate screenKey="rcm-schemes">
      <SchemesScreen />
    </RcmGate>
  );
}
