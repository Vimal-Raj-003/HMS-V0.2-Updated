'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { systemClock, type Clock } from '../lib/clock';
import { createDeviceLog, type DeviceLog } from '../lib/device-log';
import { readKioskEnv, type KioskEnv } from '../lib/env';
import { createLocalStorageStore, type KeyValueStore } from '../lib/storage';
import { createBoardTransport } from '../features/board/create-transport';
import type { BoardTransport } from '../features/board/transport';
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
    };
  }, [overrides]);

  return <RuntimeConfigContext.Provider value={value}>{children}</RuntimeConfigContext.Provider>;
}

export function useRuntimeConfig(): RuntimeConfig {
  const value = useContext(RuntimeConfigContext);
  if (value === null) {
    throw new Error('useRuntimeConfig must be used inside <RuntimeConfigProvider>');
  }
  return value;
}
