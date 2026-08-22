import type { Metadata } from 'next';
import { ClinicalGate } from '@/features/clinical/components/clinical-gate';
import { PrescriptionScreen } from '@/features/clinical/components/prescription-screen';

export const metadata: Metadata = { title: "Prescription · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <ClinicalGate screenKey="prescribe">
      <PrescriptionScreen />
    </ClinicalGate>
  );
}
