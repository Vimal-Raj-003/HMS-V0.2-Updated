import type { Metadata } from 'next';
import { FrontOfficeGate } from '@/features/frontoffice/components/frontoffice-gate';
import { QueueConsoleScreen } from '@/features/frontoffice/components/queue-console-screen';

export const metadata: Metadata = { title: "Queue console · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return (
    <FrontOfficeGate screenKey="queue">
      <QueueConsoleScreen />
    </FrontOfficeGate>
  );
}
