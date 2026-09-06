import type { ReactNode } from 'react';

/**
 * The story format for `@vims/ui`.
 *
 * `docs/06` §5.2 ends with a requirement, not a suggestion: "Every clinical
 * component ships with: Storybook story (light + dark + high-contrast + 200 %
 * zoom + RTL), `axe` test, keyboard-only test, and a 'degraded data' story."
 * None of that existed — there was no Storybook, no story, and no per-component
 * accessibility test.
 *
 * **This is that harness, without Storybook.** The deviation is deliberate and
 * recorded as D-51. Storybook would add several hundred transitive packages to
 * a system that has to pass a supply-chain audit, and — more to the point — it
 * renders components in *its own* shell, so what you review is Storybook's
 * document with our CSS in it. The five variants the spec asks for are all
 * properties of the real document: `data-theme`, `data-contrast`, `dir`, and a
 * zoom. Rendering them inside `apps/web` means the gallery exercises the actual
 * token pipeline, the actual font loading, and the actual Tailwind build, and it
 * inherits the app's authentication rather than opening a second front door.
 *
 * A story is data, not a test. `apps/web/src/app/design` renders it and
 * `apps/web/e2e/design-system.spec.ts` walks the same catalogue with axe and
 * with the keyboard, so a component cannot be added to the gallery without
 * also being scanned.
 */

export interface Story {
  /** Stable, URL-safe within its component, e.g. `critical-high`. */
  readonly id: string;
  /** Sentence describing what this state *is*, shown above the specimen. */
  readonly name: string;
  /**
   * Why this state is worth a story — the clinical situation it represents.
   * Required: a story whose reason for existing cannot be written down is
   * usually a duplicate of the one above it.
   */
  readonly rationale: string;
  /**
   * `docs/06` §5.2 — the "degraded data" story. Marks the specimens that stand
   * in for missing weight, unknown allergies, a stale socket, a partial score.
   * The gallery groups these together because they are the ones that get
   * skipped, and they are the ones that fail in a ward at 3 a.m.
   */
  readonly degraded?: boolean;
  /**
   * Set when the specimen legitimately contains an accessibility violation that
   * axe cannot be talked out of, with the reason. Nothing in this repository
   * uses it yet; it exists so that a future exception is a visible, reviewed
   * line of code rather than a disabled test.
   */
  readonly axeExempt?: { readonly rule: string; readonly why: string };
  readonly render: () => ReactNode;
}

export interface ComponentStories {
  /** URL segment, e.g. `result-flag`. */
  readonly slug: string;
  /** The exported component name, e.g. `ResultFlag`. */
  readonly component: string;
  /** The clause in `docs/06` this component answers to, e.g. `§5.2 #6`. */
  readonly spec: string;
  /** One line on what the component is for, in the reviewer's language. */
  readonly summary: string;
  readonly stories: readonly Story[];
}

/** Identity helper — exists so a stories file is type-checked at its definition. */
export function defineStories(entry: ComponentStories): ComponentStories {
  return entry;
}

/**
 * The variants every specimen is rendered in.
 *
 * Exactly the list in §5.2, and the order is the review order: a reviewer reads
 * light first because it is the clinical default (§2), then the two themes that
 * change the most, then the two that change layout rather than colour.
 */
export const STORY_VARIANTS = [
  {
    id: 'light',
    label: 'Light Clinical',
    why: 'The default for clinical and data-entry work (§2.1).',
    theme: 'light',
    contrast: 'normal',
    dir: 'ltr',
    zoom: 1,
  },
  {
    id: 'dark',
    label: 'Dark Layered Stack',
    why: 'Dashboards, command centres, TV boards, night wards (§2.2).',
    theme: 'dark',
    contrast: 'normal',
    dir: 'ltr',
    zoom: 1,
  },
  {
    id: 'high-contrast',
    label: 'High contrast',
    why: 'Bright wards and the ER ambulance bay: every foreground ≥ 7:1 (§2, §7).',
    theme: 'light',
    contrast: 'high',
    dir: 'ltr',
    zoom: 1,
  },
  {
    id: 'zoom-200',
    label: '200% zoom',
    why: 'WCAG 2.2 SC 1.4.4. Nothing may clip, overlap or scroll horizontally.',
    theme: 'light',
    contrast: 'normal',
    dir: 'ltr',
    zoom: 2,
  },
  {
    id: 'rtl',
    label: 'RTL (ar)',
    why: 'Arabic is a shipped locale (CLAUDE.md §4); mirroring must not break a layout.',
    theme: 'light',
    contrast: 'normal',
    dir: 'rtl',
    zoom: 1,
  },
] as const satisfies readonly {
  readonly id: string;
  readonly label: string;
  readonly why: string;
  readonly theme: 'light' | 'dark';
  readonly contrast: 'normal' | 'high';
  readonly dir: 'ltr' | 'rtl';
  readonly zoom: number;
}[];

export type StoryVariant = (typeof STORY_VARIANTS)[number];
