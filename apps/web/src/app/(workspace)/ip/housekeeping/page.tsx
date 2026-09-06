import type { Metadata } from 'next';
import { HousekeepingScreen } from '@/features/inpatient/components/housekeeping-screen';
import { IpGate } from '@/features/inpatient/components/ip-gate';

export const metadata: Metadata = { title: "Bed turnover · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <IpGate screenKey="housekeeping">
      <HousekeepingScreen />
    </IpGate>
  );
}
