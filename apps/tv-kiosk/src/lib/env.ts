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
  /**
   * Whether this device may make noise, and in which languages.
   *
   * EN-018 §4 holds the authoritative setting on `display_boards`
   * (`audio_enabled`, `tts_languages`), and a snapshot that carries an `audio`
   * block overrides this. It exists because a board is commissioned physically
   * — somebody hangs a screen on a wall in Coimbatore and knows it needs Tamil —
   * and that must not have to wait for the console. Off by default: a screen
   * that has not been told it may speak does not speak.
   */
  readonly audioEnabled: boolean;
  /**
   * Ordered locale codes for announcements. `en-IN` is prepended regardless
   * (docs/06 §8 makes it the fallback that cannot be turned off), so this is
   * really "which Indian language, in addition to English".
   */
  readonly announceLocales: readonly string[];
  /** EN-018 §3.4.3: 2 for a large hall. */
  readonly announceRepeatCount: number;
}

export interface RawKioskEnv {
  readonly apiUrl: string | undefined;
  readonly realtimeUrl: string | undefined;
  readonly transport: string | undefined;
  readonly pollIntervalMs: string | undefined;
  readonly staleAfterMs: string | undefined;
  readonly expiredAfterMs: string | undefined;
  /**
   * Optional so that a caller written before audio existed still compiles —
   * and, more to the point, so that "no audio configuration" and "audio off"
   * are the same thing rather than two states a board can be in.
   */
  readonly audio?: string | undefined;
  readonly locales?: string | undefined;
  readonly repeatCount?: string | undefined;
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

/** Opt-in, and only for a value that unambiguously says yes. */
function flag(value: string | undefined): boolean {
  const normalised = value?.trim().toLowerCase();
  return normalised === 'on' || normalised === 'true' || normalised === '1';
}

/** `ta` or `ta,hi` — whitespace and empties dropped, order preserved. */
function localeList(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
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
    audioEnabled: flag(raw.audio),
    announceLocales: localeList(raw.locales),
    announceRepeatCount: Math.min(3, positiveInt(raw.repeatCount, 1)),
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
    audio: process.env.NEXT_PUBLIC_TV_AUDIO,
    locales: process.env.NEXT_PUBLIC_TV_LOCALES,
    repeatCount: process.env.NEXT_PUBLIC_TV_ANNOUNCE_REPEAT,
  });
}
