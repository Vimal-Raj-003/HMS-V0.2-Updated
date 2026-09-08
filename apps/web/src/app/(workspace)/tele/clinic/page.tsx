import type { Metadata } from 'next';
import { TeleClinic } from '@/features/specialty/handoffs/components/tele-clinic';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';

export const metadata: Metadata = { title: "Tele-clinic · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="tele-clinic">
      <TeleClinic />
    </SpecialtyGate>
  );
}
