import type { Metadata } from 'next';
import { PathwayBoard } from '@/features/specialty/handoffs/components/pathway-board';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';

export const metadata: Metadata = { title: "Clinical pathways · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="pathway-board">
      <PathwayBoard />
    </SpecialtyGate>
  );
}
