import type { TenantContext } from '@vims/db/tenancy';
import { getContext } from '../context/request-context.js';

/**
 * Builds the database tenancy scope for the current request.
 *
 * Every module uses this rather than assembling a `TenantContext` by hand,
 * because there is one detail that is easy to omit and expensive to debug:
 * `app.branch_ids`.
 *
 * The generated RLS policy narrows any table carrying a `branch_id` with
 * `(branch_id IS NULL OR branch_id = ANY(core.current_branch_ids()))`, and
 * `current_branch_ids()` returns an **empty array** when unset. Omitting the
 * branch list therefore does not mean "all branches" — it means *none*, and the
 * symptom is not a permission error but an empty list, or, on a write, an
 * `INSERT` rejected by `WITH CHECK` deep inside an audit call. Centralising it
 * makes that impossible to forget.
 */
export function currentTenantContext(): TenantContext {
  const ctx = getContext();
  if (ctx.hospitalId === null || ctx.userId === null) {
    throw new Error(
      'currentTenantContext() called without an authenticated request. A guarded route should be unreachable in this state; a background job must build its own context explicitly.',
    );
  }

  // The branch the user is acting in must be inside the scope, and so must every
  // branch they are granted — a ward list filtered to one branch still writes an
  // audit row stamped with the acting branch.
  const branchIds = new Set<string>(ctx.grantedBranchIds);
  if (ctx.branchId !== null) branchIds.add(ctx.branchId);

  const base = {
    hospitalId: ctx.hospitalId,
    userId: ctx.userId,
    scope: ctx.scope,
  };

  return branchIds.size > 0 ? { ...base, branchIds: [...branchIds] } : base;
}
