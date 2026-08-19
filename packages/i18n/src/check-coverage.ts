/**
 * `pnpm --filter @vims/i18n coverage:check`
 *
 * Reads the catalogue files **from disk** rather than through the compiled
 * registry, so that a file that exists but was never wired into
 * `catalogues.ts` — the failure mode that silently ships an English screen —
 * is caught too. Exits non-zero on any failure so CI stops.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import type { MessageTree } from './catalogues.js';
import { computeCoverage, formatCoverageReport } from './coverage.js';
import { LOCALE_CODES, isLocaleCode, type LocaleCode } from './locales.js';

const messageTreeSchema: z.ZodType<MessageTree> = z.lazy(() =>
  z.record(z.string(), z.union([z.string(), messageTreeSchema])),
);

const messagesDir = fileURLToPath(new URL('./messages/', import.meta.url));

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

function main(): number {
  const files = readdirSync(messagesDir).filter((name) => name.endsWith('.json'));
  const catalogues = new Map<LocaleCode, MessageTree>();
  const problems: string[] = [];

  for (const file of files) {
    const code = file.slice(0, -'.json'.length);
    if (!isLocaleCode(code)) {
      problems.push(
        `${file}: "${code}" is not part of the locale superset (D-13: ${LOCALE_CODES.join(', ')}). Delete it or add an ADR.`,
      );
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(`${messagesDir}${file}`, 'utf8'));
    } catch (error) {
      problems.push(`${file}: not valid JSON — ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const result = messageTreeSchema.safeParse(parsed);
    if (!result.success) {
      problems.push(`${file}: not a valid message tree — ${result.error.issues[0]?.message ?? 'unknown'}`);
      continue;
    }
    catalogues.set(code, result.data);
  }

  for (const locale of LOCALE_CODES) {
    if (!catalogues.has(locale)) {
      problems.push(`${locale}.json is missing — every locale in the superset needs a catalogue file.`);
    }
  }

  const report = computeCoverage({ catalogues });
  write(formatCoverageReport(report, problems));

  return report.ok && problems.length === 0 ? 0 : 1;
}

process.exitCode = main();
