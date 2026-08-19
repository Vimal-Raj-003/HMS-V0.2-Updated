/**
 * Tenancy context — the only sanctioned way to activate row-level security.
 *
 * `docs/01-architecture.md` §3 step 8 requires every request to open a
 * transaction and stamp `app.hospital_id` / `app.user_id` / `app.scope` onto it
 * before a single business statement runs. `docs/03-database-conventions.md`
 * §RLS defines the policies that read them back; `packages/db/prisma/migrations/
 * 20260817152225_rls_policies` implements those reads as
 * `core.current_hospital_id()`, `core.current_user_id()`, `core.current_scope()`,
 * `core.current_branch_ids()` and `core.accessible_hospital_ids()`.
 *
 * Two properties of this file are load-bearing:
 *
 * 1. **`set_config(name, value, is_local => true)`, never a built `SET LOCAL`
 *    string.** `set_config` is the function form of `SET LOCAL` and takes bind
 *    parameters, so a tenant identifier can never be concatenated into SQL. A
 *    hand-built `SET LOCAL app.hospital_id = '<value>'` is an injection site on
 *    the one statement in the system that decides which hospital's data you can
 *    see. ESLint bans the string form outright (`eslint.config.mjs`,
 *    `no-restricted-syntax`).
 *
 * 2. **`is_local = true`, always.** A session-level `SET` survives the
 *    transaction. Under PgBouncer transaction pooling the next request — a
 *    different user, very possibly a different hospital — inherits the
 *    connection and the scope with it (`docs/07-performance-scalability.md` §4).
 *    Local settings die at COMMIT/ROLLBACK, which is the only safe lifetime.
 */

/** GUC names, exactly as the RLS policies in migration `..._rls_policies` read them. */
export const TENANT_GUC = {
  /** Single hospital for branch- and hospital-scoped sessions. */
  hospitalId: 'app.hospital_id',
  /** Acting user, recorded on audit rows and used by own-record ABAC conditions. */
  userId: 'app.user_id',
  /** `'branch' | 'hospital' | 'group'` — widens what `accessible_hospital_ids()` returns. */
  scope: 'app.scope',
  /** Hospitals a group-scoped session may reach (EN-041 §3.3.4). Ignored unless scope is `group`. */
  hospitalIds: 'app.hospital_ids',
  /** Branches a session may touch. Empty means "no branch restriction expressed". */
  branchIds: 'app.branch_ids',
} as const;

export type TenantGucName = (typeof TENANT_GUC)[keyof typeof TENANT_GUC];

/**
 * How wide a session's visibility is.
 *
 * `branch` and `hospital` both resolve to exactly one hospital, so a
 * cross-tenant read is not expressible. Only `group` widens the set, and only
 * to the hospitals explicitly listed in `hospitalIds`.
 */
export type TenantScope = 'branch' | 'hospital' | 'group';

export interface TenantContext {
  /** Required for `branch` and `hospital` scope. */
  readonly hospitalId: string;
  readonly userId: string;
  readonly scope: TenantScope;
  /** Required (and only meaningful) when `scope` is `group`. */
  readonly hospitalIds?: readonly string[];
  readonly branchIds?: readonly string[];
}

/** Minimal shape of anything that can run a parameterised statement. */
export interface SqlExecutor {
  query(sql: string, values?: readonly unknown[]): Promise<unknown>;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

function assertUuid(value: string, field: string): string {
  if (!UUID_RE.test(value)) {
    throw new TenantContextError(
      `${field} must be a UUID; refusing to establish a tenancy scope from an unvalidated value.`,
    );
  }
  return value;
}

/** Renders a uuid[] as a Postgres array literal. Every element is validated first. */
function uuidArrayLiteral(values: readonly string[], field: string): string {
  return `{${values.map((v, i) => assertUuid(v, `${field}[${i}]`)).join(',')}}`;
}

/**
 * The `(guc, value)` pairs for a context, in a stable order.
 *
 * Exported so tests can assert what *would* be applied without needing a
 * database, and so the API's transaction interceptor can log the scope it set
 * (never the values — they are identifiers, and `docs/04` §7 keeps identifiers
 * out of logs).
 */
export function tenantContextSettings(ctx: TenantContext): ReadonlyArray<readonly [TenantGucName, string]> {
  assertUuid(ctx.hospitalId, 'hospitalId');
  assertUuid(ctx.userId, 'userId');

  if (ctx.scope === 'group') {
    const list = ctx.hospitalIds ?? [];
    if (list.length === 0) {
      throw new TenantContextError(
        'A group-scoped session must list its hospitals explicitly; an empty list would widen visibility to nothing and mask the bug.',
      );
    }
    if (!list.includes(ctx.hospitalId)) {
      throw new TenantContextError(
        'hospitalId must be one of hospitalIds for a group-scoped session (EN-041 §3.3.4).',
      );
    }
  } else if (ctx.hospitalIds !== undefined && ctx.hospitalIds.length > 0) {
    throw new TenantContextError(
      `hospitalIds is only meaningful for group scope; passing it with '${ctx.scope}' scope suggests a widening that will silently not happen.`,
    );
  }

  const settings: Array<readonly [TenantGucName, string]> = [
    [TENANT_GUC.hospitalId, ctx.hospitalId],
    [TENANT_GUC.userId, ctx.userId],
    [TENANT_GUC.scope, ctx.scope],
  ];

  if (ctx.scope === 'group') {
    settings.push([TENANT_GUC.hospitalIds, uuidArrayLiteral(ctx.hospitalIds ?? [], 'hospitalIds')]);
  }
  if (ctx.branchIds !== undefined && ctx.branchIds.length > 0) {
    settings.push([TENANT_GUC.branchIds, uuidArrayLiteral(ctx.branchIds, 'branchIds')]);
  }

  return settings;
}

/**
 * Stamps the tenancy context onto the **current transaction**.
 *
 * The caller is responsible for already being inside one. Outside a transaction
 * `set_config(..., true)` applies to the current statement only and the next
 * query runs unscoped — which RLS turns into "sees nothing" rather than "sees
 * everything", but is still a bug worth failing loudly on in review.
 */
export async function applyTenantContext(exec: SqlExecutor, ctx: TenantContext): Promise<void> {
  for (const [name, value] of tenantContextSettings(ctx)) {
    await exec.query('SELECT set_config($1, $2, true)', [name, value]);
  }
}

/**
 * Clears the tenancy context for the current transaction.
 *
 * Used by the isolation tests to prove that an unscoped session sees nothing —
 * default-deny arrives from SQL semantics (`current_setting(..., true)` returning
 * NULL), not from remembering to write a guard.
 */
export async function clearTenantContext(exec: SqlExecutor): Promise<void> {
  for (const name of Object.values(TENANT_GUC)) {
    await exec.query('SELECT set_config($1, $2, true)', [name, '']);
  }
}
