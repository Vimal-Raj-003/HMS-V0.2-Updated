import type { Metadata } from 'next';
import { OrthoGate } from '@/features/ortho/components/ortho-gate';
import { PlasterRoomScreen } from '@/features/ortho/components/plaster-room-screen';

export const metadata: Metadata = { title: "Plaster room · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <OrthoGate screenKey="plaster-room">
      <PlasterRoomScreen />
    </OrthoGate>
  );
}
