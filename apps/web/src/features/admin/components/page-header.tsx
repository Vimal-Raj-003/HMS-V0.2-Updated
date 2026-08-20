import type { ReactNode } from 'react';

/**
 * `docs/06` §4.1: "one `PageHeader` (title, breadcrumb, primary action,
 * overflow), then content. **Only one primary button per header.**"
 *
 * `primaryAction` is a single node rather than a list so the rule is expressed in
 * the type rather than in a review comment; secondary controls go in `actions`.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  primaryAction,
  actions,
  meta,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly description: string;
  readonly primaryAction?: ReactNode;
  readonly actions?: ReactNode;
  readonly meta?: ReactNode;
}): React.JSX.Element {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-default pb-3">
      <div className="min-w-0">
        {eyebrow === undefined ? null : (
          <p className="font-display text-2xs uppercase tracking-[0.08em] text-fg-subtle">{eyebrow}</p>
        )}
        <h1 className="text-2xl font-semibold tracking-tight text-fg-default">{title}</h1>
        <p className="mt-1 max-w-[72ch] text-sm text-fg-muted">{description}</p>
        {meta === undefined ? null : <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {actions}
        {primaryAction}
      </div>
    </header>
  );
}
