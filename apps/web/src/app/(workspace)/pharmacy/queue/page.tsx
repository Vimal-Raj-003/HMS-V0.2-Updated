import type { Metadata } from 'next';
import { PharmacyGate } from '@/features/pharmacy/components/pharmacy-gate';
import { RxQueueScreen } from '@/features/pharmacy/components/rx-queue-screen';

export const metadata: Metadata = { title: "Prescription queue · Vim's HMS" };

/**
 * The route takes **no parameters**. Every identifier this screen works with
 * lives in component state or in a request body, so `docs/06` §6.5 — "no PHI in
 * the URL" — holds by construction rather than by review: there is nothing in
 * the address bar for a proxy log, a browser history or a shoulder to read.
 */
export default function Page(): React.JSX.Element {
  return (
    <PharmacyGate screenKey="pharmacy-queue">
      <RxQueueScreen />
    </PharmacyGate>
  );
}
