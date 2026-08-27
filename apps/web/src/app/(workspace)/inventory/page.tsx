import type { Metadata } from 'next';
import { InventoryHome } from '@/features/inventory/components/inventory-home';

export const metadata: Metadata = { title: "Stores & purchase · Vim's HMS" };

/**
 * The hub. It carries no permission gate of its own: it renders only the tiles
 * the session can open, and explains itself when that is none. Gating the hub
 * would turn "you hold one of these keys" into a 403 for everybody who holds
 * most of them.
 */
export default function Page(): React.JSX.Element {
  return <InventoryHome />;
}
