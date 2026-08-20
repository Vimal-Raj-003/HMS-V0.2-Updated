import axe from 'axe-core';

/**
 * `docs/06 §11` — "Storybook a11y (`axe`) zero violations on P0 components".
 *
 * jsdom has no layout engine, so the rules that need geometry (`color-contrast`,
 * `target-size`) cannot run here. Those two are covered elsewhere and deliberately:
 *   - colour contrast by `pnpm tokens:contrast`, over the token map in all three themes;
 *   - target size by the size variants in `button.tsx` / `input.tsx` (>= 44 px on touch).
 */
const DISABLED_IN_JSDOM = {
  'color-contrast': { enabled: false },
  'target-size': { enabled: false },
} as const;

export interface AxeViolationSummary {
  readonly id: string;
  readonly impact: string;
  readonly nodes: number;
  readonly help: string;
}

export async function findAccessibilityViolations(container: Element): Promise<AxeViolationSummary[]> {
  const results = await axe.run(container, {
    rules: { ...DISABLED_IN_JSDOM },
    resultTypes: ['violations'],
  });
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact ?? 'unknown',
    nodes: violation.nodes.length,
    help: violation.help,
  }));
}
