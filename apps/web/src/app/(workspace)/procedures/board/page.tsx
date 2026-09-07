import type { Metadata } from 'next';
import { ProcedureBoardScreen } from '@/features/procedures/components/procedure-board-screen';
import { ProcedureGate } from '@/features/procedures/components/procedure-gate';

export const metadata: Metadata = { title: "Procedure board · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <ProcedureGate screenKey="procedure-board">
      <ProcedureBoardScreen />
    </ProcedureGate>
  );
}
