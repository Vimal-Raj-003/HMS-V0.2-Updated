import type { Metadata } from 'next';
import { FrontOfficeHome } from '@/features/frontoffice/components/frontoffice-home';

export const metadata: Metadata = { title: "Front office · Vim's HMS" };

export default function Page(): React.JSX.Element {
  return <FrontOfficeHome />;
}
