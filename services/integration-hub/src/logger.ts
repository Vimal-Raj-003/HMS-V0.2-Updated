/**
 * The service logger.
 *
 * `docs/04` §2 and CLAUDE.md §4: structured JSON, never `console.log`, and no
 * PHI. The redaction paths below are a second line of defence, not the first —
 * the first is that nothing in this service passes a payload to the logger at
 * all; `phi-redactor.ts` is what makes a payload loggable, and it is applied
 * before the value ever reaches a log call.
 */
import { pino, type Logger } from 'pino';
import type { AdapterLogger } from './adapter/types.js';

export function createLogger(level = process.env['LOG_LEVEL'] ?? 'info'): Logger {
  return pino({
    name: 'integration-hub',
    level,
    // Belt and braces: if a future adapter logs a config or a payload object by
    // accident, these keys never reach the transport.
    redact: {
      paths: [
        'payload',
        '*.payload',
        'body',
        '*.body',
        'secret',
        '*.secret',
        'secretRef',
        '*.secretRef',
        'credentials',
        '*.credentials',
        'authorization',
        '*.authorization',
        'headers.authorization',
      ],
      censor: '«redacted»',
    },
    base: { service: 'integration-hub' },
  });
}

/** A logger that discards everything. For unit tests, which assert behaviour, not output. */
export const silentLogger: AdapterLogger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});
