import type { Metadata } from 'next';
import { ClinicalGate } from '@/features/clinical/components/clinical-gate';
import { VitalsRoomScreen } from '@/features/clinical/components/vitals-room-screen';

export const metadata: Metadata = { title: "Vitals room · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <ClinicalGate screenKey="vitals">
      <VitalsRoomScreen />
    </ClinicalGate>
  );
}
