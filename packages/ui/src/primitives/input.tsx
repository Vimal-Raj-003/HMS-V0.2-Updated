import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';

/**
 * docs/06 §6.4 — validation errors sit under the field with a glyph; the control
 * itself only advertises the error state (`aria-invalid`) and points at the message.
 * §6.3 — 40 px default, 52 px on coarse pointers.
 */
export const inputClassName = cn(
  'flex h-10 w-full rounded-md border border-control bg-layer-1 px-3 py-2',
  'text-md text-fg-default placeholder:text-fg-subtle',
  'transition-colors duration-fast ease-standard',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
  'disabled:cursor-not-allowed disabled:bg-sunken disabled:text-fg-disabled disabled:border-disabled',
  'aria-[invalid=true]:border-danger-border aria-[invalid=true]:outline-danger-border',
  '[[data-density=touch]_&]:h-13 [[data-density=touch]_&]:text-lg',
);

export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>): React.JSX.Element {
  return <input data-slot="input" type={type} className={cn(inputClassName, className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>): React.JSX.Element {
  return (
    <textarea
      data-slot="textarea"
      className={cn(inputClassName, 'h-auto min-h-20 resize-y', className)}
      {...props}
    />
  );
}
