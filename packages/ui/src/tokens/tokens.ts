/**
 * The JavaScript face of the token set — consumed by print templates today and by
 * React Native in Phase 13 (docs/06 §11: "-> `tokens.ts` for RN/print").
 *
 * Everything here is derived from the same source the CSS is generated from, so a
 * token can never mean one thing on the web and another on a wristband label.
 */
export * from './palette.js';
export * from './scales.js';
export * from './themes.js';
export * from './contrast.js';
export * from './pairs.js';
export * from './check.js';
export { renderTokensCss } from './generate-css.js';

import { paletteCssVariables } from './palette.js';
import { scaleCssVariables, typographyCssVariables } from './scales.js';
import { themes, type ThemeKey } from './themes.js';

/**
 * Every custom property for one theme, flattened and fully resolved (no `var()`),
 * which is what a React Native StyleSheet or a headless PDF renderer needs.
 */
export function resolvedTheme(theme: ThemeKey): Record<string, string> {
  const out: Record<string, string> = {
    ...paletteCssVariables(),
    ...typographyCssVariables(),
    ...scaleCssVariables(),
  };
  for (const [name, token] of Object.entries(themes[theme])) {
    out[name] = token.color;
  }
  return out;
}

/** Count of every token the design system publishes, per category. Used by the docs. */
export function tokenCounts(): Record<string, number> {
  return {
    palette: Object.keys(paletteCssVariables()).length,
    typography: Object.keys(typographyCssVariables()).length,
    scales: Object.keys(scaleCssVariables()).length,
    semanticPerTheme: Object.keys(themes.light).length,
  };
}
