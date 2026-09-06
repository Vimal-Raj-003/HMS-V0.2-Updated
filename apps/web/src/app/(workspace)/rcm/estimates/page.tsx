import type { Metadata } from 'next';
import { EstimatesScreen } from '@/features/rcm/components/estimates-screen';
import { RcmGate } from '@/features/rcm/components/rcm-gate';

export const metadata: Metadata = { title: "Cost estimates · Vim's HMS" };

/** No parameters — `docs/06` §6.5. An estimate id resolves to a patient or an enquirer. */
export default function Page(): React.JSX.Element {
  return (
    <RcmGate screenKey="rcm-estimates">
      <EstimatesScreen />
    </RcmGate>
  );
}
