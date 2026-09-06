/**
 * Fails if a hex colour literal appears outside `packages/ui/src/tokens`.
 *
 * docs/06 §11: colour is consumed through semantic tokens (`var(--fg-danger)`),
 * never as a raw hex. The reason is not tidiness — a hard-coded `#D92D20`
 * silently opts out of the dark and high-contrast themes, so a component that
 * looks correct in review becomes unreadable on a ward TV or for a user who has
 * turned high contrast on. ESLint enforces this for `.ts`/`.tsx`; this script
 * covers CSS and anything ESLint does not parse.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['apps', 'packages', 'services'];
const ALLOWED_PREFIXES = [
  join('packages', 'ui', 'src', 'tokens'),
  // Print output is a physical artefact: a thermal printer has no themes.
  join('packages', 'print-templates', 'src'),
];
const EXTENSIONS = new Set(['.css', '.scss', '.svg', '.html']);
const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.turbo',
  'coverage',
  'generated',
  // Playwright output. Traces embed a snapshot of the rendered page, so a
  // trace of any screen contains the compiled stylesheet — every token as a
  // hex literal, which is what a token compiles *to*. Scanning it fails this
  // check on its own evidence, and only after a test run, which makes it look
  // like the last commit caused it.
  'test-results',
  'playwright-report',
]);
/**
 * Every Next build directory, not just `.next`.
 *
 * `distDir` is overridable (`apps/web/next.config.ts`), so the browser suite
 * builds into `.next-e2e` and a dev server can be pointed anywhere. Naming only
 * `.next` meant the compiled Tailwind stylesheet — which legitimately contains
 * every token as a hex literal, because that is what a token compiles *to* —
 * was scanned as if it were source, and the check failed on its own output.
 */
const SKIP_DIR_PATTERN = /^\.next(?:[-.].*)?$/;

const offenders = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || SKIP_DIR_PATTERN.test(entry.name)) continue;
      walk(join(dir, entry.name));
      continue;
    }
    const path = join(dir, entry.name);
    const ext = entry.name.slice(entry.name.lastIndexOf('.'));
    if (!EXTENSIONS.has(ext)) continue;
    if (ALLOWED_PREFIXES.some((p) => path.startsWith(p))) continue;
    if (statSync(path).size > 2_000_000) continue;

    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (HEX.test(line))
        offenders.push(`${relative(process.cwd(), path)}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
}

for (const root of ROOTS) {
  try {
    walk(root);
  } catch {
    // A root that does not exist yet is not an error.
  }
}

if (offenders.length > 0) {
  process.stdout.write('Hex-literal check failed (docs/06 §11 — use semantic tokens):\n');
  for (const o of offenders.slice(0, 40)) process.stdout.write(`  - ${o}\n`);
  if (offenders.length > 40) process.stdout.write(`  … and ${offenders.length - 40} more\n`);
  process.exit(1);
}
process.stdout.write('Hex-literal check passed: colour is consumed through tokens only.\n');
