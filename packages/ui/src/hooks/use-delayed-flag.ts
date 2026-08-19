'use client';

import { useEffect, useState } from 'react';

/**
 * docs/06 §6.7 — "< 200 ms: nothing (avoid flicker); 200 ms – 3 s: skeleton".
 * Returns `true` only once `active` has held for `delayMs`, so a fast response never
 * flashes a skeleton.
 */
export function useDelayedFlag(active: boolean, delayMs = 200): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return undefined;
    }
    const timer = setTimeout(() => {
      setVisible(true);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [active, delayMs]);

  return visible;
}
