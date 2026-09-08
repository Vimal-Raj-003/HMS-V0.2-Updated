import type { Metadata } from 'next';
import { AyushBoard } from '@/features/specialty/ayush/components/ayush-board';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';

export const metadata: Metadata = { title: "AYUSH · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="ayush-board">
      <AyushBoard />
    </SpecialtyGate>
  );
}
