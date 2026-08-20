'use client';

import { Command as CommandPrimitive } from 'cmdk';
import { Search } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog.js';

/**
 * docs/06 §6.5 — the global palette: "scoped tabs (Patients · Beds · Bills · Orders ·
 * Actions · Settings), debounce 150 ms, min 2 chars, recent-first when empty".
 * Scoping and fetching belong to the consuming feature; this is the keyboard shell.
 */
export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>): React.JSX.Element {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-xl bg-layer-2 text-fg-default',
        className,
      )}
      {...props}
    />
  );
}

export interface CommandDialogProps extends ComponentProps<typeof Dialog> {
  /** Palette title, announced to screen readers. From the caller's i18n catalogue. */
  readonly title: string;
  readonly description: string;
  readonly closeLabel: string;
}

export function CommandDialog({
  title,
  description,
  closeLabel,
  children,
  ...props
}: CommandDialogProps): React.JSX.Element {
  return (
    <Dialog {...props}>
      <DialogContent closeLabel={closeLabel} className="p-0">
        <div className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </div>
        <Command>{children}</Command>
      </DialogContent>
    </Dialog>
  );
}

export function CommandInput({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Input>): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 border-b border-default px-3" data-slot="command-input-wrapper">
      <Search className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          'flex h-12 w-full bg-transparent text-md text-fg-default outline-none',
          'placeholder:text-fg-subtle disabled:text-fg-disabled',
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function CommandList({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.List>): React.JSX.Element {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn('max-h-80 overflow-y-auto overflow-x-hidden p-1', className)}
      {...props}
    />
  );
}

export function CommandEmpty({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Empty>): React.JSX.Element {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn('px-3 py-6 text-center text-sm text-fg-muted', className)}
      {...props}
    />
  );
}

export function CommandGroup({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Group>): React.JSX.Element {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        'overflow-hidden p-1',
        '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5',
        '[&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium',
        '[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em]',
        '[&_[cmdk-group-heading]]:text-fg-muted',
        className,
      )}
      {...props}
    />
  );
}

export function CommandItem({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Item>): React.JSX.Element {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-2',
        'text-md text-fg-default outline-none',
        'data-[selected=true]:bg-layer-3 data-[disabled=true]:text-fg-disabled',
        className,
      )}
      {...props}
    />
  );
}

export function CommandSeparator({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Separator>): React.JSX.Element {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn('-mx-1 my-1 h-px bg-default', className)}
      {...props}
    />
  );
}

/** docs/06 §5.1 `Kbd` — shortcut hints render as real keycaps, not as plain text. */
export function Kbd({ className, ...props }: ComponentProps<'kbd'>): React.JSX.Element {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-default',
        'bg-layer-3 px-1 font-mono text-3xs text-fg-muted',
        className,
      )}
      {...props}
    />
  );
}
