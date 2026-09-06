import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { applyTenantContext, type TenantContext } from '@vims/db/tenancy';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { ENV, type Env } from '../config/env.js';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The database access layer, and the place row-level security is switched on.
 *
 * `docs/01` §3 step 8 is not a suggestion: **every** business statement runs
 * inside a transaction that has first stamped `app.hospital_id`, `app.user_id`
 * and `app.scope` onto itself. Two consequences follow, and both are the reason
 * this class exists rather than each service opening its own client:
 *
 *  1. A query issued outside `withTenant()` reaches the database with no scope.
 *     RLS then filters it to nothing — a silently empty result rather than a
 *     leak, which is the safe direction, but still a bug. Routing all access
 *     through here makes the omission impossible rather than merely unlikely.
 *  2. The audit row and the outbox row must be written in the *same*
 *     transaction as the change they describe (`docs/01` §3, `EN-024` §5). If
 *     they were written afterwards, a crash between commit and audit would
 *     produce a clinical change with no record of who made it.
 *
 * The pool connects as `hms_app`, which is `NOBYPASSRLS` and owns nothing.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;

  constructor(@Inject(ENV) env: Env) {
    this.pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: env.DATABASE_POOL_MAX,
      // A query still running after this has already lost the user's attention
      // and is holding a snapshot open, which is the main source of bloat on
      // append-only tables like audit_log (docs/07 §5).
      statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: 30_000,
      application_name: 'vims-api',
    });

    // An *idle* pooled client can be terminated by the server at any time —
    // a failover, a `pg_terminate_backend`, an administrator restart (57P01),
    // an idle-session timeout. `pg` surfaces that on the pool rather than on
    // any one query, and an EventEmitter 'error' with no listener is an
    // unhandled exception: the whole API process dies because a connection
    // nobody was using went away. The pool already replaces dead clients on
    // its own, so the correct handling is to record it and carry on.
    //
    // No connection string in the log line — it carries the database password
    // (docs/04 §4: no secrets in logs).
    this.pool.on('error', (error: Error) => {
      this.logger.warn(
        { err: error.message, code: (error as { code?: string }).code ?? null },
        'idle pooled connection lost; the pool will replace it',
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Runs `fn` inside a transaction scoped to one tenant.
   *
   * Commits on success, rolls back on any throw. The tenancy GUCs are applied
   * with `set_config(..., is_local => true)` so they die with the transaction and
   * cannot survive onto the next request through a pooled connection
   * (`docs/07` §4).
   */
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
        // A rollback failure means the connection is already broken; surfacing
        // it would mask the original error, which is the one worth reporting.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Runs `fn` scoped to a hospital but with **no acting user**.
   *
   * This is the shape login genuinely has. `docs/05` guarantees "one login URL
   * per tenant", so the hospital is known before the user is — but the user is
   * precisely the claim being verified, and establishing `app.user_id` from it
   * would mean trusting the thing under test.
   *
   * Crucially this is *not* an RLS bypass: `app.hospital_id` is set, so the
   * policies still confine every read to one tenant. A bug in the login query
   * therefore fails closed, returning nothing, rather than searching every
   * hospital in the database for a username.
   */
  async withHospitalScope<T>(hospitalId: string, fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    if (!UUID_RE.test(hospitalId)) {
      throw new Error('withHospitalScope requires a UUID hospital id');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.hospital_id', hospitalId]);
      await client.query('SELECT set_config($1, $2, true)', ['app.scope', 'branch']);

      // Widen to every branch of THIS hospital, and no further.
      //
      // The generated RLS policy appends a branch predicate to any table that
      // has a `branch_id`:
      //   hospital_id = ANY(accessible_hospital_ids())
      //     AND (branch_id IS NULL OR branch_id = ANY(current_branch_ids()))
      // and `current_branch_ids()` returns an EMPTY array when unset — deliberate
      // default-deny. `core.user_roles` is branch-scoped, so a login that has not
      // yet chosen a branch would read none of its own grants and every user
      // would be told they have no role.
      //
      // That is a genuine chicken-and-egg: the branch scope is derived FROM the
      // grants. `docs/05` resolves it in the flow itself — "choose branch (if >1)"
      // happens AFTER the password step — so a session at this point is
      // legitimately "all branches of this hospital", and narrows once the user
      // picks one. Tenancy is never widened: `app.hospital_id` still confines
      // every read to one hospital.
      const branches = await client.query<{ id: string }>('SELECT id FROM core.branches');
      const branchIds = branches.rows.map((r) => r.id).filter((id) => UUID_RE.test(id));
      if (branchIds.length > 0) {
        await client.query('SELECT set_config($1, $2, true)', ['app.branch_ids', `{${branchIds.join(',')}}`]);
      }

      const result = await fn(new TransactionClient(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Already broken; the original error is the one worth reporting.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Runs `fn` with **no** tenancy scope at all.
   *
   * Reserved for genuinely tenant-less reads: the health probe and the two
   * global catalogues (`core.permissions`, `core.setting_definitions`, D-17).
   * Deliberately named so it is conspicuous in review — anything clinical or
   * financial reached through here is a defect.
   */
  async withoutTenant<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(new TransactionClient(client));
    } finally {
      client.release();
    }
  }

  /** Liveness/readiness probe. Never used for business queries. */
  async ping(): Promise<boolean> {
    const result = await this.pool.query('SELECT 1 AS ok');
    return result.rows.length === 1;
  }
}

/**
 * A thin, parameterised wrapper over a `pg` client.
 *
 * There is no method that accepts an interpolated string: every call takes SQL
 * plus values. `docs/04` §6 bans raw SQL string concatenation, and the cheapest
 * way to enforce that is to make the unsafe shape unavailable.
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
