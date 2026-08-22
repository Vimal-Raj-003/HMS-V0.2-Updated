import type { Metadata } from 'next';
import { Patient360 } from '@/features/patient/components/patient-360';
import { PatientGate } from '@/features/patient/components/patient-gate';
import { PATIENT_RECORD_SCREEN } from '@/features/patient/screens';

export const metadata: Metadata = { title: "Patient record · Vim's HMS" };

/**
 * `/patients/{id}` — Patient 360.
 *
 * The id is the **only** thing in the URL. It is an opaque UUID, not a UHID and
 * not a name, so the address bar, browser history and every proxy log between the
 * browser and the API stay free of PHI (`docs/06` §6.5, `docs/04` §4). The page
 * title is generic for the same reason: a tab title is visible from across a
 * counter and is captured by screen-sharing software.
 */
export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  return (
    <PatientGate
      permission={PATIENT_RECORD_SCREEN.permission}
      deniedExplanation={PATIENT_RECORD_SCREEN.deniedExplanation}
    >
      <Patient360 patientId={id} />
    </PatientGate>
  );
}
