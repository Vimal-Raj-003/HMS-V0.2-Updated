import type { Metadata } from 'next';
import { ErGate } from '@/features/emergency/components/er-gate';
import { MlcRegisterScreen } from '@/features/emergency/components/mlc-register-screen';

export const metadata: Metadata = { title: "Medico-legal register · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <ErGate screenKey="mlc-register">
      <MlcRegisterScreen />
    </ErGate>
  );
}
