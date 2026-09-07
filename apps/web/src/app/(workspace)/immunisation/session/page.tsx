import type { Metadata } from 'next';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';
import { ImmunisationScreen } from '@/features/specialty/programme/components/immunisation-screen';

export const metadata: Metadata = { title: "Immunisation · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="immunisation">
      <ImmunisationScreen />
    </SpecialtyGate>
  );
}
