'use client';

import { useEffect, useState } from 'react';
import { cn } from '../lib/cn.js';
import { Kbd } from '../primitives/command.js';

/**
 * `KeyboardHintBar` — docs/06 §5.2 #33: "Bottom-docked contextual shortcut strip per
 * screen; `?` expands the full sheet; auto-hides on touch-only devices; reflects the
 * user's remapped keys."
 */
export interface KeyboardHint {
  /** Key sequence as the user has it mapped, e.g. `['Alt', 'R']`. */
  readonly keys: readonly string[];
  /** Already-localised action name. */
  readonly label: string;
}

export interface KeyboardHintBarProps {
  readonly hints: readonly KeyboardHint[];
  /** Accessible name of the strip, from the caller's i18n catalogue. */
  readonly label: string;
  /** Opened by `?` — docs/06 §6.1. */
  readonly onOpenSheet?: () => void;
  readonly openSheetLabel?: string;
  /**
   * Overrides the coarse-pointer auto-hide. Left undefined the bar hides itself on
   * touch-only devices, where a shortcut strip is dead pixels.
   */
  readonly visible?: boolean;
  readonly className?: string;
}

function usePointerIsFine(): boolean {
  const [fine, setFine] = useState(true);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(pointer: fine)');
    setFine(query.matches);
    const listener = (event: MediaQueryListEvent): void => {
      setFine(event.matches);
    };
    query.addEventListener('change', listener);
    return () => {
      query.removeEventListener('change', listener);
    };
  }, []);
  return fine;
}

export function KeyboardHintBar({
  hints,
  label,
  onOpenSheet,
  openSheetLabel,
  visible,
  className,
}: KeyboardHintBarProps): React.JSX.Element | null {
  const pointerIsFine = usePointerIsFine();
  const show = visible ?? pointerIsFine;

  useEffect(() => {
    if (onOpenSheet === undefined) return undefined;
    const handler = (event: KeyboardEvent): void => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if (event.key === '?' && !typing && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        onOpenSheet();
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
    };
  }, [onOpenSheet]);

  if (!show) return null;

  return (
    <div
      data-slot="keyboard-hint-bar"
      role="group"
      aria-label={label}
      className={cn(
        'flex h-7 w-full flex-wrap items-center gap-x-4 gap-y-1 border-t border-default',
        'bg-layer-1 px-3 text-2xs text-fg-muted',
        className,
      )}
    >
      {hints.map((hint) => (
        <span key={hint.label} className="inline-flex items-center gap-1">
          {hint.keys.map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
          <span>{hint.label}</span>
        </span>
      ))}
      {onOpenSheet === undefined ? null : (
        <button
          type="button"
          onClick={onOpenSheet}
          className="ms-auto inline-flex items-center gap-1 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <Kbd>?</Kbd>
          <span>{openSheetLabel ?? label}</span>
        </button>
      )}
    </div>
  );
}
