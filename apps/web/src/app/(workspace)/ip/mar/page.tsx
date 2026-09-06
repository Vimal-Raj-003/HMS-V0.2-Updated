import type { Metadata } from 'next';
import { IpGate } from '@/features/inpatient/components/ip-gate';
import { MarRoundScreen } from '@/features/inpatient/components/mar-round-screen';

export const metadata: Metadata = { title: "Drug round · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <IpGate screenKey="mar-round">
      <MarRoundScreen />
    </IpGate>
  );
}
