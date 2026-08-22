import type { Metadata } from 'next';
import { AppointmentBookScreen } from '@/features/frontoffice/components/appointment-book-screen';
import { FrontOfficeGate } from '@/features/frontoffice/components/frontoffice-gate';

export const metadata: Metadata = { title: "Appointment book · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <FrontOfficeGate screenKey="appointments">
      <AppointmentBookScreen />
    </FrontOfficeGate>
  );
}
