import Link from 'next/link';
import { notFound } from 'next/navigation';
import { STORY_CATALOGUE, findComponentStories } from '@vims/ui/stories';
import { ComponentGallery } from '../story-specimen';

/**
 * One component, every story, every variant.
 *
 * `generateStaticParams` is what lets `design-system.spec.ts` walk the gallery
 * without a hard-coded route list: the axe suite reads the same catalogue this
 * page does, so a component cannot appear here without also being scanned.
 */

export function generateStaticParams(): { slug: string }[] {
  return STORY_CATALOGUE.map((c) => ({ slug: c.slug }));
}

export default async function DesignComponentPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const component = findComponentStories(slug);
  if (component === undefined) notFound();

  return (
    <main className="mx-auto max-w-[72rem] px-6 py-12">
      <nav className="mb-8">
        <Link
          href="/design"
          className="text-fg-link hover:text-fg-link-hover focus-visible:outline-focus rounded text-xs focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Design system
        </Link>
      </nav>

      <header className="max-w-[64ch]">
        <h1 className="text-fg-default font-mono text-2xl font-semibold tracking-tight">
          {component.component}
        </h1>
        <p className="text-fg-muted mt-2 text-sm">{component.summary}</p>
        <p className="text-fg-subtle mt-2 text-xs">
          docs/06 {component.spec} · {component.stories.length} stories
        </p>
      </header>

      {/* Only the slug crosses the boundary — see ComponentGallery. */}
      <ComponentGallery slug={slug} />
    </main>
  );
}
