import type { Metadata } from 'next';
import { ErGate } from '@/features/emergency/components/er-gate';
import { PolytraumaBoardScreen } from '@/features/emergency/components/polytrauma-board-screen';

export const metadata: Metadata = { title: "Polytrauma boards · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <ErGate screenKey="polytrauma-boards">
      <PolytraumaBoardScreen />
    </ErGate>
  );
}
