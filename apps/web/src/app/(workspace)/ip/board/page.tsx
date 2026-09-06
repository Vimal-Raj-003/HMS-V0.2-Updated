import type { Metadata } from 'next';
import { BedBoardScreen } from '@/features/inpatient/components/bed-board-screen';
import { IpGate } from '@/features/inpatient/components/ip-gate';

export const metadata: Metadata = { title: "Bed board · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <IpGate screenKey="bed-board">
      <BedBoardScreen />
    </IpGate>
  );
}
