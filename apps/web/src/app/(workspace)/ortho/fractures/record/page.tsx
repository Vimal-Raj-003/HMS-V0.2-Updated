import type { Metadata } from 'next';
import { Suspense } from 'react';
import { FractureRecordScreen } from '@/features/ortho/components/fracture-record-screen';
import { OrthoGate } from '@/features/ortho/components/ortho-gate';

export const metadata: Metadata = { title: "Fracture record · Vim's HMS" };

/** Named by `?id=`, so no clinical identifier lands in a proxy log. */
export default function Page(): React.JSX.Element {
  return (
    <OrthoGate screenKey="fracture-record">
      <Suspense fallback={null}>
        <FractureRecordScreen />
      </Suspense>
    </OrthoGate>
  );
}
