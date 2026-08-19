'use client';

import { useEffect, useState } from 'react';
import type { Clock } from '../lib/clock';

/**
 * The current time, ticking. It starts as `null` so the server-rendered HTML has
 * no clock in it — a board that hydrates with a mismatched second would throw a
 * hydration error on every boot, which on an unattended screen means a blank TV.
 */
export function useNow(clock: Clock, intervalMs: number): Date | null {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(clock.now());
    const timer = setInterval(() => {
      setNow(clock.now());
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [clock, intervalMs]);

  return now;
}
