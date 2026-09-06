import type { Metadata } from 'next';
import { RcmGate } from '@/features/rcm/components/rcm-gate';
import { TariffScreen } from '@/features/rcm/components/tariff-screen';

export const metadata: Metadata = { title: "Tariff · Vim's HMS" };

/** No parameters — `docs/06` §6.5. Nothing here belongs in an address bar. */
export default function Page(): React.JSX.Element {
  return (
    <RcmGate screenKey="rcm-tariff">
      <TariffScreen />
    </RcmGate>
  );
}
