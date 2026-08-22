'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * A value the counter remembers between shifts — the doctor whose book this desk
 * opens, the queue this counter calls from, the drawer it operates.
 *
 * It exists because Phase 1's API has **no listing endpoint for master data**:
 * there is no `GET /doctors`, no `GET /queues` and no `GET /cash/counters`, so a
 * screen cannot offer a picker built from the server. Making the clerk paste a
 * UUID once per session would be unusable; making them paste it once ever is
 * merely bad, and it is what this turns into. When the master-data endpoints
 * land, the recents list becomes a convenience on top of a real picker rather
 * than the only way in.
 *
 * Keys are namespaced by hospital so a group administrator switching tenants in
 * one browser does not inherit the other tenant's counter — the same reason the
 * query cache keys carry `hospitalId`.
 *
 * Nothing clinical or financial is stored: an identifier of a queue or a counter
 * is not PHI, and no amount, name or token ever goes in here.
 */

function storageKey(hospitalId: string, name: string): string {
  return `vims.frontoffice.${hospitalId}.${name}`;
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Private mode, a disabled store, or a quota error. A remembered convenience
    // is never worth breaking the screen for.
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    if (value === '') window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Ignored for the same reason.
  }
}

/**
 * `useState` whose initial value is read from storage **after** mount.
 *
 * Reading during render would make the server-rendered HTML and the first client
 * render disagree, which React reports as a hydration error and which, on this
 * app, would blank the screen a receptionist is mid-registration on.
 */
export function useRemembered(
  hospitalId: string,
  name: string,
  fallback = '',
): readonly [string, (next: string) => void, boolean] {
  const key = storageKey(hospitalId, name);
  const [value, setValue] = useState(fallback);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    const stored = read(key);
    if (stored !== null && stored !== '') setValue(stored);
    setRestored(true);
  }, [key]);

  const update = useCallback(
    (next: string) => {
      setValue(next);
      write(key, next);
    },
    [key],
  );

  return [value, update, restored];
}
