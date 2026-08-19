import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/cn.js';

/**
 * docs/06 §1.2.3 — "Colour is never the only signal. Every status carries icon + text
 * label + colour." `icon` is therefore a first-class prop and the label is children,
 * never a `title` attribute (§5.1: a tooltip is never the only source of information).
 */
export const badgeVariants = cva(
  cn(
    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5',
    'text-2xs font-medium whitespace-nowrap',
    '[&_svg]:size-3 [&_svg]:shrink-0',
  ),
  {
    variants: {
      tone: {
        neutral: 'bg-layer-3 text-fg-default border-default',
        accent: 'bg-accent-surface text-accent-on-surface border-accent-border',
        success: 'bg-success-surface text-success-on-surface border-success-border',
        warning: 'bg-warning-surface text-warning-on-surface border-warning-border',
        danger: 'bg-danger-surface text-danger-on-surface border-danger-border',
        info: 'bg-info-surface text-info-on-surface border-info-border',
        violet: 'bg-violet-surface text-violet-on-surface border-violet-border',
      },
      size: { sm: 'text-3xs px-1.5', md: '' },
    },
    defaultVariants: { tone: 'neutral', size: 'md' },
  },
);

export interface BadgeProps extends ComponentProps<'span'>, VariantProps<typeof badgeVariants> {
  /** Required corroborating glyph — status is never colour alone (docs/06 §1.2.3). */
  readonly icon?: ReactNode;
}

export function Badge({ className, tone, size, icon, children, ...props }: BadgeProps): React.JSX.Element {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ tone, size }), className)} {...props}>
      {icon}
      {children}
    </span>
  );
}
