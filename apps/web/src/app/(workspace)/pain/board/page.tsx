import type { Metadata } from 'next';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';
import { PainScreen } from '@/features/specialty/pain/components/pain-screen';

export const metadata: Metadata = { title: "Pain management · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="pain-clinic">
      <PainScreen />
    </SpecialtyGate>
  );
}
