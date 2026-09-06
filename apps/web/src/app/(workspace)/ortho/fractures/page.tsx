import type { Metadata } from 'next';
import { FractureRegistryScreen } from '@/features/ortho/components/fracture-registry-screen';
import { OrthoGate } from '@/features/ortho/components/ortho-gate';

export const metadata: Metadata = { title: "Fracture registry · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <OrthoGate screenKey="fracture-registry">
      <FractureRegistryScreen />
    </OrthoGate>
  );
}
