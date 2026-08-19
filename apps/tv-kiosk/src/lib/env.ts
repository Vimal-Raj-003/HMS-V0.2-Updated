/**
 * Runtime configuration. Every value has a defensible default so that a freshly
 * flashed Android box with no environment at all still boots into the pairing
 * screen instead of a stack trace.
 */
export type TransportPreference = 'socket' | 'polling';

export interface KioskEnv {
  readonly apiBaseUrl: string;
  readonly realtimeUrl: string | null;
  /**
   * Polling is the default on purpose. `services/realtime` is optional, hospital
   * Wi-Fi and captive portals block WebSockets, and a board that polls every few
   * seconds is strictly better than one that freezes (EN-018 §3.3.4).
   */
  readonly transportPreference: TransportPreference;
  readonly pollIntervalMs: number;
  /** Amber "reconnecting / last updated" after this long without an update. */
  readonly staleAfterMs: number;
  /** Red, dimmed, "not live" after this long. EN-018 §3.6 default is 120 s. */
  readonly expiredAfterMs: number;
}

export interface RawKioskEnv {
  readonly apiUrl: string | undefined;
  readonly realtimeUrl: string | undefined;
  readonly transport: string | undefined;
  readonly pollIntervalMs: string | undefined;
  readonly staleAfterMs: string | undefined;
  readonly expiredAfterMs: string | undefined;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function trimmed(value: string | undefined): string | null {
  const out = value?.trim();
  return out === undefined || out.length === 0 ? null : out;
}

export function parseKioskEnv(raw: RawKioskEnv): KioskEnv {
  const realtimeUrl = trimmed(raw.realtimeUrl);
  // Asking for the socket without a URL to point it at is a misconfiguration, not
  // an instruction: fall back rather than fail.
  const wantsSocket = raw.transport?.trim().toLowerCase() === 'socket' && realtimeUrl !== null;

  return {
    apiBaseUrl: (trimmed(raw.apiUrl) ?? '/api/v1').replace(/\/+$/, ''),
    realtimeUrl,
    transportPreference: wantsSocket ? 'socket' : 'polling',
    pollIntervalMs: positiveInt(raw.pollIntervalMs, 3000),
    staleAfterMs: positiveInt(raw.staleAfterMs, 15_000),
    expiredAfterMs: positiveInt(raw.expiredAfterMs, 120_000),
  };
}

/**
 * Next inlines `process.env.NEXT_PUBLIC_*` only for literal member access, so the
 * reads have to be spelled out here rather than looped over.
 */
export function readKioskEnv(): KioskEnv {
  return parseKioskEnv({
    apiUrl: process.env.NEXT_PUBLIC_API_URL,
    realtimeUrl: process.env.NEXT_PUBLIC_REALTIME_URL,
    transport: process.env.NEXT_PUBLIC_TV_TRANSPORT,
    pollIntervalMs: process.env.NEXT_PUBLIC_TV_POLL_INTERVAL_MS,
    staleAfterMs: process.env.NEXT_PUBLIC_TV_STALE_MS,
    expiredAfterMs: process.env.NEXT_PUBLIC_TV_EXPIRED_MS,
  });
}
