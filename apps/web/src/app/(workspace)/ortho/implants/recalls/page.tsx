import type { Metadata } from 'next';
import { ImplantRecallScreen } from '@/features/ortho/components/implant-recall-screen';
import { OrthoGate } from '@/features/ortho/components/ortho-gate';

export const metadata: Metadata = { title: "Implant recalls · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <OrthoGate screenKey="implant-recalls">
      <ImplantRecallScreen />
    </OrthoGate>
  );
}
