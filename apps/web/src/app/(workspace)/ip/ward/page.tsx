import type { Metadata } from 'next';
import { IpGate } from '@/features/inpatient/components/ip-gate';
import { NursingStationScreen } from '@/features/inpatient/components/nursing-station-screen';

export const metadata: Metadata = { title: "Nursing station · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <IpGate screenKey="nursing-station">
      <NursingStationScreen />
    </IpGate>
  );
}
