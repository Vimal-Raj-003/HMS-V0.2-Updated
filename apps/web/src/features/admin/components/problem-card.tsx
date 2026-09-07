'use client';

import { getEnforcementPoint } from '@vims/contracts';
import { TriangleAlert, ShieldAlert } from '@/lib/icons';
import { Button } from '@vims/ui';
import { ApiProblem } from '@/lib/api';

/**
 * A failed request, rendered the way `docs/06` §1.1 heuristic 9 requires:
 * "what happened, what it means clinically/financially, what to do next, **and
 * the reference id for the helpdesk**".
 *
 * The reference is the reason this component exists rather than a `toast('Failed')`.
 * It is the trace id of the exact request, and it is the only thing a user at a
 * counter can hand to IT that turns "the screen broke" into one findable log line.
 */
export function ProblemCard({
  error,
  onRetry,
  retryLabel = 'Try again',
}: {
  readonly error: unknown;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
}): React.JSX.Element {
  const problem = error instanceof ApiProblem ? error : null;
  const title = problem?.problem.title ?? 'This did not load';
  const detail =
    problem?.problem.detail ??
    'The request did not complete. Nothing was changed, so it is safe to try again.';
  const nextAction = problem?.problem.nextAction ?? null;
  const reference = problem?.reference ?? 'no-reference';

  return (
    <div
      role="alert"
      data-testid="problem-card"
      className="rounded-lg border border-danger-border bg-danger-surface p-4"
    >
      <p className="flex items-center gap-2 text-md font-medium text-danger-on-surface">
        <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
        {title}
      </p>
      <p className="mt-1 text-sm text-danger-on-surface">{detail}</p>
      {nextAction === null ? null : <p className="mt-1 text-sm text-danger-on-surface">{nextAction}</p>}
      <p className="mt-2 font-mono text-xs text-fg-muted">
        Reference: <span data-testid="problem-reference">{reference}</span>
      </p>
      {onRetry === undefined ? null : (
        <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}

/**
 * `docs/06` §6.7: a permission denial explains "the missing permission key in
 * plain words + 'Request access'". It never pretends the screen does not exist,
 * because a user who reached it followed a link somebody gave them, and silence
 * sends them to borrow a colleague's password instead.
 */
export function PermissionDenied({
  permission,
  inPlainWords,
}: {
  readonly permission: string;
  readonly inPlainWords: string;
}): React.JSX.Element {
  return (
    <div
      role="status"
      data-testid="permission-denied"
      className="mx-auto max-w-[60ch] rounded-lg border border-strong bg-layer-1 p-6 text-center"
    >
      <ShieldAlert className="mx-auto size-6 text-fg-subtle" aria-hidden="true" />
      <p className="mt-2 text-md font-medium text-fg-default">You do not have access to this screen</p>
      <p className="mt-1 text-sm text-fg-muted">{inPlainWords}</p>
      <p className="mt-3 font-mono text-xs text-fg-subtle">
        Missing permission: <span data-testid="missing-permission">{permission}</span>
      </p>
      <p className="mt-3 text-sm text-fg-muted">
        Ask your hospital administrator to raise an access request for this permission. Quote the key above —
        it is the exact thing they need to grant.
      </p>
    </div>
  );
}

/**
 * The module this screen belongs to is not in the hospital's plan.
 *
 * Deliberately a different state from `PermissionDenied`, with different words
 * and a different next step: "ask your administrator for access" sends somebody
 * on a fruitless errand when the answer is commercial. The message comes from
 * the entitlement catalogue, which is written in plain language for exactly
 * this — `EN-040 §3.2`: never "SKU", never "entitlement".
 *
 * Reached only by typing a URL: the navigation and the palette do not offer a
 * screen in an unlicensed module at all.
 */
export function ModuleNotLicensed({ entitlement }: { readonly entitlement: string }): React.JSX.Element {
  const point = getEnforcementPoint(entitlement);

  return (
    <div
      role="status"
      data-testid="module-not-licensed"
      className="mx-auto max-w-[60ch] rounded-lg border border-strong bg-layer-1 p-6 text-center"
    >
      <ShieldAlert className="mx-auto size-6 text-fg-subtle" aria-hidden="true" />
      <p className="mt-2 text-md font-medium text-fg-default">This module is not in your plan</p>
      <p className="mt-1 text-sm text-fg-muted">
        {point?.message ?? 'This part of the product is not included in your plan.'}
      </p>
      {point?.upgradeCta === undefined ? null : (
        <p className="mt-3 text-sm text-fg-muted">{point.upgradeCta}.</p>
      )}
      <p className="mt-3 font-mono text-xs text-fg-subtle">
        <span data-testid="missing-entitlement">{entitlement}</span>
      </p>
    </div>
  );
}
