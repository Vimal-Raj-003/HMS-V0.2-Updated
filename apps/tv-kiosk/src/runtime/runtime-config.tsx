'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { systemClock, type Clock } from '../lib/clock';
import { createDeviceLog, type DeviceLog } from '../lib/device-log';
import { readKioskEnv, type KioskEnv } from '../lib/env';
import { createLocalStorageStore, type KeyValueStore } from '../lib/storage';
import { createBoardTransport } from '../features/board/create-transport';
import type { BoardAudio } from '../features/board/board-contract';
import type { BoardTransport } from '../features/board/transport';
import {
  browserSpeechEngine,
  createSpeechSpeaker,
  silentSpeaker,
  type Speaker,
} from '../features/announce/speaker';
import { createHttpPairingClient } from '../features/pairing/http-pairing-client';
import type { DeviceCredential, PairingClient } from '../features/pairing/pairing-contract';

export const APP_VERSION = '0.1.0';

/**
 * Everything the runtime touches that is not pure. Injecting it as one object is
 * what lets the whole board — pairing, transport, staleness, burn-in — be driven
 * from a test with a fixed clock and a fake transport, with no network and no
 * timers hidden inside components.
 */
export interface RuntimeConfig {
  readonly clock: Clock;
  readonly env: KioskEnv;
  readonly storage: KeyValueStore;
  readonly log: DeviceLog;
  readonly pairingClient: PairingClient;
  readonly createTransport: (credential: DeviceCredential) => BoardTransport;
  readonly deviceKind: string;
  readonly appVersion: string;
  /**
   * How the board speaks. `silentSpeaker` where the platform has no speech
   * engine — the announcement still appears on screen, which EN-018 §3.4.4
   * requires of every announcement regardless of audio.
   */
  readonly speaker: Speaker;
  /**
   * Audio configuration to use when the snapshot does not carry its own.
   * `null` means the device was commissioned without audio, and the
   * authoritative `display_boards` setting has not arrived either.
   */
  readonly announceAudio: BoardAudio | null;
}

const RuntimeConfigContext = createContext<RuntimeConfig | null>(null);

export interface RuntimeConfigProviderProps {
  readonly overrides?: Partial<RuntimeConfig>;
  readonly children: ReactNode;
}

export function RuntimeConfigProvider(props: RuntimeConfigProviderProps): ReactNode {
  const { overrides, children } = props;
  const value = useMemo<RuntimeConfig>(() => {
    const clock = overrides?.clock ?? systemClock;
    const env = overrides?.env ?? readKioskEnv();
    const engine = browserSpeechEngine();
    return {
      clock,
      env,
      storage: overrides?.storage ?? createLocalStorageStore(),
      log: overrides?.log ?? createDeviceLog(() => clock.now()),
      pairingClient: overrides?.pairingClient ?? createHttpPairingClient(env.apiBaseUrl),
      createTransport:
        overrides?.createTransport ??
        ((credential: DeviceCredential) => createBoardTransport({ env, credential })),
      deviceKind: overrides?.deviceKind ?? 'smart_tv_browser',
      appVersion: overrides?.appVersion ?? APP_VERSION,
      speaker: overrides?.speaker ?? (engine === null ? silentSpeaker : createSpeechSpeaker({ engine })),
      // A `??` here would swallow a deliberate `announceAudio: null`, which is
      // how a test (and a board control bar, later) says "this board is muted".
      announceAudio:
        overrides !== undefined && 'announceAudio' in overrides
          ? (overrides.announceAudio ?? null)
          : audioFromEnv(env),
    };
  }, [overrides]);

  return <RuntimeConfigContext.Provider value={value}>{children}</RuntimeConfigContext.Provider>;
}

/**
 * The board's own audio setting, from the device's environment.
 *
 * Off unless the device was explicitly commissioned with audio: a screen that
 * has not been told it may speak does not speak. A snapshot carrying
 * `display_boards.audio_enabled` overrides this — the console is authoritative,
 * this is what lets a board be useful before the console knows about it.
 */
function audioFromEnv(env: KioskEnv): BoardAudio | null {
  if (!env.audioEnabled) return null;
  return {
    enabled: true,
    locales: [...env.announceLocales],
    repeatCount: env.announceRepeatCount,
  };
}

export function useRuntimeConfig(): RuntimeConfig {
  const value = useContext(RuntimeConfigContext);
  if (value === null) {
    throw new Error('useRuntimeConfig must be used inside <RuntimeConfigProvider>');
  }
  return value;
}
