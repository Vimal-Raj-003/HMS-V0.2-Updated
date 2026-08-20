'use client';

import { CloudOff, GitMerge, RefreshCw, SignalHigh, SignalLow } from 'lucide-react';
import { cn } from '../lib/cn.js';

/**
 * `OfflineBadge` — docs/06 §5.2 #34: "States: online · degraded (slow) · offline
 * (queued n) · syncing (n/m) · conflict (n). Click opens the offline queue with per-item
 * retry/discard and conflict resolution — never silently overwrites."
 *
 * `role="status"` per docs/06 §7 ("`role="status"` for the offline badge").
 */
export type ConnectivityState =
  | { readonly kind: 'online' }
  | { readonly kind: 'degraded' }
  | { readonly kind: 'offline'; readonly queued: number }
  | { readonly kind: 'syncing'; readonly done: number; readonly total: number }
  | { readonly kind: 'conflict'; readonly conflicts: number };

export interface OfflineBadgeLabels {
  readonly online: string;
  readonly degraded: string;
  readonly offline: (queued: number) => string;
  readonly syncing: (done: number, total: number) => string;
  readonly conflict: (conflicts: number) => string;
  /** Accessible name of the button that opens the queue. */
  readonly openQueue: string;
}

export interface OfflineBadgeProps {
  readonly state: ConnectivityState;
  readonly labels: OfflineBadgeLabels;
  readonly onOpenQueue?: () => void;
  readonly className?: string;
}

export function OfflineBadge({
  state,
  labels,
  onOpenQueue,
  className,
}: OfflineBadgeProps): React.JSX.Element {
  const presentation = ((): {
    readonly text: string;
    readonly tone: string;
    readonly icon: React.JSX.Element;
  } => {
    switch (state.kind) {
      case 'online':
        return {
          text: labels.online,
          tone: 'border-success-border bg-success-surface text-success-on-surface',
          icon: <SignalHigh className="size-3" aria-hidden="true" />,
        };
      case 'degraded':
        return {
          text: labels.degraded,
          tone: 'border-warning-border bg-warning-surface text-warning-on-surface',
          icon: <SignalLow className="size-3" aria-hidden="true" />,
        };
      case 'offline':
        return {
          text: labels.offline(state.queued),
          tone: 'border-danger-border bg-danger-surface text-danger-on-surface',
          icon: <CloudOff className="size-3" aria-hidden="true" />,
        };
      case 'syncing':
        return {
          text: labels.syncing(state.done, state.total),
          tone: 'border-info-border bg-info-surface text-info-on-surface',
          icon: <RefreshCw className="size-3" aria-hidden="true" />,
        };
      case 'conflict':
        return {
          text: labels.conflict(state.conflicts),
          tone: 'border-violet-border bg-violet-surface text-violet-on-surface',
          icon: <GitMerge className="size-3" aria-hidden="true" />,
        };
    }
  })();

  const content = (
    <>
      {presentation.icon}
      <span>{presentation.text}</span>
    </>
  );

  const shared = cn(
    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium',
    presentation.tone,
    className,
  );

  if (onOpenQueue === undefined) {
    return (
      <span data-slot="offline-badge" data-state={state.kind} role="status" className={shared}>
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      data-slot="offline-badge"
      data-state={state.kind}
      role="status"
      aria-label={`${presentation.text} — ${labels.openQueue}`}
      onClick={onOpenQueue}
      className={cn(
        shared,
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
      )}
    >
      {content}
    </button>
  );
}
