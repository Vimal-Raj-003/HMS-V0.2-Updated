import type { Metadata } from 'next';
import { AdminGate } from '@/features/admin/components/admin-gate';
import { LicenceScreen } from '@/features/admin/components/licence-screen';

export const metadata: Metadata = { title: "Licence · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <AdminGate screenKey="licence">
      <LicenceScreen />
    </AdminGate>
  );
}
