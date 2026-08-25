import type { Metadata } from 'next';
import { DiagnosticsGate } from '@/features/diagnostics/components/diagnostics-gate';
import { LabBenchScreen } from '@/features/diagnostics/components/lab-bench-screen';

export const metadata: Metadata = { title: "Bench worklist · Vim's HMS" };

/**
 * The route takes **no parameters**. Every identifier this screen works with
 * lives in component state or in a request body, so `docs/06` §6.5 — "no PHI in
 * the URL" — holds by construction rather than by review: there is nothing in
 * the address bar for a proxy log, a browser history or a shoulder to read.
 */
export default function Page(): React.JSX.Element {
  return (
    <DiagnosticsGate screenKey="lab-bench">
      <LabBenchScreen />
    </DiagnosticsGate>
  );
}
