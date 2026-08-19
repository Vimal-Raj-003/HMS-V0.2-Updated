import { DeviceCredentialSchema, type DeviceCredential } from './pairing-contract';
import type { KeyValueStore } from '../../lib/storage';

export const DEVICE_CREDENTIAL_KEY = 'vims.tv.credential.v1';

/**
 * EN-018 §3.2.5: "on crash/reload the device restores the last board from local
 * storage using the cached token". This is what makes a power cut a non-event —
 * the board comes back on its own, with nobody in the building at 04:00.
 */
export function loadCredential(store: KeyValueStore): DeviceCredential | null {
  const raw = store.read(DEVICE_CREDENTIAL_KEY);
  if (raw === null) return null;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    store.remove(DEVICE_CREDENTIAL_KEY);
    return null;
  }
  const result = DeviceCredentialSchema.safeParse(parsedJson);
  if (!result.success) {
    // A half-written or hand-edited credential is worse than none: drop it and
    // show the pairing code rather than authenticating with rubbish.
    store.remove(DEVICE_CREDENTIAL_KEY);
    return null;
  }
  return result.data;
}

export function saveCredential(store: KeyValueStore, credential: DeviceCredential): void {
  store.write(DEVICE_CREDENTIAL_KEY, JSON.stringify(credential));
}

export function clearCredential(store: KeyValueStore): void {
  store.remove(DEVICE_CREDENTIAL_KEY);
}
