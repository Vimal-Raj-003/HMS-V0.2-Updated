import type { Metadata } from 'next';
import { PreauthScreen } from '@/features/rcm/components/preauth-screen';
import { RcmGate } from '@/features/rcm/components/rcm-gate';

export const metadata: Metadata = { title: "Pre-authorisation · Vim's HMS" };

/** No parameters — `docs/06` §6.5. A pre-auth id resolves to a patient. */
export default function Page(): React.JSX.Element {
  return (
    <RcmGate screenKey="rcm-preauth">
      <PreauthScreen />
    </RcmGate>
  );
}
