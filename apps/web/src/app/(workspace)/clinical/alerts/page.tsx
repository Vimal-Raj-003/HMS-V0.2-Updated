import type { Metadata } from 'next';
import { AlertFatigueScreen } from '@/features/clinical/components/alert-fatigue-screen';
import { ClinicalGate } from '@/features/clinical/components/clinical-gate';

export const metadata: Metadata = { title: "Alert fatigue · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <ClinicalGate screenKey="alerts">
      <AlertFatigueScreen />
    </ClinicalGate>
  );
}
