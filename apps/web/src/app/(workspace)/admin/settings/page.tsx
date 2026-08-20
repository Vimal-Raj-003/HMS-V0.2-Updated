import type { Metadata } from 'next';
import { AdminGate } from '@/features/admin/components/admin-gate';
import { SettingsScreen } from '@/features/admin/components/settings-screen';

export const metadata: Metadata = { title: "Settings · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <AdminGate screenKey="settings">
      <SettingsScreen />
    </AdminGate>
  );
}
