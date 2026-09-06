import type { Metadata } from 'next';
import { BloodBankScreen } from '@/features/inpatient/components/blood-bank-screen';
import { IpGate } from '@/features/inpatient/components/ip-gate';

export const metadata: Metadata = { title: "Blood bank · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <IpGate screenKey="blood-bank">
      <BloodBankScreen />
    </IpGate>
  );
}
