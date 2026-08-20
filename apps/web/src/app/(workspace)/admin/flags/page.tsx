import type { Metadata } from 'next';
import { AdminGate } from '@/features/admin/components/admin-gate';
import { FlagsScreen } from '@/features/admin/components/flags-screen';

export const metadata: Metadata = { title: "Feature flags · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <AdminGate screenKey="flags">
      <FlagsScreen />
    </AdminGate>
  );
}
