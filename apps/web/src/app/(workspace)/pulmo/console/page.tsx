import type { Metadata } from 'next';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';
import { PulmonologyScreen } from '@/features/specialty/consoles/components/pulmonology-screen';

export const metadata: Metadata = { title: "Pulmonology & sleep · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="pulmonology">
      <PulmonologyScreen />
    </SpecialtyGate>
  );
}
