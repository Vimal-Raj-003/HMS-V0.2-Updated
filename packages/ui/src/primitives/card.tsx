import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';

/**
 * docs/06 §2.1 — light theme: cards sit on a hairline border, shadow only for
 * floating layers. §2.2 — dark theme: cards are a visibly separated plane
 * (`--bg-layer-2`) with a hairline and no shadow.
 */
export function Card({ className, ...props }: ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="card"
      className={cn('rounded-lg border border-default bg-layer-2 text-fg-default', className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="card-header"
      className={cn('flex flex-col gap-1 border-b border-default px-4 py-3', className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<'h3'>): React.JSX.Element {
  return (
    <h3
      data-slot="card-title"
      className={cn('text-xl font-semibold text-fg-default', className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>): React.JSX.Element {
  return <p data-slot="card-description" className={cn('text-sm text-fg-muted', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<'div'>): React.JSX.Element {
  return <div data-slot="card-content" className={cn('px-4 py-3', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="card-footer"
      className={cn('flex items-center gap-2 border-t border-default px-4 py-3', className)}
      {...props}
    />
  );
}
