import type { Metadata } from 'next';
import { SpecialtyGate } from '@/features/specialty/components/specialty-gate';
import { HealthCheckScreen } from '@/features/specialty/programme/components/healthcheck-screen';

export const metadata: Metadata = { title: "Health check-ups · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <SpecialtyGate screenKey="health-checkup">
      <HealthCheckScreen />
    </SpecialtyGate>
  );
}
