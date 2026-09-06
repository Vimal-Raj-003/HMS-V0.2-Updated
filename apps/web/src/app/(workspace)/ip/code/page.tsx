import type { Metadata } from 'next';
import { CodeBlueScreen } from '@/features/inpatient/components/code-blue-screen';
import { IpGate } from '@/features/inpatient/components/ip-gate';

export const metadata: Metadata = { title: "Code blue · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <IpGate screenKey="code-blue">
      <CodeBlueScreen />
    </IpGate>
  );
}
