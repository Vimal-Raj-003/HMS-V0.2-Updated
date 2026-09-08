import type { Metadata } from 'next';
import { TrayLine } from '@/features/nonclinical/dietary/components/tray-line';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';

export const metadata: Metadata = { title: "Tray line · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="dietary-tray-line">
      <TrayLine />
    </SpecialtyGate>
  );
}
