import type { Metadata } from 'next';
import { AdminGate } from '@/features/admin/components/admin-gate';
import { RolesScreen } from '@/features/admin/components/roles-screen';

export const metadata: Metadata = { title: "Roles & permissions · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <AdminGate screenKey="roles">
      <RolesScreen />
    </AdminGate>
  );
}
