import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/button.js';

/**
 * `EmptyState` — docs/06 §5.2 #36: "Illustration-free: icon + one-line cause + one-line
 * next action + primary button. Must be specific ('No patients waiting — next
 * appointment 10:30', never 'No data')."
 *
 * `cause` and `nextAction` are separate required props precisely so a caller cannot
 * ship a single vague sentence.
 */
export interface EmptyStateProps {
  readonly icon?: ReactNode;
  /** Why the area is empty, in ward language. */
  readonly cause: string;
  /** What the user should do next. */
  readonly nextAction: string;
  readonly action?: { readonly label: string; readonly onSelect: () => void };
  readonly className?: string;
}

export function EmptyState({
  icon,
  cause,
  nextAction,
  action,
  className,
}: EmptyStateProps): React.JSX.Element {
  return (
    <div
      data-slot="empty-state"
      role="status"
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-strong',
        'bg-layer-1 px-6 py-10 text-center',
        className,
      )}
    >
      {icon === undefined ? null : (
        <span aria-hidden="true" className="text-fg-subtle [&_svg]:size-6">
          {icon}
        </span>
      )}
      <p className="text-md font-medium text-fg-default">{cause}</p>
      <p className="text-sm text-fg-muted">{nextAction}</p>
      {action === undefined ? null : (
        <Button variant="primary" size="sm" className="mt-2" onClick={action.onSelect}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
