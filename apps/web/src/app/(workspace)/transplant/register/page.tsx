import type { Metadata } from 'next';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';
import { TransplantScreen } from '@/features/specialty/transplant/components/transplant-screen';

export const metadata: Metadata = { title: "Transplant and fertility · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="transplant-register">
      <TransplantScreen />
    </SpecialtyGate>
  );
}
