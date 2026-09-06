import type { Metadata } from 'next';
import { Suspense } from 'react';
import { CastRecordScreen } from '@/features/ortho/components/cast-record-screen';
import { OrthoGate } from '@/features/ortho/components/ortho-gate';

export const metadata: Metadata = { title: "Cast record · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <OrthoGate screenKey="cast-record">
      <Suspense fallback={null}>
        <CastRecordScreen />
      </Suspense>
    </OrthoGate>
  );
}
