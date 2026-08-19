/**
 * Tenant-scoped database access for the hub.
 *
 * Identical in shape to `services/api/src/core/db/database.service.ts`, and for
 * the same reason: `docs/01` §3 step 8 requires every business statement to run
 * inside a transaction that has already stamped `app.hospital_id`, `app.user_id`
 * and `app.scope` onto itself. A statement issued outside `withTenant()` meets
 * RLS with no scope, and `core.accessible_hospital_ids()` returns an empty array
 * — so it silently reads nothing. Safe, but a bug, and one that looks like "the
 * connector disappeared".
 *
 * The GUCs are applied through `applyTenantContext`, which uses
 * `set_config(name, value, is_local => true)`. Never a built `SET LOCAL` string:
 * that would concatenate a tenant identifier into the one statement that decides
 * which hospital's data is visible, and ESLint bans the shape outright.
 *
 * The hub takes a `Pool` rather than building one from the environment so that
 * the integration suite can hand it the Testcontainers pool connected as
 * `hms_app` — the role that is `NOBYPASSRLS`. A suite that proves isolation
 * through a superuser pool proves nothing.
 */
import { applyTenantContext, type TenantContext } from '@vims/db/tenancy';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

export type { TenantContext };

/**
 * A thin, parameterised wrapper over a `pg` client.
 *
 * There is no method taking an interpolated string: every call is SQL plus
 * values (`docs/04` §6).
 */
export class TransactionClient {
  constructor(private readonly client: PoolClient) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    return this.client.query<R>(sql, [...values]);
  }

  async rows<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<R[]> {
    const result = await this.client.query<R>(sql, [...values]);
    return result.rows;
  }

  async maybeOne<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<R | undefined> {
    const result = await this.client.query<R>(sql, [...values]);
    if (result.rows.length > 1) {
      throw new Error(`Expected at most one row, received ${result.rows.length}`);
    }
    return result.rows[0];
  }

  async one<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<R> {
    const row = await this.maybeOne<R>(sql, values);
    if (row === undefined) throw new Error('Expected exactly one row, received none');
    return row;
  }
}

export class IntegrationDatabase {
  constructor(private readonly pool: Pool) {}

  /** Runs `fn` inside a transaction scoped to one tenant. Commits, or rolls back on throw. */
  async withTenant<T>(ctx: TenantContext, fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await applyTenantContext(client, ctx);
      const result = await fn(new TransactionClient(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is already broken; surfacing this would mask the
        // original error, which is the one worth reporting.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
