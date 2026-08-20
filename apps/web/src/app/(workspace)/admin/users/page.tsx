import type { Metadata } from 'next';
import { AdminGate } from '@/features/admin/components/admin-gate';
import { UsersScreen } from '@/features/admin/components/users-screen';

export const metadata: Metadata = { title: "Users · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <AdminGate screenKey="users">
      <UsersScreen />
    </AdminGate>
  );
}
