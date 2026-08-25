import type { Metadata } from 'next';
import { DiagnosticsHome } from '@/features/diagnostics/components/diagnostics-home';

export const metadata: Metadata = { title: "Diagnostics · Vim's HMS" };

/**
 * `/diagnostics` — the hub.
 *
 * It carries no permission gate of its own: it renders only the tiles the
 * session can open, and explains itself when that is none. Gating the hub would
 * turn "you hold one of these eight keys" into a 403 for everybody who holds
 * seven.
 */
export default function Page(): React.JSX.Element {
  return <DiagnosticsHome />;
}
