import type { Metadata } from 'next';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';
import { LabourBoardScreen } from '@/features/specialty/labour/components/labour-board-screen';

export const metadata: Metadata = { title: "Labour room · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="labour-board">
      <LabourBoardScreen />
    </SpecialtyGate>
  );
}
