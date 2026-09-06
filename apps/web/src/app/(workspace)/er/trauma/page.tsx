import type { Metadata } from 'next';
import { ErGate } from '@/features/emergency/components/er-gate';
import { TraumaBoardScreen } from '@/features/emergency/components/trauma-board-screen';

export const metadata: Metadata = { title: "Trauma board · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <ErGate screenKey="trauma-board">
      <TraumaBoardScreen />
    </ErGate>
  );
}
