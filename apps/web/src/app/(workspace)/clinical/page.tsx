import type { Metadata } from 'next';
import { ClinicalHome } from '@/features/clinical/components/clinical-home';

export const metadata: Metadata = { title: "Clinical · Vim's HMS" };

/**
 * `/clinical` — the hub.
 *
 * It carries no permission gate of its own: it renders only the tiles the
 * session can open, and explains itself when that is none. Gating the hub would
 * turn "you hold one of these four keys" into a 403 for everybody who holds
 * three.
 */
export default function Page(): React.JSX.Element {
  return <ClinicalHome />;
}
