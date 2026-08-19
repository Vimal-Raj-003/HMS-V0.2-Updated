import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantScope } from '@vims/db/tenancy';

/**
 * Ambient per-request context — step 1 of the chain in `docs/01` §3.
 *
 * It is carried in `AsyncLocalStorage` rather than threaded through every
 * function signature for one reason that matters: the audit writer, the outbox
 * writer and the logger all need the acting user and the trace id, and they are
 * called from deep inside services. Passing the context by hand would mean any
 * forgotten parameter silently produces an audit row with no actor — which is
 * exactly the row a medico-legal enquiry needs.
 *
 * It deliberately holds **no PHI**. `docs/04` §7: nothing identifying a patient
 * may reach a log line.
 */
export interface RequestContext {
  readonly traceId: string;
  readonly requestId: string;
  readonly startedAtMs: number;
  readonly method: string;
  readonly route: string;
  readonly ip: string | null;
  readonly userAgent: string | null;

  /** Populated by the auth guard (step 2); null for anonymous routes. */
  readonly userId: string | null;
  readonly sessionId: string | null;
  /** Populated by the tenant guard (step 3). */
  readonly hospitalId: string | null;
  readonly branchId: string | null;
  readonly grantedBranchIds: readonly string[];
  readonly scope: TenantScope;
  readonly roleKeys: readonly string[];
  /** Set when a Super Admin is acting as another user; every audit row records it. */
  readonly impersonatorUserId: string | null;
  /** Reason captured for break-glass / reason-required actions. */
  readonly reason: string | null;
}

const storage = new AsyncLocalStorage<MutableRequestContext>();

/** Internal mutable view — only the guards may narrow the context as it is built. */
export interface MutableRequestContext {
  traceId: string;
  requestId: string;
  startedAtMs: number;
  method: string;
  route: string;
  ip: string | null;
  userAgent: string | null;
  userId: string | null;
  sessionId: string | null;
  hospitalId: string | null;
  branchId: string | null;
  grantedBranchIds: readonly string[];
  scope: TenantScope;
  roleKeys: readonly string[];
  impersonatorUserId: string | null;
  reason: string | null;
}

export function runWithContext<T>(ctx: MutableRequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The current context, or `undefined` outside a request (a job, a boot task). */
export function tryGetContext(): MutableRequestContext | undefined {
  return storage.getStore();
}

/**
 * The current context, or a thrown error.
 *
 * Used by the audit and outbox writers: if they ever run without a context, the
 * right outcome is a loud failure, not an anonymous audit row.
 */
export function getContext(): MutableRequestContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      'No request context. Audit and outbox writes must run inside a request; a background job must open its own context explicitly.',
    );
  }
  return ctx;
}

export function freeze(ctx: MutableRequestContext): RequestContext {
  return { ...ctx };
}
