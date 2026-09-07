import type { Metadata } from 'next';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';
import { SwallowScreen } from '@/features/specialty/therapy/components/swallow-screen';

export const metadata: Metadata = { title: "Swallow orders · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="swallow-orders">
      <SwallowScreen />
    </SpecialtyGate>
  );
}
