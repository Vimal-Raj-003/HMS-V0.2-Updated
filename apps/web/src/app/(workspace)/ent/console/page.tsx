import type { Metadata } from 'next';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';
import { AudiologyScreen } from '@/features/specialty/consoles/components/audiology-screen';

export const metadata: Metadata = { title: "ENT & audiology · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="audiology">
      <AudiologyScreen />
    </SpecialtyGate>
  );
}
