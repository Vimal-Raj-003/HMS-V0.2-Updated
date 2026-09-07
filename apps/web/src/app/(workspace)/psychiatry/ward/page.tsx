import type { Metadata } from 'next';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';
import { PsychiatryWardScreen } from '@/features/specialty/psychiatry/components/psychiatry-ward-screen';

export const metadata: Metadata = { title: "Mental health ward · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="psychiatry-ward">
      <PsychiatryWardScreen />
    </SpecialtyGate>
  );
}
