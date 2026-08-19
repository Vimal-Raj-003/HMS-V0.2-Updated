import type { ComponentProps } from 'react';
import { cn } from '../lib/cn.js';

/**
 * docs/06 §2.1 — "Data tables are borderless with zebra-free row separators."
 * §9.A — sticky header and first column; virtualisation and cursor pagination are the
 * caller's concern (TanStack Table), this is the styled semantic shell.
 *
 * The scroll container carries `tabindex=0` and a label so a keyboard-only user can
 * scroll a wide worklist (WCAG 2.2 SC 2.1.1).
 */
export interface TableProps extends ComponentProps<'table'> {
  /** Accessible name of the scrollable region, from the caller's i18n catalogue. */
  readonly scrollRegionLabel: string;
}

export function Table({ className, scrollRegionLabel, ...props }: TableProps): React.JSX.Element {
  return (
    <div
      className="relative w-full overflow-auto"
      role="region"
      aria-label={scrollRegionLabel}
      tabIndex={0}
    >
      <table
        data-slot="table"
        className={cn('w-full caption-bottom border-collapse text-sm', className)}
        {...props}
      />
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>): React.JSX.Element {
  return (
    <thead
      data-slot="table-header"
      className={cn('sticky top-0 z-sticky bg-layer-1 [&_tr]:border-b [&_tr]:border-default', className)}
      {...props}
    />
  );
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>): React.JSX.Element {
  return <tbody data-slot="table-body" className={cn('', className)} {...props} />;
}

export function TableFooter({ className, ...props }: ComponentProps<'tfoot'>): React.JSX.Element {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn('border-t border-default bg-layer-3 font-medium', className)}
      {...props}
    />
  );
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>): React.JSX.Element {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'border-b border-default transition-colors duration-fast',
        'hover:bg-layer-3 data-[state=selected]:bg-accent-surface',
        // docs/06 §9.A — "overdue rows carry a left rule not a background".
        'data-[critical=true]:border-s-[3px] data-[critical=true]:border-s-danger-border',
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: ComponentProps<'th'>): React.JSX.Element {
  return (
    <th
      data-slot="table-head"
      scope="col"
      className={cn('h-10 px-3 text-start align-middle text-xs font-medium text-fg-muted', className)}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentProps<'td'>): React.JSX.Element {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        'px-3 py-2 align-middle text-fg-default',
        '[[data-density=compact]_&]:py-1 [[data-density=touch]_&]:py-4',
        className,
      )}
      {...props}
    />
  );
}

export function TableCaption({ className, ...props }: ComponentProps<'caption'>): React.JSX.Element {
  return (
    <caption data-slot="table-caption" className={cn('mt-2 text-xs text-fg-muted', className)} {...props} />
  );
}
