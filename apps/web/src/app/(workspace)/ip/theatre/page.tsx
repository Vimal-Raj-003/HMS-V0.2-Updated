import type { Metadata } from 'next';
import { TheatreBoardScreen } from '@/features/inpatient/components/theatre-board-screen';
import { IpGate } from '@/features/inpatient/components/ip-gate';

export const metadata: Metadata = { title: "Theatre board · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <IpGate screenKey="theatre-board">
      <TheatreBoardScreen />
    </IpGate>
  );
}
