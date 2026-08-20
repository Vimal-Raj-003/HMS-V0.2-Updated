import { pino, type Logger } from 'pino';

/**
 * The worker's process logger.
 *
 * `CLAUDE.md` §4 and `docs/04` §7 are the same instruction: structured JSON,
 * never `console.log`, and **no PHI**. This process is the one most likely to
 * break that rule by accident, because the objects it handles — an outbox
 * payload, a print job envelope, an audit row's `data` — are literally the
 * patient record. So two mechanisms apply, in this order:
 *
 *  1. **Nothing passes a payload to a log call.** Job logs carry identifiers,
 *     counts and durations. `printJobLogContext()` in `print/logger.ts` is the
 *     allow-list for the print path and this module is the same discipline for
 *     everything else.
 *  2. **`redact` removes the known-PHI paths anyway**, so a future call site
 *     that hands over a whole row still cannot emit it. `remove: true` deletes
 *     the key rather than writing `[Redacted]`, because a redaction marker in a
 *     log line still tells an attacker which rows contained what.
 */
const PHI_REDACT_PATHS = [
  'payload',
  '*.payload',
  'data',
  '*.data',
  'row',
  '*.row',
  'context',
  '*.context',
  'patientName',
  '*.patientName',
  'patientId',
  '*.patientId',
  'uhid',
  '*.uhid',
  'phone',
  '*.phone',
  'email',
  '*.email',
  'html',
  '*.html',
];

export function createLogger(level: string): Logger {
  return pino({
    name: 'worker',
    level,
    base: { service: 'vims-worker' },
    redact: { paths: PHI_REDACT_PATHS, remove: true },
  });
}

/**
 * The one place a bare stderr write is honest: a boot failure before the logger
 * exists (a bad env is the usual cause). Buffering it would reproduce defect 3
 * of the 2026-08-19 session — a process that exits having printed nothing.
 */
export function writeBootFailure(event: string, error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({
      level: 'fatal',
      service: 'vims-worker',
      event,
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
}
