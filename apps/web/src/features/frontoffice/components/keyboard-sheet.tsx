'use client';

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Kbd,
  KeyboardHintBar,
} from '@vims/ui';
import { useState } from 'react';
import type { Shortcut } from '../lib/shortcuts';
import { hintsOf } from '../lib/shortcuts';

/**
 * The bottom-docked shortcut strip and the sheet `?` opens (`docs/06` §5.2 #33).
 *
 * Both are built from the same `Shortcut[]` the screen actually binds, so the
 * documentation cannot drift from the behaviour — the failure mode of every
 * hand-written shortcut list is that it outlives the binding it describes.
 *
 * The bar hides itself on a touch-only device, where a shortcut strip is dead
 * pixels; the sheet stays reachable, because a tablet may still have a keyboard.
 */
export function ShortcutBar({
  shortcuts,
  label,
}: {
  readonly shortcuts: readonly Shortcut[];
  readonly label: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const hints = hintsOf(shortcuts);

  return (
    <>
      <KeyboardHintBar
        hints={hints}
        label={label}
        openSheetLabel="All shortcuts"
        onOpenSheet={() => {
          setOpen(true);
        }}
        className="mt-3 rounded-md"
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel="Close">
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              Every shortcut on this screen. They do nothing while you are typing in a field or while a
              confirmation is open.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <ul className="flex flex-col gap-2">
              {hints.map((hint) => (
                <li key={hint.label} className="flex items-center justify-between gap-4 text-sm">
                  <span className="text-fg-default">{hint.label}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {hint.keys.map((key) => (
                      <Kbd key={key}>{key}</Kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
