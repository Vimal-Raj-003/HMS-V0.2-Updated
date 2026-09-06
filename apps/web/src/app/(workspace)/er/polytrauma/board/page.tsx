import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ErGate } from '@/features/emergency/components/er-gate';
import { PolytraumaCaseScreen } from '@/features/emergency/components/polytrauma-case-screen';

export const metadata: Metadata = { title: "Polytrauma board · Vim's HMS" };

/** Named by `?id=`, so no clinical identifier lands in a proxy log. */
export default function Page(): React.JSX.Element {
  return (
    <ErGate screenKey="polytrauma-case">
      <Suspense fallback={null}>
        <PolytraumaCaseScreen />
      </Suspense>
    </ErGate>
  );
}
