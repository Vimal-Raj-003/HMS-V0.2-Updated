/**
 * `pnpm --filter @vims/ui tokens:contrast` — the accessibility gate for the token set.
 *
 * It fails the build (exit 1) if:
 *   1. the committed `theme.generated.css` no longer matches the TypeScript token
 *      source (someone hand-edited the CSS, or forgot `tokens:build`);
 *   2. the three themes do not define exactly the same token names;
 *   3. any declared foreground/background pair in `pairs.ts` misses its WCAG 2.2 AA
 *      threshold in ANY of light / dark / high-contrast;
 *   4. a colour token is neither gated by `pairs.ts` nor listed in `UNGATED` — a new
 *      token cannot slip past review by simply not being checked.
 *
 * docs/06 §11 lists "contrast unit tests over the token map" as a release gate, and
 * §3.3 explicitly expects this checker to block "white on any amber below --wa-700".
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateTheme, ungatedTokens, type ContrastFailure, type MissingToken } from './check.js';
import { renderTokensCss } from './generate-css.js';
import { UNGATED } from './pairs.js';
import { DEVIATIONS, themeLabels, themes, type ThemeKey } from './themes.js';

const THEME_ORDER: readonly ThemeKey[] = ['light', 'dark', 'high'];

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

function main(): number {
  let ok = true;

  out('');
  out("Vim's HMS design tokens — WCAG 2.2 AA gate (docs/06 §3.4, §7, §11)");
  out('='.repeat(78));

  // 1. generated CSS is in sync with the TypeScript source
  const cssPath = fileURLToPath(new URL('./theme.generated.css', import.meta.url));
  let onDisk = '';
  try {
    onDisk = readFileSync(cssPath, 'utf8');
  } catch {
    onDisk = '';
  }
  if (onDisk !== renderTokensCss()) {
    ok = false;
    out('');
    out('FAIL  theme.generated.css is out of date or was hand-edited.');
    out('      Run `pnpm --filter @vims/ui tokens:build` and commit the result.');
  } else {
    out(`ok    theme.generated.css matches the token source (${onDisk.split('\n').length} lines)`);
  }

  // 2. the three themes cover exactly the same token names
  const lightNames = Object.keys(themes.light).sort();
  for (const theme of THEME_ORDER) {
    const names = Object.keys(themes[theme]).sort();
    const onlyHere = names.filter((name) => !lightNames.includes(name));
    const missingHere = lightNames.filter((name) => !names.includes(name));
    if (onlyHere.length > 0 || missingHere.length > 0) {
      ok = false;
      out('');
      out(`FAIL  theme "${theme}" does not define the same tokens as "light".`);
      if (missingHere.length > 0) out(`      missing: ${missingHere.join(', ')}`);
      if (onlyHere.length > 0) out(`      extra:   ${onlyHere.join(', ')}`);
    }
  }
  out(`ok    all three themes define the same ${lightNames.length} semantic tokens`);

  // 3. the contrast obligations themselves
  const allFailures: ContrastFailure[] = [];
  const allMissing: MissingToken[] = [];
  out('');
  for (const theme of THEME_ORDER) {
    const { failures, missing, checked } = evaluateTheme(theme);
    allFailures.push(...failures);
    allMissing.push(...missing);
    const verdict = failures.length === 0 && missing.length === 0 ? 'PASS' : 'FAIL';
    out(
      `${verdict.padEnd(5)} ${themeLabels[theme].padEnd(48)} ${String(checked).padStart(4)} pairs, ${String(failures.length)} failing`,
    );
  }

  if (allMissing.length > 0) {
    ok = false;
    out('');
    out('FAIL  a declared requirement references a token that does not exist:');
    for (const item of allMissing) {
      out(`      [${item.theme}] ${item.token} (used as the ${item.side})`);
    }
  }

  if (allFailures.length > 0) {
    ok = false;
    out('');
    out(`FAIL  ${allFailures.length} token pair(s) below the WCAG 2.2 AA threshold:`);
    out('');
    for (const failure of allFailures) {
      const { requirement } = failure;
      out(`  [${failure.theme}] ${requirement.foreground}  on  ${requirement.background}`);
      out(
        `      ${failure.foregroundColor} on ${failure.backgroundColor} = ${failure.actual.toFixed(2)}:1, ` +
          `needs ${requirement.min.toFixed(1)}:1 (${requirement.kind})`,
      );
      out(`      why: ${requirement.why}`);
      out('');
    }
  }

  // 4. no colour token escapes review
  const ungated = ungatedTokens(UNGATED);
  if (ungated.length > 0) {
    ok = false;
    out('');
    out('FAIL  these tokens are neither gated by pairs.ts nor declared in UNGATED:');
    for (const name of ungated) out(`      ${name}`);
    out('      Add a requirement, or document why the token carries no contrast duty.');
  } else {
    out(`ok    every semantic token is either gated or explicitly exempt (${Object.keys(UNGATED).length} exempt)`);
  }

  out('');
  out(`Documented deviations from the literal hexes in docs/06 (${DEVIATIONS.length}):`);
  for (const note of DEVIATIONS) out(`  - ${note}`);

  out('');
  out('='.repeat(78));
  out(ok ? 'tokens:contrast PASSED — all three themes meet WCAG 2.2 AA.' : 'tokens:contrast FAILED.');
  out('');
  return ok ? 0 : 1;
}

process.exitCode = main();
