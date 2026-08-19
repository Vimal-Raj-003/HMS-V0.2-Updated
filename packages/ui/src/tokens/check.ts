/**
 * The pure half of the contrast gate, so both the CLI (`verify-contrast.ts`) and the
 * unit test (`contrast.spec.ts`) exercise exactly the same code path.
 */
import { contrastRatio, roundRatio } from './contrast.js';
import { requirementsFor, type ContrastRequirement } from './pairs.js';
import { themes, type SemanticTokens, type ThemeKey } from './themes.js';

export interface ContrastFailure {
  readonly theme: ThemeKey;
  readonly requirement: ContrastRequirement;
  readonly actual: number;
  readonly foregroundColor: string;
  readonly backgroundColor: string;
}

export interface MissingToken {
  readonly theme: ThemeKey;
  readonly token: string;
  readonly side: 'foreground' | 'background';
}

export interface ThemeReport {
  readonly theme: ThemeKey;
  readonly checked: number;
  readonly failures: readonly ContrastFailure[];
  readonly missing: readonly MissingToken[];
}

export function evaluateTheme(theme: ThemeKey, tokens: SemanticTokens = themes[theme]): ThemeReport {
  const failures: ContrastFailure[] = [];
  const missing: MissingToken[] = [];
  let checked = 0;

  for (const requirement of requirementsFor(theme)) {
    const fg = tokens[requirement.foreground]?.color;
    const bg = tokens[requirement.background]?.color;
    if (fg === undefined) {
      missing.push({ theme, token: requirement.foreground, side: 'foreground' });
      continue;
    }
    if (bg === undefined) {
      missing.push({ theme, token: requirement.background, side: 'background' });
      continue;
    }
    checked += 1;
    const actual = roundRatio(contrastRatio(fg, bg));
    if (actual < requirement.min) {
      failures.push({ theme, requirement, actual, foregroundColor: fg, backgroundColor: bg });
    }
  }

  return { theme, checked, failures, missing };
}

/** Tokens that carry no declared contrast obligation and are not documented as exempt. */
export function ungatedTokens(exempt: Readonly<Record<string, string>>): string[] {
  const gated = new Set<string>();
  for (const theme of ['light', 'dark', 'high'] as const) {
    for (const requirement of requirementsFor(theme)) {
      gated.add(requirement.foreground);
      gated.add(requirement.background);
    }
  }
  return Object.keys(themes.light).filter((name) => !gated.has(name) && !(name in exempt));
}
