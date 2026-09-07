import type { Metadata } from 'next';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';
import { WoundScreen } from '@/features/specialty/therapy/components/wound-screen';

export const metadata: Metadata = { title: "Wound care · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="wound-care">
      <WoundScreen />
    </SpecialtyGate>
  );
}
