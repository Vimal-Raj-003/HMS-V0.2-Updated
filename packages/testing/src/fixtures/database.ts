import { applyTenantContext, clearTenantContext, type TenantContext } from '@vims/db/tenancy';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { PgRole, TestPostgres } from '../containers/postgres.js';

/**
 * Test isolation by transaction rollback.
 *
 * Restarting a container per test would be correct and unusably slow; truncating
 * between tests is faster but destroys the seeded reference data and races with
 * parallel suites. A transaction that is always rolled back gives perfect
 * isolation at roughly the cost of one round trip, and — the reason it is right
 * here rather than merely convenient — it is also the only place
 * `SET LOCAL`/`set_config(..., true)` has meaning, so it is exactly the scope in
 * which production RLS operates (`docs/01` §3 step 8).
 */

export interface TenantClient {
  /** Runs a statement inside the rolled-back transaction, with the tenancy scope applied. */
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
  /** Convenience: the rows of a query. */
  rows<R extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<R[]>;
  /** Convenience: the single scalar of a one-row, one-column query. */
  scalar<T>(sql: string, values?: readonly unknown[]): Promise<T | undefined>;
  /** The raw node-postgres client, for the rare test that needs it. */
  readonly raw: PoolClient;
}

function wrap(client: PoolClient): TenantClient {
  return {
    raw: client,
    async query<R extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]) {
      return client.query<R>(sql, values ? [...values] : undefined);
    },
    async rows<R extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]) {
      const result = await client.query<R>(sql, values ? [...values] : undefined);
      return result.rows;
    },
    async scalar<T>(sql: string, values?: readonly unknown[]) {
      const result = await client.query(sql, values ? [...values] : undefined);
      const first: Record<string, unknown> | undefined = result.rows[0];
      if (first === undefined) return undefined;
      const [value] = Object.values(first);
      return value as T | undefined;
    },
  };
}

/**
 * Opens a transaction, runs `fn`, and **always** rolls back.
 *
 * The rollback is in a `finally`, so a failing assertion still leaves the
 * database exactly as it was. Nothing a test writes can leak into the next one.
 */
export async function withRollback<T>(pool: Pool, fn: (client: TenantClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await fn(wrap(client));
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
}

/**
 * Runs `fn` as a database role **and** a tenancy scope — the two halves of what
 * a real request carries.
 *
 * Connecting as `hms_app` is what subjects the query to RLS; the tenancy context
 * is what tells the policies which hospital is asking. Getting either wrong
 * produces a test that passes for the wrong reason, so both are required here
 * rather than defaulted.
 */
export async function asRole<T>(
  pg: TestPostgres,
  role: PgRole,
  ctx: TenantContext,
  fn: (client: TenantClient) => Promise<T>,
): Promise<T> {
  return withRollback(pg.pool(role), async (client) => {
    await applyTenantContext(client.raw, ctx);
    return fn(client);
  });
}

/** Shorthand for the common case: the application role, subject to RLS. */
export async function asTenant<T>(
  pg: TestPostgres,
  ctx: TenantContext,
  fn: (client: TenantClient) => Promise<T>,
): Promise<T> {
  return asRole(pg, 'app', ctx, fn);
}

/**
 * Runs `fn` as `hms_app` with **no** tenancy context.
 *
 * This is the default-deny proof: `current_setting('app.hospital_id', true)`
 * returns NULL, every tenant policy evaluates false, and the session sees
 * nothing. A test using this should assert emptiness, not an error — RLS filters,
 * it does not raise.
 */
export async function asUnscoped<T>(pg: TestPostgres, fn: (client: TenantClient) => Promise<T>): Promise<T> {
  return withRollback(pg.pool('app'), async (client) => {
    await clearTenantContext(client.raw);
    return fn(client);
  });
}

/**
 * Runs `fn` as `hms_migrator` — schema owner, therefore **not** subject to RLS.
 *
 * For arranging fixtures that must exist across tenants. Never use it to assert
 * an isolation property: an owner sees everything by design, so such a test
 * would pass even with every policy dropped.
 */
export async function asMigrator<T>(pg: TestPostgres, fn: (client: TenantClient) => Promise<T>): Promise<T> {
  return withRollback(pg.pool('migrator'), fn);
}
