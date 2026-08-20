import type { Metadata } from 'next';
import { ConsoleHome } from '@/features/admin/components/console-home';

export const metadata: Metadata = { title: "Administration · Vim's HMS" };

/**
 * The console home is not gated on a permission of its own: it lists only the
 * screens the session can open, and lists nothing when that set is empty. A gate
 * here would have to invent a key the catalogue does not contain.
 */
export default function Page(): React.JSX.Element {
  return <ConsoleHome />;
}
