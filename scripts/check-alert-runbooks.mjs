/**
 * Fails if any Prometheus alert lacks a runbook, a severity, or a routing target.
 *
 * `docs/10` §7 states it plainly: "an alert without a linked runbook fails CI".
 * The reason is operational, not bureaucratic — a page at 03:00 reading only
 * "Error rate high" costs the responder the first ten minutes working out what
 * to look at, and in a hospital those are the ten minutes that matter.
 *
 * It also checks that each `runbook_url` corresponds to a file in
 * `infra/runbooks/`, so the link cannot rot into a 404 without the build
 * noticing.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const RULES_DIR = join('infra', 'observability', 'alerts');
const RUNBOOK_DIR = join('infra', 'runbooks');
const REQUIRED_ANNOTATIONS = ['summary', 'runbook_url'];
const REQUIRED_LABELS = ['severity', 'pages'];
const VALID_SEVERITIES = new Set(['P1', 'P2', 'P3']);

const problems = [];

if (!existsSync(RULES_DIR)) {
  process.stdout.write(`No alert rules directory at ${RULES_DIR}; nothing to check.\n`);
  process.exit(0);
}

const runbooks = existsSync(RUNBOOK_DIR)
  ? new Set(readdirSync(RUNBOOK_DIR).map((f) => basename(f, '.md')))
  : new Set();

for (const file of readdirSync(RULES_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))) {
  const path = join(RULES_DIR, file);
  const lines = readFileSync(path, 'utf8').split('\n');

  // A deliberately small parser: these files have a fixed, shallow shape, and a
  // YAML dependency for one check is a poor trade.
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const match = /^\s*-\s*alert:\s*(\S+)/.exec(line);
    if (match) {
      blocks.push({ name: match[1], line: i + 1, body: [] });
      continue;
    }
    const open = blocks[blocks.length - 1];
    if (open) open.body.push(line);
  }

  const seen = new Set();
  for (const block of blocks) {
    const body = block.body.join('\n');
    const where = `${path}:${block.line} (${block.name})`;

    if (seen.has(block.name)) problems.push(`${where}: duplicate alert name`);
    seen.add(block.name);

    for (const key of REQUIRED_ANNOTATIONS) {
      if (!new RegExp(`\\b${key}\\s*:`).test(body)) problems.push(`${where}: missing annotation "${key}"`);
    }
    for (const key of REQUIRED_LABELS) {
      if (!new RegExp(`\\b${key}\\s*:`).test(body)) problems.push(`${where}: missing label "${key}"`);
    }

    const severity = /\bseverity\s*:\s*([A-Z0-9]+)/.exec(body)?.[1];
    if (severity && !VALID_SEVERITIES.has(severity)) {
      problems.push(`${where}: severity "${severity}" is not one of P1/P2/P3`);
    }

    // YAML allows the value bare, single-quoted or double-quoted, and this file
    // uses single quotes throughout. Matching only `"` captured the closing `'`
    // into the slug, so every one of the sixteen runbooks — all of which exist —
    // was reported missing, and this check failed CI on a parsing bug rather
    // than on anything about the alert rules.
    const runbook = /runbook_url\s*:\s*(['"]?)([^'"\n]+)\1/.exec(body)?.[2]?.trim();
    if (runbook) {
      const slug = runbook.replace(/\/+$/, '').split('/').pop() ?? '';
      // Deliberately NOT guarded on `runbooks.size > 0`. An empty runbook
      // directory must fail loudly: a check that passes because there is
      // nothing to check is worse than no check, because it reports green.
      if (!runbooks.has(slug)) {
        problems.push(`${where}: runbook_url points at "${slug}" but infra/runbooks/${slug}.md does not exist`);
      }
    }
  }
}

if (problems.length > 0) {
  process.stdout.write('Alert-rule check failed (docs/10 §7):\n');
  for (const p of problems) process.stdout.write(`  - ${p}\n`);
  process.exit(1);
}
process.stdout.write('Alert-rule check passed: every alert has a severity, a routing target and a runbook that exists.\n');
