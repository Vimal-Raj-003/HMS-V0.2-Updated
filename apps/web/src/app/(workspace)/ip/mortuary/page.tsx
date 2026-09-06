import type { Metadata } from 'next';
import { IpGate } from '@/features/inpatient/components/ip-gate';
import { MortuaryScreen } from '@/features/inpatient/components/mortuary-screen';

export const metadata: Metadata = { title: "Mortuary · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <IpGate screenKey="mortuary">
      <MortuaryScreen />
    </IpGate>
  );
}
