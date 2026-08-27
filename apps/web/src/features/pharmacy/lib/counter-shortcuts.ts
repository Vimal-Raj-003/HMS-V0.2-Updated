'use client';

import { useEffect } from 'react';
import type { Shortcut } from '@/features/frontoffice/lib/shortcuts';

/**
 * The dispensing counter's keyboard, which the shared `useShortcuts` cannot
 * provide.
 *
 * ── The bug this exists to fix ──────────────────────────────────────────────
 *
 * `features/frontoffice/lib/shortcuts.ts` refuses to fire **any** shortcut while
 * focus is in an `input`, `textarea` or `select`. That guard is right where it
 * came from — a cashier keying a denomination count must not call the next
 * patient because the sheet happens to bind `c` — but it makes every shortcut on
 * this screen dead, because the scan field holds focus for the entire
 * transaction by design. `F8` and `F10` would simply never fire, and the
 * `KeyboardHintBar` would advertise keys that do nothing.
 *
 * ── The distinction that makes it safe ──────────────────────────────────────
 *
 * A function key is not text. `F1`–`F12` and `Escape` cannot be part of
 * anything a person is typing into a barcode field or a reason box, so binding
 * them while typing takes nothing away. A **letter** is text, and a letter
 * shortcut is refused here exactly as it is in the shared hook.
 *
 * The modal guard is kept unchanged and for the original reason: a confirmation
 * dialog exists to make somebody stop and read, and a background hotkey acting
 * underneath it defeats the whole point of the friction. That matters more here
 * than anywhere — the co-sign dialog is a dialog precisely so that the second
 * pharmacist has to look at it.
 *
 * `services/*` and the other features are outside this change's remit, so this
 * lives beside the screen that needs it rather than as an edit to
 * `frontoffice/lib/shortcuts.ts`. When that file grows an
 * `allowWhileTyping` option this becomes a one-line delegation.
 */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** `F1`–`F12` and `Escape`: keys that cannot be part of typed text. */
export function isNonTextKey(key: string): boolean {
  return key === 'Escape' || /^F([1-9]|1[0-2])$/u.test(key);
}

function modalIsOpen(): boolean {
  return document.querySelector('[role="dialog"],[role="alertdialog"]') !== null;
}

export function useCounterShortcuts(shortcuts: readonly Shortcut[], active = true): void {
  useEffect(() => {
    if (!active) return undefined;

    const handler = (event: KeyboardEvent): void => {
      if (modalIsOpen()) return;
      // A letter shortcut while typing is somebody's barcode. A function key
      // never is.
      if (isTextEntry(event.target) && !isNonTextKey(event.key)) return;

      for (const shortcut of shortcuts) {
        if (shortcut.enabled === false) continue;
        if (event.key.toLowerCase() !== shortcut.key.toLowerCase()) continue;
        if ((shortcut.alt ?? false) !== event.altKey) continue;
        if ((shortcut.ctrl ?? false) !== (event.ctrlKey || event.metaKey)) continue;
        if ((shortcut.shift ?? false) !== event.shiftKey) continue;
        event.preventDefault();
        shortcut.run();
        return;
      }
    };

    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
    };
  }, [shortcuts, active]);
}
