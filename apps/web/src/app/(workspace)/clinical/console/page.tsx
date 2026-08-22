import type { Metadata } from 'next';
import { ClinicalGate } from '@/features/clinical/components/clinical-gate';
import { DoctorConsoleScreen } from '@/features/clinical/components/doctor-console-screen';

/**
 * `/clinical/console` — the consultation.
 *
 * The title is generic and the URL carries no identifier at all: the encounter
 * is chosen inside the screen. A tab title is visible from across a counter and
 * is captured by screen-sharing software, and an address bar is copied into
 * chat — `docs/06` §6.5, `docs/04` §4.
 */
export const metadata: Metadata = { title: "Consultation · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <ClinicalGate screenKey="console">
      <DoctorConsoleScreen />
    </ClinicalGate>
  );
}
