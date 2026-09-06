import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ErGate } from '@/features/emergency/components/er-gate';
import { PrehospitalTripScreen } from '@/features/emergency/components/prehospital-trip-screen';

export const metadata: Metadata = { title: "Pre-hospital record · Vim's HMS" };

/** The trip is named by `?id=`, so no clinical identifier lands in a proxy log. */
export default function Page(): React.JSX.Element {
  return (
    <ErGate screenKey="prehospital-trip">
      <Suspense fallback={null}>
        <PrehospitalTripScreen />
      </Suspense>
    </ErGate>
  );
}
