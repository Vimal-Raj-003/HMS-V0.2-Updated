import type { Metadata } from 'next';
import { ErBoardScreen } from '@/features/emergency/components/er-board-screen';
import { ErGate } from '@/features/emergency/components/er-gate';

export const metadata: Metadata = { title: "ER board · Vim's HMS" };

/** No parameters — `docs/06` §6.5. A visit resolves to a patient, or to a tag. */
export default function Page(): React.JSX.Element {
  return (
    <ErGate screenKey="er-board">
      <ErBoardScreen />
    </ErGate>
  );
}
