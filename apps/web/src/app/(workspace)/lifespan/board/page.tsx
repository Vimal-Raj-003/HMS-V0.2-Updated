import type { Metadata } from 'next';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';
import { LifespanScreen } from '@/features/specialty/lifespan/components/lifespan-screen';

export const metadata: Metadata = { title: "Paediatrics and geriatrics · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="lifespan-board">
      <LifespanScreen />
    </SpecialtyGate>
  );
}
