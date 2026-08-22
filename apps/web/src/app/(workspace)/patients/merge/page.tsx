import type { Metadata } from 'next';
import { MergeTool } from '@/features/patient/components/merge-tool';
import { PatientGate } from '@/features/patient/components/patient-gate';
import { patientScreen } from '@/features/patient/screens';

export const metadata: Metadata = { title: "Duplicate & merge · Vim's HMS" };

/**
 * `/patients/merge`.
 *
 * A static segment declared alongside `[id]`. Next resolves a literal segment
 * before a dynamic one, so this can never be swallowed by the patient route —
 * the same ordering `patient.controller.ts` had to make explicit for
 * `GET /patients/dedupe`.
 *
 * The gate is `patient.merge.review` (seeing the queue), not
 * `patient.merge.execute` (performing one). Medical records hold both; a
 * supervisor who may only review still needs the screen, and the execute
 * controls inside it gate themselves.
 */
export default function Page(): React.JSX.Element {
  const screen = patientScreen('merge');
  return (
    <PatientGate permission={screen.permission} deniedExplanation={screen.deniedExplanation}>
      <MergeTool />
    </PatientGate>
  );
}
