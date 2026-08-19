'use client';

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';

/**
 * docs/06 §5.1 — "Tooltip (never the only source of information)". Tooltips here
 * decorate; anything a clinician must know is rendered as text.
 */
export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>): React.JSX.Element {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'z-popover max-w-72 rounded-md bg-inverse px-2 py-1 text-xs text-fg-inverse shadow-e3',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
