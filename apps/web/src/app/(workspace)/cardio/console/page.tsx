import type { Metadata } from 'next';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';
import { CardiologyScreen } from '@/features/specialty/consoles/components/cardiology-screen';

export const metadata: Metadata = { title: "Cardiology · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="cardiology">
      <CardiologyScreen />
    </SpecialtyGate>
  );
}
