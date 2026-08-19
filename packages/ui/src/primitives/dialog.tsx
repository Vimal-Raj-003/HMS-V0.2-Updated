'use client';

import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';

/**
 * docs/06 §6.8:
 *   - `Dialog`      — "a decision that needs the user's full attention with a
 *                     reversible outcome. Focus trap, ESC + click-outside close."
 *   - `AlertDialog` — the **hard stop**: "No ESC, no click-outside, no close X,
 *                     explicit reason, sometimes a second person; primary action is
 *                     the *safe* one and destructive continue is `danger`."
 * The two are deliberately different components so a soft stop can never be styled or
 * behave like a hard stop (§1.2.2 — alert fatigue is a safety defect).
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const overlayClassName = 'fixed inset-0 z-scrim bg-overlay-scrim';

const panelClassName = cn(
  'fixed inset-inline-start-1/2 top-1/2 z-dialog w-[min(40rem,calc(100vw-2rem))]',
  '-translate-x-1/2 -translate-y-1/2 rtl:translate-x-1/2',
  'max-h-[calc(100vh-4rem)] overflow-y-auto',
  'rounded-xl border border-default bg-layer-2 text-fg-default shadow-e4',
);

export interface DialogContentProps extends ComponentProps<typeof DialogPrimitive.Content> {
  /** Accessible name of the close button, from the caller's i18n catalogue. */
  readonly closeLabel: string;
}

export function DialogContent({
  className,
  children,
  closeLabel,
  ...props
}: DialogContentProps): React.JSX.Element {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlayClassName} />
      <DialogPrimitive.Content data-slot="dialog-content" className={cn(panelClassName, className)} {...props}>
        {children}
        <DialogPrimitive.Close
          aria-label={closeLabel}
          className={cn(
            'absolute inset-inline-end-3 top-3 rounded-md p-1 text-fg-muted',
            'hover:bg-layer-3 hover:text-fg-default',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          )}
        >
          <X className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<'div'>): React.JSX.Element {
  return <div data-slot="dialog-header" className={cn('flex flex-col gap-1 p-4 pe-12', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="dialog-footer"
      // §6.8 — "primary action right" in LTR, which `justify-end` mirrors correctly in RTL.
      className={cn('flex flex-wrap items-center justify-end gap-2 border-t border-default p-4', className)}
      {...props}
    />
  );
}

export function DialogTitle({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Title>): React.JSX.Element {
  return (
    <DialogPrimitive.Title data-slot="dialog-title" className={cn('text-xl font-semibold', className)} {...props} />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>): React.JSX.Element {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-md text-fg-muted', className)}
      {...props}
    />
  );
}

export function DialogBody({ className, ...props }: ComponentProps<'div'>): React.JSX.Element {
  return <div data-slot="dialog-body" className={cn('flex flex-col gap-3 px-4 pb-4', className)} {...props} />;
}

// ── hard stop ────────────────────────────────────────────────────────────────

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
export const AlertDialogAction = AlertDialogPrimitive.Action;
export const AlertDialogCancel = AlertDialogPrimitive.Cancel;

/**
 * A hard stop. ESC and click-outside are suppressed, there is no close affordance, and
 * the danger border is part of the contract (docs/06 §1.2.2). `role="alertdialog"` and
 * the focus trap come from Radix.
 */
export function AlertDialogContent({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Content>): React.JSX.Element {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay className={overlayClassName} />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        data-hard-stop="true"
        onEscapeKeyDown={(event) => {
          event.preventDefault();
        }}
        className={cn(panelClassName, 'border-2 border-danger-border shadow-e5', className)}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  );
}

export function AlertDialogTitle({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Title>): React.JSX.Element {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn('text-xl font-semibold text-danger-fg', className)}
      {...props}
    />
  );
}

export function AlertDialogDescription({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Description>): React.JSX.Element {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn('text-md text-fg-default', className)}
      {...props}
    />
  );
}
