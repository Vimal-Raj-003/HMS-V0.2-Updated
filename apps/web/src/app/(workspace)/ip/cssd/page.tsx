import type { Metadata } from 'next';
import { CssdScreen } from '@/features/inpatient/components/cssd-screen';
import { IpGate } from '@/features/inpatient/components/ip-gate';

export const metadata: Metadata = { title: "Sterile supply · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <IpGate screenKey="cssd">
      <CssdScreen />
    </IpGate>
  );
}
