'use client';

import type { ReactNode } from 'react';
import { STORY_VARIANTS, findComponentStories, type Story, type StoryVariant } from '@vims/ui/stories';

/**
 * One specimen: a single story rendered in a single variant.
 *
 * The theme is applied the way the application applies it — `data-theme` and
 * `data-contrast` on a container, `dir` for RTL — rather than by a gallery-only
 * stylesheet. That is the entire argument for building this inside `apps/web`
 * instead of in Storybook: what a reviewer sees here is what a nurse sees,
 * through the same tokens, the same Tailwind build and the same fonts.
 *
 * Zoom is `transform: scale`, not `zoom`. `zoom` is not honoured consistently
 * and, more importantly, it changes layout: a 200 % `zoom` re-flows the
 * component to the new width, which is the opposite of what SC 1.4.4 asks. The
 * point of the 200 % variant is to see whether the component clips or overlaps
 * *at its own size*, so the specimen is scaled and given the room the scale
 * needs.
 */

export interface StorySpecimenProps {
  readonly story: Story;
  readonly variant: StoryVariant;
  readonly children?: ReactNode;
}

export function StorySpecimen({ story, variant }: StorySpecimenProps): React.JSX.Element {
  // Read `dir` before the `zoom` test below. `STORY_VARIANTS` is a
  // `satisfies`-narrowed tuple, so `variant.zoom !== 1` narrows `variant` to the
  // single 200% member — and TypeScript then correctly points out that member's
  // `dir` can only be 'ltr', making an RTL branch inside the guard dead code.
  // Hoisting keeps the origin correct if an RTL zoom variant is ever added.
  const origin = variant.dir === 'rtl' ? 'top right' : 'top left';
  const scaled = variant.zoom !== 1;

  return (
    <div
      data-slot="story-specimen"
      data-story={story.id}
      data-variant={variant.id}
      data-theme={variant.theme}
      data-contrast={variant.contrast === 'high' ? 'high' : undefined}
      dir={variant.dir}
      className="bg-canvas text-fg-default border-default overflow-hidden rounded-lg border"
    >
      <div
        className="flex min-h-24 items-center justify-center p-6"
        style={
          scaled
            ? {
                transform: `scale(${variant.zoom})`,
                transformOrigin: origin,
                // Give the scaled specimen the space it now occupies, so the
                // card grows rather than the specimen being clipped by it —
                // clipping here would hide the very overflow we are looking for.
                width: `${100 / variant.zoom}%`,
                height: `${100 * variant.zoom}%`,
              }
            : undefined
        }
      >
        {story.render()}
      </div>
    </div>
  );
}

export interface StoryRowProps {
  readonly story: Story;
}

/** One story across all five mandated variants. */
export function StoryRow({ story }: StoryRowProps): React.JSX.Element {
  return (
    <section
      data-slot="story-row"
      data-story={story.id}
      data-degraded={story.degraded === true ? 'true' : undefined}
      className="border-default border-t py-8 first:border-t-0"
      aria-labelledby={`story-${story.id}`}
    >
      <header className="mb-4 max-w-[72ch]">
        <h3 id={`story-${story.id}`} className="text-fg-default flex items-center gap-2 text-md font-medium">
          {story.name}
          {story.degraded === true ? (
            <span className="bg-warning-surface text-warning-on-surface border-warning-border rounded-full border px-2 py-0.5 text-2xs font-medium">
              degraded data
            </span>
          ) : null}
        </h3>
        <p className="text-fg-muted mt-1 text-xs">{story.rationale}</p>
      </header>

      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(15rem,1fr))]">
        {STORY_VARIANTS.map((variant) => (
          <figure key={variant.id} className="m-0 flex flex-col gap-2">
            <StorySpecimen story={story} variant={variant} />
            <figcaption className="text-fg-subtle text-2xs">
              <span className="text-fg-muted font-medium">{variant.label}</span> — {variant.why}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

export interface ComponentGalleryProps {
  readonly slug: string;
}

/**
 * The client boundary for a component's stories.
 *
 * It takes a **slug**, not the stories themselves. A `Story` holds a `render`
 * function, and a function cannot be serialised across the server/client
 * boundary — passing one from the page turns a working gallery into
 * "Functions cannot be passed directly to Client Components" at build time.
 * Resolving the catalogue on this side of the boundary keeps the page a Server
 * Component (so `generateStaticParams` and `metadata` still work) while the
 * specimens, which need `useId` and the DOM, stay on the client.
 */
export function ComponentGallery({ slug }: ComponentGalleryProps): React.JSX.Element | null {
  const component = findComponentStories(slug);
  if (component === undefined) return null;

  return (
    <div className="mt-6">
      {component.stories.map((story) => (
        <StoryRow key={story.id} story={story} />
      ))}
    </div>
  );
}
