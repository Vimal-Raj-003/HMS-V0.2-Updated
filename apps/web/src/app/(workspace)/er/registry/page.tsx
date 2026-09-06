import type { Metadata } from 'next';
import { ErGate } from '@/features/emergency/components/er-gate';
import { TraumaRegistryScreen } from '@/features/emergency/components/trauma-registry-screen';

export const metadata: Metadata = { title: "Trauma registry · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <ErGate screenKey="trauma-registry">
      <TraumaRegistryScreen />
    </ErGate>
  );
}
