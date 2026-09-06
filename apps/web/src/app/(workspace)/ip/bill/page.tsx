import type { Metadata } from 'next';
import { Suspense } from 'react';
import { IpBillScreen } from '@/features/inpatient/components/ip-bill-screen';
import { IpGate } from '@/features/inpatient/components/ip-gate';

export const metadata: Metadata = { title: "Inpatient bill · Vim's HMS" };

/** Named by `?id=`, so no clinical identifier lands in a proxy log. */
export default function Page(): React.JSX.Element {
  return (
    <IpGate screenKey="ip-bill">
      <Suspense fallback={null}>
        <IpBillScreen />
      </Suspense>
    </IpGate>
  );
}
