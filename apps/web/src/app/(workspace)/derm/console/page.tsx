import type { Metadata } from 'next';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';
import { DermatologyScreen } from '@/features/specialty/consoles/components/dermatology-screen';

export const metadata: Metadata = { title: "Dermatology · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="dermatology">
      <DermatologyScreen />
    </SpecialtyGate>
  );
}
