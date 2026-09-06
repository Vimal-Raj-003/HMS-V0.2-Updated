import type { Metadata } from 'next';
import { ConsoleRegistryScreen } from '@/features/specialty/components/console-registry-screen';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';

export const metadata: Metadata = { title: "Specialty consoles · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="console-registry">
      <ConsoleRegistryScreen />
    </SpecialtyGate>
  );
}
