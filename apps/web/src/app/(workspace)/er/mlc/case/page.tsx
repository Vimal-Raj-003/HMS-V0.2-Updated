import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ErGate } from '@/features/emergency/components/er-gate';
import { MlcCaseScreen } from '@/features/emergency/components/mlc-case-screen';

export const metadata: Metadata = { title: "Medico-legal case · Vim's HMS" };

/**
 * The case is named by `?id=`, not by a path segment.
 *
 * `docs/06` §6.5 keeps clinical identifiers out of the route so an MLC number
 * never lands in a proxy log or a browser history entry that somebody else
 * reads over a shoulder. `useSearchParams` needs a Suspense boundary.
 */
export default function Page(): React.JSX.Element {
  return (
    <ErGate screenKey="mlc-case">
      <Suspense fallback={null}>
        <MlcCaseScreen />
      </Suspense>
    </ErGate>
  );
}
