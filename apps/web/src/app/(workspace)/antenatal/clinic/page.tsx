import type { Metadata } from 'next';
import { AntenatalScreen } from '@/features/specialty/antenatal/components/antenatal-screen';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';

export const metadata: Metadata = { title: "Antenatal clinic · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="antenatal-clinic">
      <AntenatalScreen />
    </SpecialtyGate>
  );
}
