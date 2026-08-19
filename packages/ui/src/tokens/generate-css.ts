/**
 * Renders every token in `palette.ts`, `scales.ts` and `themes.ts` into the CSS that
 * ships (`theme.generated.css`), including the Tailwind v4 `@theme inline` bridge.
 *
 * docs/06 §11: "Tokens: `packages/ui/src/tokens/{color,typography,space,motion,elevation}.css`
 * -> Tailwind v4 `@theme` -> `tokens.ts` for RN/print." One generator keeps those three
 * representations from drifting; `verify-contrast.ts` fails the build if the committed
 * CSS no longer matches what this function produces.
 */
import { paletteCssVariables } from './palette.js';
import {
  breakpoints,
  density,
  durations,
  easings,
  elevation,
  fontSizes,
  radii,
  scaleCssVariables,
  spacing,
  typographyCssVariables,
  zIndex,
} from './scales.js';
import { themeSelectors, themes, type SemanticTokens } from './themes.js';

const HEADER = `/*
 * GENERATED FILE — do not edit by hand.
 * Source: packages/ui/src/tokens/{palette,scales,themes}.ts
 * Regenerate: pnpm --filter @vims/ui tokens:build
 * Verified by: pnpm --filter @vims/ui tokens:contrast (WCAG 2.2 AA gate, all three themes)
 */`;

function block(selector: string, entries: Iterable<readonly [string, string]>, comment?: string): string {
  const lines: string[] = [];
  if (comment) lines.push(`/* ${comment} */`);
  lines.push(`${selector} {`);
  for (const [name, value] of entries) {
    lines.push(`  ${name}: ${value};`);
  }
  lines.push('}');
  return lines.join('\n');
}

function semanticEntries(tokens: SemanticTokens): Array<readonly [string, string]> {
  return Object.entries(tokens).map(([name, token]) => [name, token.css] as const);
}

/** `--color-danger-fg` -> `danger-fg`; `--bg-canvas` -> `canvas`; `--border-control` -> `control`. */
/**
 * Escapes a scale key for use inside a CSS custom-property name.
 *
 * A CSS ident may not contain `.`, so the half-step keys (`0.5`, `1.5`) would
 * produce `--sp-0.5` — which is not an invalid *value*, it is an invalid
 * *name*, so the browser silently discards the whole declaration and every
 * utility built on it resolves to nothing. Escaping to `--sp-0\.5` is what
 * Tailwind itself does, and it keeps the utility readable as `p-0.5`.
 */
function cssKey(key: string): string {
  return key.replace(/\./g, '\\.');
}

export function tailwindColorName(token: string): string {
  const bare = token.replace(/^--/, '');
  for (const prefix of ['color-', 'bg-', 'border-']) {
    if (bare.startsWith(prefix)) return bare.slice(prefix.length);
  }
  return bare;
}

/** Tailwind v4 namespace bridge — `bg-canvas`, `text-danger-fg`, `p-4`, `rounded-lg`… */
function tailwindTheme(): string {
  const entries: Array<readonly [string, string]> = [];

  // Colours: every semantic colour token becomes a Tailwind colour utility. One
  // leading namespace prefix is stripped so the utilities read as `bg-canvas`,
  // `text-fg-muted`, `border-control`, `bg-danger-solid` rather than `bg-bg-canvas`.
  for (const name of Object.keys(themes.light)) {
    entries.push([`--color-${tailwindColorName(name)}`, `var(${name})`]);
  }

  for (const key of Object.keys(spacing))
    entries.push([`--spacing-${cssKey(key)}`, `var(--sp-${cssKey(key)})`]);
  for (const key of Object.keys(radii)) entries.push([`--radius-${key}`, `var(--r-${key})`]);
  for (const key of Object.keys(fontSizes)) {
    entries.push([`--text-${key}`, `var(--fs-${key})`]);
    entries.push([`--text-${key}--line-height`, `var(--lh-${key})`]);
  }
  entries.push(['--font-ui', 'var(--font-ui)']);
  entries.push(['--font-display', 'var(--font-display)']);
  entries.push(['--font-mono', 'var(--font-mono)']);
  for (const key of Object.keys(elevation)) entries.push([`--shadow-e${key}`, `var(--e-${key})`]);
  for (const key of Object.keys(durations)) entries.push([`--animate-duration-${key}`, `var(--dur-${key})`]);
  for (const key of Object.keys(easings)) entries.push([`--ease-${key}`, `var(--ease-${key})`]);
  // Literal values, NOT `var(--bp-*)`. Tailwind v4 reads `--breakpoint-*` at
  // build time to construct the media queries, and it cannot resolve a custom
  // property to do it — `@media (min-width: var(--bp-md))` is invalid CSS, so
  // the browser drops the whole block. The utilities are still emitted, which is
  // what makes this so quiet: `md:block` exists in the stylesheet, matches
  // nothing, and every responsive layout in the product silently collapses to
  // its smallest variant. Found by an end-to-end test, not by review.
  for (const [key, value] of Object.entries(breakpoints)) entries.push([`--breakpoint-${key}`, value]);
  for (const key of Object.keys(zIndex)) entries.push([`--z-index-${key}`, `var(--z-${key})`]);
  for (const key of Object.keys(density)) entries.push([`--spacing-row-${key}`, `var(--row-${key})`]);

  return block('@theme inline', entries, 'Tailwind v4 bridge — utilities resolve to the themed custom properties');
}

export function renderTokensCss(): string {
  const rootEntries: Array<readonly [string, string]> = [
    ...Object.entries(paletteCssVariables()),
    ...Object.entries(typographyCssVariables()),
    ...Object.entries(scaleCssVariables()),
    ...semanticEntries(themes.light),
  ];

  const darkEntries: Array<readonly [string, string]> = [
    ...semanticEntries(themes.dark),
    // docs/06 §3.7: "Dark theme uses layers + hairlines, --e-* collapse to none
    // except dialogs."
    ['--e-1', 'none'],
    ['--e-2', 'none'],
    ['--e-3', 'none'],
  ];

  const reducedMotion = block(
    ':root',
    Object.keys(durations).map((key) => [`--dur-${key}`, '1ms'] as const),
  );

  return [
    HEADER,
    '',
    block(themeSelectors.light, rootEntries, 'Light Clinical — the default for clinical and data-entry work (docs/06 §2.1)'),
    '',
    block(themeSelectors.dark, darkEntries, 'Dark Layered Stack — dashboards, command centres, TV boards (docs/06 §2.2)'),
    '',
    block(themeSelectors.high, semanticEntries(themes.high), 'High-contrast Light — bright wards and the ER ambulance bay (docs/06 §7)'),
    '',
    '/* docs/06 §3.7: prefers-reduced-motion collapses every duration; transforms are',
    '   disabled in component CSS and pulsing "live" dots become static rings. */',
    `@media (prefers-reduced-motion: reduce) {\n${reducedMotion
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')}\n}`,
    '',
    tailwindTheme(),
    '',
  ].join('\n');
}
