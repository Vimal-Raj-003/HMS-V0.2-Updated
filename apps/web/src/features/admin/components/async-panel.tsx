'use client';

import { SkeletonList, useDelayedFlag } from '@vims/ui';
import type { ReactNode } from 'react';
import { ProblemCard } from './problem-card';

/**
 * The one place the four states of a data panel are decided (`docs/06` §6.7):
 *
 *  - **under 200 ms** — nothing at all, because a skeleton that flashes for one
 *    frame reads as a glitch;
 *  - **200 ms to 3 s** — a skeleton matching the final row metrics, so the layout
 *    does not shift when the data lands (CLS 0);
 *  - **error** — the problem card, with its reference;
 *  - **empty** — the caller's `EmptyState`, which must name a cause and a next
 *    action rather than saying "No data".
 *
 * Stale data stays on screen during a background refetch — §6.7 again: "never
 * blank a chart to reload it".
 */
export function AsyncPanel({
  loading,
  error,
  isEmpty,
  empty,
  onRetry,
  skeletonLabel,
  skeletonRows = 8,
  skeletonColumns,
  children,
}: {
  readonly loading: boolean;
  readonly error: unknown;
  readonly isEmpty: boolean;
  readonly empty: ReactNode;
  readonly onRetry?: () => void;
  readonly skeletonLabel: string;
  readonly skeletonRows?: number;
  readonly skeletonColumns?: readonly number[];
  readonly children: ReactNode;
}): React.JSX.Element | null {
  const showSkeleton = useDelayedFlag(loading);

  if (error !== null && error !== undefined) {
    return <ProblemCard error={error} {...(onRetry === undefined ? {} : { onRetry })} />;
  }
  if (loading) {
    return showSkeleton ? (
      <SkeletonList
        label={skeletonLabel}
        rows={skeletonRows}
        {...(skeletonColumns === undefined ? {} : { columns: skeletonColumns })}
      />
    ) : null;
  }
  if (isEmpty) return <>{empty}</>;
  return <>{children}</>;
}
