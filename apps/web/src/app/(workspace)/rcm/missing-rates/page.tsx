import type { Metadata } from 'next';
import { MissingRatesScreen } from '@/features/rcm/components/missing-rates-screen';
import { RcmGate } from '@/features/rcm/components/rcm-gate';

export const metadata: Metadata = { title: "Missing rates · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <RcmGate screenKey="rcm-missing-rates">
      <MissingRatesScreen />
    </RcmGate>
  );
}
