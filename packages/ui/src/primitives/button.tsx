import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';

/**
 * docs/06 §5.1 — variants primary/secondary/ghost/danger/link, sizes sm/md/lg/touch.
 * §6.3 — desktop buttons are >= 32 px tall, touch targets >= 44 px.
 * §4.1 — "Only one primary button per header."
 */
export const buttonVariants = cva(
  cn(
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium',
    'transition-colors duration-fast ease-standard select-none',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
    'disabled:pointer-events-none disabled:text-fg-disabled disabled:bg-sunken disabled:border-disabled',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4',
  ),
  {
    variants: {
      variant: {
        primary: 'bg-accent-solid text-accent-on-solid hover:bg-accent-solid-hover',
        secondary: 'bg-layer-1 text-fg-default border border-control hover:bg-layer-3',
        ghost: 'bg-transparent text-fg-default hover:bg-layer-3',
        danger: 'bg-danger-solid text-danger-on-solid hover:bg-danger-solid-hover',
        link: 'bg-transparent text-fg-link underline underline-offset-4 hover:text-fg-link-hover',
      },
      size: {
        sm: 'h-8 px-3 text-sm',
        md: 'h-10 px-4 text-md',
        lg: 'h-11 px-5 text-lg',
        /** §6.3 gloved-hand / tablet: 52 px row height, >= 44 px target. */
        touch: 'h-13 min-h-11 px-6 text-lg',
      },
      block: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'secondary', size: 'md', block: false },
  },
);

export interface ButtonProps extends ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  /** Render the child element instead of a `<button>` (links, menu items). */
  readonly asChild?: boolean;
}

export function Button({
  className,
  variant,
  size,
  block,
  asChild = false,
  type,
  ...props
}: ButtonProps): React.JSX.Element {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, block }), className)}
      {...(asChild ? {} : { type: type ?? 'button' })}
      {...props}
    />
  );
}

export interface IconButtonProps extends ButtonProps {
  /**
   * docs/06 §7: "every icon-only button has an accessible name". It is a required
   * prop rather than an optional one so the type system enforces SC 4.1.2.
   */
  readonly label: string;
}

export function IconButton({ label, className, size, ...props }: IconButtonProps): React.JSX.Element {
  return (
    <Button
      aria-label={label}
      title={label}
      size={size}
      className={cn('px-0', size === 'touch' ? 'w-13' : size === 'sm' ? 'w-8' : 'w-10', className)}
      {...props}
    />
  );
}
