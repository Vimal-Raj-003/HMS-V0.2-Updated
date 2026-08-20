import type { Metadata } from 'next';
import { AdminGate } from '@/features/admin/components/admin-gate';
import { BranchesScreen } from '@/features/admin/components/branches-screen';

export const metadata: Metadata = { title: "Branches · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <AdminGate screenKey="branches">
      <BranchesScreen />
    </AdminGate>
  );
}
