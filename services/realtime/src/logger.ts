import { pino, type DestinationStream, type Logger } from 'pino';

/**
 * The only output channel in this service. `CLAUDE.md` §4 bans `console.log`,
 * and `docs/04` §4 bans PHI in logs — so the gateway logs identifiers
 * (hospital, user, socket, room) and never a payload. A board diff can contain
 * a patient name; it must never reach a log line.
 */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  const options = {
    level,
    base: { service: 'vims-realtime' },
    // Defence in depth: even if a diff is ever passed by mistake, these keys go.
    redact: {
      paths: ['diff', 'payload', 'req.headers.authorization', 'handshake.auth.token', 'token'],
      censor: '[redacted]',
    },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
