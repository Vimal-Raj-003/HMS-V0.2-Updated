import type { Metadata } from 'next';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';
import { ChemoDaycareScreen } from '@/features/specialty/oncology/components/chemo-daycare-screen';

export const metadata: Metadata = { title: "Chemotherapy day care · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="chemo-daycare">
      <ChemoDaycareScreen />
    </SpecialtyGate>
  );
}
