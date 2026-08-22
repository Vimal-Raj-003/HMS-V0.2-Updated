import type { Metadata } from 'next';
import { PatientGate } from '@/features/patient/components/patient-gate';
import { RegistrationDesk } from '@/features/patient/components/registration-desk';
import { patientScreen } from '@/features/patient/screens';

export const metadata: Metadata = { title: "Registration desk · Vim's HMS" };

/**
 * `/patients` — the registration desk (OP-001 §8).
 *
 * The route is deliberately parameterless. `docs/06` §6.5 forbids PHI in a URL,
 * and a search term is PHI: a name or a mobile number in the address bar reaches
 * browser history, the referer header of every subsequent request, and any proxy
 * log between here and the API. The search lives in component state, and the only
 * thing that ever appears in a patient URL is the opaque id.
 */
export default function Page(): React.JSX.Element {
  const screen = patientScreen('registration');
  return (
    <PatientGate permission={screen.permission} deniedExplanation={screen.deniedExplanation}>
      <RegistrationDesk />
    </PatientGate>
  );
}
