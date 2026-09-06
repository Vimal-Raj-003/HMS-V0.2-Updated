import type { Metadata } from 'next';
import { DischargeScreen } from '@/features/inpatient/components/discharge-screen';
import { IpGate } from '@/features/inpatient/components/ip-gate';

export const metadata: Metadata = { title: "Discharges · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <IpGate screenKey="discharges">
      <DischargeScreen />
    </IpGate>
  );
}
