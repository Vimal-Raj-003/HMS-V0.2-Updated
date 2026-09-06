import Link from 'next/link';
import { STORY_CATALOGUE } from '@vims/ui/stories';

/**
 * The design gallery index — `docs/06` §5.2's story requirement, D-51.
 *
 * Reachable only with a session: `/design` is not in the middleware's
 * `PUBLIC_PATHS`, so an unauthenticated request is redirected to `/login` like
 * any other workspace route. That is the whole of the access control it needs —
 * the specimens are synthetic and contain no patient data by construction — but
 * it means the gallery cannot become an unauthenticated door into a hospital
 * deployment.
 */

export const metadata = {
  title: 'Design system · Vim’s HMS',
  description: 'Every clinical component, in the five variants docs/06 §5.2 requires.',
};

export default function DesignIndexPage(): React.JSX.Element {
  const totalStories = STORY_CATALOGUE.reduce((n, c) => n + c.stories.length, 0);
  const degraded = STORY_CATALOGUE.reduce(
    (n, c) => n + c.stories.filter((s) => s.degraded === true).length,
    0,
  );

  return (
    <main className="mx-auto max-w-[72rem] px-6 py-12">
      <header className="max-w-[64ch]">
        <h1 className="text-fg-default text-2xl font-semibold tracking-tight">Design system</h1>
        <p className="text-fg-muted mt-2 text-sm">
          Every clinical component, rendered in the five variants{' '}
          <span className="text-fg-default font-medium">docs/06 §5.2</span> requires: Light Clinical, Dark
          Layered Stack, high contrast, 200% zoom and RTL. The specimens use the application’s own tokens and
          fonts, so what is reviewed here is what a ward sees.
        </p>
        <p className="text-fg-muted mt-3 text-xs">
          {STORY_CATALOGUE.length} components · {totalStories} stories · {degraded} of them degraded-data
          cases. <code className="font-mono">catalogue.spec.ts</code> fails when a component has neither a
          story nor a recorded reason for not having one.
        </p>
      </header>

      <ul className="mt-10 grid list-none gap-4 p-0 [grid-template-columns:repeat(auto-fill,minmax(20rem,1fr))]">
        {STORY_CATALOGUE.map((component) => (
          <li key={component.slug}>
            <Link
              href={`/design/${component.slug}`}
              className="border-default bg-layer-1 hover:bg-layer-3 focus-visible:outline-focus block h-full rounded-lg border p-5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <span className="flex items-baseline justify-between gap-3">
                <span className="text-fg-default font-mono text-sm font-medium">{component.component}</span>
                <span className="text-fg-subtle text-2xs">{component.spec}</span>
              </span>
              <span className="text-fg-muted mt-2 block text-xs">{component.summary}</span>
              <span className="text-fg-subtle mt-3 block text-2xs">{component.stories.length} stories</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
