import type { Metadata } from 'next';
import { DialysisBoardScreen } from '@/features/specialty/dialysis/components/dialysis-board-screen';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';

export const metadata: Metadata = { title: "Dialysis unit · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="dialysis-board">
      <DialysisBoardScreen />
    </SpecialtyGate>
  );
}
