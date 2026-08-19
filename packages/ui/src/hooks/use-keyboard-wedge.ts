'use client';

import { useEffect, useRef } from 'react';

/**
 * docs/06 §6.2 — keyboard-wedge barcode detection.
 *
 * "a burst of `keydown` events with **median inter-key interval < 30 ms**, length >= 6,
 * terminated by `Enter`/`Tab` within 300 ms → treat as a **scan**, not typing."
 *
 * Also §6.2: "Global scan works with **no focused field**… a focused free-text field
 * only receives the scan if it is marked `data-scan-target`." Both rules are here so
 * every scanning surface in the product behaves identically.
 */
export interface KeyboardWedgeOptions {
  /** Called with the decoded payload once a burst qualifies as a scan. */
  readonly onScan: (payload: string) => void;
  /** Median inter-key interval below which the burst is machine-typed. */
  readonly maxMedianIntervalMs?: number;
  readonly minLength?: number;
  /** How long a burst may pause before it is abandoned. */
  readonly terminatorTimeoutMs?: number;
  /** Device profile prefix (e.g. `~` for wristbands) stripped before dispatch. */
  readonly prefix?: string;
  readonly enabled?: boolean;
  /** Element the listener attaches to. Defaults to `document`. */
  readonly target?: Document | HTMLElement | null;
}

const DEFAULTS = {
  maxMedianIntervalMs: 30,
  minLength: 6,
  terminatorTimeoutMs: 300,
} as const;

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? Number.POSITIVE_INFINITY;
  const low = sorted[middle - 1] ?? 0;
  const high = sorted[middle] ?? 0;
  return (low + high) / 2;
}

/**
 * `true` when a keystroke must NOT be swallowed: the user is typing into a free-text
 * field that has not opted in with `data-scan-target`.
 */
function isProtectedTarget(element: EventTarget | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.dataset['scanTarget'] !== undefined) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useKeyboardWedge(options: KeyboardWedgeOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (options.enabled === false) return undefined;
    const node: Document | HTMLElement = options.target ?? document;

    let buffer: string[] = [];
    let timestamps: number[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;

    const reset = (): void => {
      buffer = [];
      timestamps = [];
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const scheduleAbandon = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(reset, optionsRef.current.terminatorTimeoutMs ?? DEFAULTS.terminatorTimeoutMs);
    };

    const handler = (event: Event): void => {
      if (!(event instanceof KeyboardEvent)) return;
      const current = optionsRef.current;
      const now = event.timeStamp;

      if (event.key === 'Enter' || event.key === 'Tab') {
        const intervals = timestamps.slice(1).map((value, index) => value - (timestamps[index] ?? value));
        const qualifies =
          buffer.length >= (current.minLength ?? DEFAULTS.minLength) &&
          median(intervals) < (current.maxMedianIntervalMs ?? DEFAULTS.maxMedianIntervalMs);
        if (qualifies) {
          // The burst belongs to the scanner, not to the form under the cursor.
          event.preventDefault();
          const raw = buffer.join('');
          const prefix = current.prefix;
          current.onScan(prefix !== undefined && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw);
        }
        reset();
        return;
      }

      if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) {
        reset();
        return;
      }

      // Typing into a real field must never be eaten; a burst there is abandoned.
      if (isProtectedTarget(event.target) && buffer.length === 0) {
        return;
      }

      buffer.push(event.key);
      timestamps.push(now);
      scheduleAbandon();
    };

    node.addEventListener('keydown', handler, true);
    return () => {
      node.removeEventListener('keydown', handler, true);
      reset();
    };
  }, [options.enabled, options.target]);
}
