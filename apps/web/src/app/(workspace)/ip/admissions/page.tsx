import type { Metadata } from 'next';
import { AdmissionsScreen } from '@/features/inpatient/components/admissions-screen';
import { IpGate } from '@/features/inpatient/components/ip-gate';

export const metadata: Metadata = { title: "Admissions · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <IpGate screenKey="admissions">
      <AdmissionsScreen />
    </IpGate>
  );
}
