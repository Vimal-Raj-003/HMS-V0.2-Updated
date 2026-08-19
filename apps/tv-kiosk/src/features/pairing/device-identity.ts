import type { KeyValueStore } from '../../lib/storage';

export const DEVICE_ID_KEY = 'vims.tv.device-id.v1';

/**
 * A stable identity for the physical box, minted once and kept forever. It is not
 * a secret and carries nothing about the hospital: it exists so that IT can see
 * "the corridor box re-paired itself" rather than a new row every reboot.
 *
 * `Math.random` is banned (CLAUDE.md §4) and would be wrong here anyway — this
 * needs the CSPRNG.
 */
export function ensureDeviceId(store: KeyValueStore, crypto: Crypto): string {
  const existing = store.read(DEVICE_ID_KEY);
  if (existing !== null && existing.length > 0) return existing;
  const minted = mintDeviceId(crypto);
  store.write(DEVICE_ID_KEY, minted);
  return minted;
}

function mintDeviceId(crypto: Crypto): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Older Android WebViews expose `getRandomValues` but not `randomUUID`.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function describeScreen(screen: { width: number; height: number } | null): string {
  if (screen === null) return 'unknown';
  return `${screen.width}x${screen.height}`;
}
