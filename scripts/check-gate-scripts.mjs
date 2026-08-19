/**
 * Asserts that every workspace package containing a `src/` directory declares
 * REAL `build`, `lint`, `typecheck` and `test` scripts.
 *
 * Nine packages were scaffolded before they had source, and `tsc` cannot
 * typecheck an empty project at all (TS18003), so their build/typecheck scripts
 * were wrapped in `if [ -d src ]; then …; else echo …; fi` (decision D-21). That
 * guard is correct while a package is empty and dangerous once it is not: a
 * package could gain source and keep echoing instead of checking, and nothing
 * would fail. This closes that gap.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['apps', 'packages', 'services'];
const required = ['build', 'lint', 'typecheck', 'test'];
const problems = [];

for (const root of roots) {
  if (!existsSync(root)) continue;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    if (!existsSync(join(dir, 'src'))) continue; // still a scaffold; the guard is legitimate

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const scripts = manifest.scripts ?? {};

    for (const key of required) {
      const value = scripts[key];
      if (typeof value !== 'string' || value.length === 0) {
        problems.push(`${manifest.name}: has src/ but declares no "${key}" script`);
      } else if (value.includes('if [ -d src ]')) {
        problems.push(
          `${manifest.name}: "${key}" still uses the empty-package guard, but the package now has src/. Replace it with the real command.`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  process.stdout.write('Gate-script check failed:\n');
  for (const p of problems) process.stdout.write(`  - ${p}\n`);
  process.exit(1);
}
process.stdout.write('Gate-script check passed: every package with src/ declares real gate scripts.\n');
