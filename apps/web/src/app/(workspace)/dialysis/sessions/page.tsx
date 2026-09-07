import type { Metadata } from 'next';
import { DialysisSessionScreen } from '@/features/specialty/dialysis/components/dialysis-session-screen';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';

export const metadata: Metadata = { title: "Dialysis sessions · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="dialysis-sessions">
      <DialysisSessionScreen />
    </SpecialtyGate>
  );
}
