/** CLI: writes `theme.generated.css`. Run with `pnpm --filter @vims/ui tokens:build`. */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderTokensCss } from './generate-css.js';

const target = fileURLToPath(new URL('./theme.generated.css', import.meta.url));
writeFileSync(target, renderTokensCss(), 'utf8');
process.stdout.write(`tokens: wrote ${target}\n`);
