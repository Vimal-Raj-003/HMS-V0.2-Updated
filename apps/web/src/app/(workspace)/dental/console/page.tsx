import type { Metadata } from 'next';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';
import { DentalScreen } from '@/features/specialty/consoles/components/dental-screen';

export const metadata: Metadata = { title: "Dentistry · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="dental">
      <DentalScreen />
    </SpecialtyGate>
  );
}
