import type { Metadata } from 'next';
import { AdminGate } from '@/features/admin/components/admin-gate';
import { AuditScreen } from '@/features/admin/components/audit-screen';

export const metadata: Metadata = { title: "Audit log · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <AdminGate screenKey="audit">
      <AuditScreen />
    </AdminGate>
  );
}
