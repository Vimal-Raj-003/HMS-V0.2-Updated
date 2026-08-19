import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';

/**
 * docs/06 §5.2 #37 — "Match final layout metrics exactly (no layout shift, CLS 0).
 * Shown only after 200 ms of loading; below 200 ms show nothing." The 200 ms delay is
 * the caller's job (`useDelayedFlag`); this is the shape only.
 *
 * `aria-hidden` because the loading state is announced once by the container's
 * `role="status"`, not once per placeholder bar.
 */
export function Skeleton({ className, ...props }: ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('animate-pulse rounded-sm bg-sunken', className)}
      {...props}
    />
  );
}
