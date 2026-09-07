import type { Metadata } from 'next';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';
import { TherapyScreen } from '@/features/specialty/therapy/components/therapy-screen';

export const metadata: Metadata = { title: "Therapy · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="therapy">
      <TherapyScreen />
    </SpecialtyGate>
  );
}
