'use client';

import { useEffect } from 'react';

/**
 * Screen-level keyboard shortcuts.
 *
 * `CLAUDE.md` §4 makes the clinical and billing screens keyboard-first, and
 * `docs/06` §5.2 #33 requires the bindings to be *visible* — which is why every
 * screen here pairs this hook with a `KeyboardHintBar` built from the same list.
 * A shortcut nobody can discover is a shortcut nobody uses.
 *
 * Two guards, both learned from counters rather than from a spec:
 *
 *  - **Never fire while the user is typing.** A cashier keying a denomination
 *    count into a text field must not call the next patient because the sheet
 *    happens to bind `c`.
 *  - **Never fire while a modal is open.** A confirmation dialog exists to make
 *    somebody stop and read; a background hotkey that acts underneath it defeats
 *    the whole point of the friction.
 */
export interface Shortcut {
  /** `KeyboardEvent.key`, matched case-insensitively for letters. */
  readonly key: string;
  readonly alt?: boolean;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  /** Shown in the hint bar and the `?` sheet. */
  readonly label: string;
  /** Rendered chips, e.g. `['F9']` or `['Alt', 'N']`. */
  readonly keys: readonly string[];
  readonly run: () => void;
  /** A shortcut whose action the session cannot perform is not bound at all. */
  readonly enabled?: boolean;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function modalIsOpen(): boolean {
  return document.querySelector('[role="dialog"],[role="alertdialog"]') !== null;
}

export function useShortcuts(shortcuts: readonly Shortcut[], active = true): void {
  useEffect(() => {
    if (!active) return undefined;

    const handler = (event: KeyboardEvent): void => {
      if (isTyping(event.target) || modalIsOpen()) return;
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

export function hintsOf(shortcuts: readonly Shortcut[]): readonly {
  readonly keys: readonly string[];
  readonly label: string;
}[] {
  return shortcuts
    .filter((shortcut) => shortcut.enabled !== false)
    .map((shortcut) => ({ keys: shortcut.keys, label: shortcut.label }));
}
