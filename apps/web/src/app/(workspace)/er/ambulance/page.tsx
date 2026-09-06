import type { Metadata } from 'next';
import { DispatchBoardScreen } from '@/features/emergency/components/dispatch-board-screen';
import { ErGate } from '@/features/emergency/components/er-gate';

export const metadata: Metadata = { title: "Ambulance dispatch · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <ErGate screenKey="ambulance-dispatch">
      <DispatchBoardScreen />
    </ErGate>
  );
}
