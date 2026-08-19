'use client';

import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';

/** docs/06 §6.3 — the control is 20 px but the hit area is padded to >= 24 px (SC 2.5.8). */
export function Checkbox({
  className,
  ...props
}: ComponentProps<typeof CheckboxPrimitive.Root>): React.JSX.Element {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer size-5 shrink-0 rounded-sm border border-control bg-layer-1',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        'data-[state=checked]:bg-accent-solid data-[state=checked]:text-accent-on-solid data-[state=checked]:border-accent-border',
        'data-[state=indeterminate]:bg-accent-solid data-[state=indeterminate]:text-accent-on-solid',
        'disabled:cursor-not-allowed disabled:border-disabled disabled:bg-sunken',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        {props.checked === 'indeterminate' ? <Minus className="size-4" /> : <Check className="size-4" />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
