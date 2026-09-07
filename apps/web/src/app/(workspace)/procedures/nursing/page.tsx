import type { Metadata } from 'next';
import { NursingRoomsScreen } from '@/features/procedures/components/nursing-rooms-screen';
import { ProcedureGate } from '@/features/procedures/components/procedure-gate';

export const metadata: Metadata = { title: "Nursing rooms · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <ProcedureGate screenKey="nursing-rooms">
      <NursingRoomsScreen />
    </ProcedureGate>
  );
}
