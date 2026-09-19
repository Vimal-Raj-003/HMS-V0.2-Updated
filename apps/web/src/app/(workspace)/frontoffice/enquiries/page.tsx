import type { Metadata } from 'next';
import { EnquiriesScreen } from '@/features/frontoffice/components/enquiries-screen';
import { FrontOfficeGate } from '@/features/frontoffice/components/frontoffice-gate';

export const metadata: Metadata = { title: "Website enquiries · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <FrontOfficeGate screenKey="enquiries">
      <EnquiriesScreen />
    </FrontOfficeGate>
  );
}
