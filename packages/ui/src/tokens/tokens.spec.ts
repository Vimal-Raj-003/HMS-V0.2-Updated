import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, parseColor, roundRatio } from './contrast.js';
import { evaluateTheme, ungatedTokens } from './check.js';
import { renderTokensCss } from './generate-css.js';
import { UNGATED } from './pairs.js';
import { themes, type SemanticTokens } from './themes.js';
import { resolvedTheme, tokenCounts } from './tokens.js';

describe('contrast mathematics', () => {
  it('reproduces the reference ratios in WCAG 2.2', () => {
    expect(roundRatio(contrastRatio('#000000', '#FFFFFF'))).toBe(21);
    expect(roundRatio(contrastRatio('#FFFFFF', '#FFFFFF'))).toBe(1);
    // docs/06 §3.2 quotes 5.08:1 for white on --p-600; the exact value is 5.05.
    expect(roundRatio(contrastRatio('#FFFFFF', '#0E7A88'))).toBeCloseTo(5.05, 2);
  });

  it('composites a translucent foreground over its background before measuring', () => {
    const hairline = parseColor('rgba(255, 255, 255, 0.08)');
    expect(hairline.a).toBeCloseTo(0.08, 5);
    // A white hairline at 8 % over the dark canvas is nowhere near white's 18.8:1.
    expect(roundRatio(contrastRatio('rgba(255,255,255,0.08)', '#0D1219'))).toBeLessThan(1.4);
  });

  it('truncates rather than rounds up, so a 4.499 never reports as a pass', () => {
    expect(roundRatio(4.4999)).toBe(4.49);
  });
});

describe('the token map', () => {
  it('publishes every documented category', () => {
    const counts = tokenCounts();
    expect(counts['palette']).toBeGreaterThan(60);
    expect(counts['typography']).toBeGreaterThan(40);
    expect(counts['scales']).toBeGreaterThan(50);
    expect(counts['semanticPerTheme']).toBeGreaterThan(150);
  });

  it('defines the same token names in light, dark and high contrast', () => {
    const light = Object.keys(themes.light).sort();
    expect(Object.keys(themes.dark).sort()).toEqual(light);
    expect(Object.keys(themes.high).sort()).toEqual(light);
  });

  it('resolves a theme to opaque values with no var() left behind', () => {
    for (const value of Object.values(resolvedTheme('dark'))) {
      expect(value).not.toContain('var(');
    }
  });

  it('leaves no colour token ungated and undocumented', () => {
    expect(ungatedTokens(UNGATED)).toEqual([]);
  });

  it('keeps the committed CSS in step with the TypeScript source', () => {
    // vitest runs the jsdom environment, where `import.meta.url` is an http URL, so the
    // path is resolved from the package root instead.
    const path = join(process.cwd(), 'src', 'tokens', 'theme.generated.css');
    expect(readFileSync(path, 'utf8')).toBe(renderTokensCss());
  });
});

describe('the WCAG 2.2 AA gate', () => {
  it.each(['light', 'dark', 'high'] as const)('passes in the %s theme', (theme) => {
    const report = evaluateTheme(theme);
    expect(report.missing).toEqual([]);
    expect(report.checked).toBeGreaterThan(200);
    expect(report.failures.map((failure) => `${failure.requirement.foreground} on ${failure.requirement.background}`)).toEqual([]);
  });

  it('FAILS when a token is regressed to a value docs/06 §3.3 says must be blocked', () => {
    // "white on any amber below --wa-700 fails and is blocked by the contrast unit test".
    const sabotaged: SemanticTokens = {
      ...themes.light,
      '--color-warning-solid': { css: 'var(--wa-500)', color: '#F79009' },
      '--color-warning-on-solid': { css: 'var(--n-0)', color: '#FFFFFF' },
    };
    const report = evaluateTheme('light', sabotaged);
    const names = report.failures.map((failure) => failure.requirement.foreground);
    expect(names).toContain('--color-warning-on-solid');
    const failure = report.failures.find((item) => item.requirement.foreground === '--color-warning-on-solid');
    expect(failure?.actual).toBeLessThan(4.5);
  });

  it('FAILS when the neutral foreground is lightened past AA', () => {
    const sabotaged: SemanticTokens = {
      ...themes.light,
      '--fg-default': { css: 'var(--n-300)', color: '#B3BDCA' },
    };
    expect(evaluateTheme('light', sabotaged).failures.length).toBeGreaterThan(0);
  });
});
