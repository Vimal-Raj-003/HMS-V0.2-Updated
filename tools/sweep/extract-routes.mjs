/**
 * Extracts every route from the API's controller decorators.
 *
 * One file may declare several `@Controller`s — `lab.controller.ts` has two and
 * `operations.controller.ts` has three — so the file is split on the decorator
 * rather than scanned once with the first prefix, which silently mis-attributed
 * twenty routes on the first attempt and made them look like 404s.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'services/api/src';
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.controller.ts')) files.push(p);
  }
})(ROOT);

const routes = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  // Split into one segment per @Controller, keeping the decorator that opens it.
  const marks = [...src.matchAll(/@Controller\(\s*(?:'([^']*)')?\s*\)/g)];
  if (marks.length === 0) continue;

  for (let i = 0; i < marks.length; i += 1) {
    const prefix = marks[i][1] ?? '';
    const from = marks[i].index;
    const to = i + 1 < marks.length ? marks[i + 1].index : src.length;
    const body = src.slice(from, to);

    const re = /@Permission\('([^']+)'\)|@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/g;
    let m;
    let perm = null;
    while ((m = re.exec(body)) !== null) {
      if (m[1]) {
        perm = m[1];
        continue;
      }
      const method = m[2].toUpperCase();
      const path = m[3] ?? '';
      const full = '/' + [prefix, path].filter(Boolean).join('/').replace(/\/+/g, '/');
      routes.push({ file: f, method, path: full, permission: perm });
      perm = null;
    }
  }
}
console.log(JSON.stringify(routes));
