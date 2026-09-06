import type { Metadata } from 'next';
import { ErGate } from '@/features/emergency/components/er-gate';
import { TriageDeskScreen } from '@/features/emergency/components/triage-desk-screen';

export const metadata: Metadata = { title: "Triage · Vim's HMS" };

/** No parameters: the patient is chosen from the board, which is the live list. */
export default function Page(): React.JSX.Element {
  return (
    <ErGate screenKey="triage-desk">
      <TriageDeskScreen />
    </ErGate>
  );
}
