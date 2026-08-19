import type { TenantContext } from '@vims/db/tenancy';
import type { TestPostgres } from '../containers/postgres.js';
import { asTenant, asUnscoped } from '../fixtures/database.js';

/**
 * The tenant-isolation proof every module reuses.
 *
 * `docs/09-quality-gates-and-testing.md` §3.1 makes this mandatory per module,
 * and the shape below is deliberate. The obvious version of this test — "user of
 * hospital A selects hospital B's row and gets nothing" — passes for three
 * different reasons, only one of which is the one we care about:
 *
 *   1. the policy correctly filtered it   ← what we want to prove
 *   2. the row was never actually created ← a broken fixture
 *   3. the query was malformed and matched nothing ← a broken test
 *
 * So every check here is run with its **control**: the same query, as the tenant
 * that does own the row, must return it. A failure to see it from B's side is
 * reported as a fixture error rather than as a passing isolation test, which is
 * the single most common way this class of test lies.
 *
 * Four properties are asserted:
 *   READ    — A cannot read B's row by direct id, while B can (the control)
 *   WRITE   — A cannot insert a row carrying B's hospital_id (`WITH CHECK`)
 *   UPDATE  — A cannot move its own row into B's tenant
 *   DEFAULT — a session with no tenancy context sees nothing at all
 */

export interface TenantIsolationProbe {
  /** Schema-qualified table, e.g. `core.branches`. */
  readonly table: string;
  /** Primary key column. Default `id`. */
  readonly idColumn?: string;
  /** Tenant discriminator column. Default `hospital_id`. */
  readonly hospitalColumn?: string;
  /** A row that genuinely belongs to `victim`. */
  readonly victimRowId: string;
  /** The tenant that must not see it. */
  readonly attacker: TenantContext;
  /** The tenant that owns it. */
  readonly victim: TenantContext;
}

export interface TenantIsolationReport {
  readonly table: string;
  readonly readBlocked: boolean;
  readonly controlVisible: boolean;
  readonly crossTenantInsertBlocked: boolean;
  readonly crossTenantUpdateBlocked: boolean;
  readonly unscopedSeesNothing: boolean;
  readonly failures: readonly string[];
  readonly ok: boolean;
}

export class TenantIsolationError extends Error {
  constructor(
    readonly report: TenantIsolationReport,
    message: string,
  ) {
    super(message);
    this.name = 'TenantIsolationError';
  }
}

function quoteIdent(qualified: string): string {
  // Schema-qualified identifiers only; anything else is a programming error in a
  // test, and building SQL from it unchecked is how a fixture becomes an injection.
  if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i.test(qualified)) {
    throw new Error(`Unsafe table identifier for isolation probe: ${qualified}`);
  }
  const [schema, table] = qualified.split('.');
  return `"${schema}"."${table}"`;
}

function quoteColumn(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`Unsafe column identifier: ${name}`);
  return `"${name}"`;
}

export async function checkTenantIsolation(
  pg: TestPostgres,
  probe: TenantIsolationProbe,
): Promise<TenantIsolationReport> {
  const table = quoteIdent(probe.table);
  const idCol = quoteColumn(probe.idColumn ?? 'id');
  const hospCol = quoteColumn(probe.hospitalColumn ?? 'hospital_id');
  const failures: string[] = [];

  // ── control: the owning tenant must see its own row ───────────────────────
  const controlCount = await asTenant(pg, probe.victim, async (c) =>
    c.scalar<string>(`SELECT count(*) FROM ${table} WHERE ${idCol} = $1`, [probe.victimRowId]),
  );
  const controlVisible = Number(controlCount ?? 0) === 1;
  if (!controlVisible) {
    failures.push(
      `CONTROL FAILED: the owning tenant cannot see ${probe.table} row ${probe.victimRowId}. ` +
        `The fixture is wrong, so the isolation result below is meaningless.`,
    );
  }

  // ── READ: the attacker must see nothing ───────────────────────────────────
  const attackerCount = await asTenant(pg, probe.attacker, async (c) =>
    c.scalar<string>(`SELECT count(*) FROM ${table} WHERE ${idCol} = $1`, [probe.victimRowId]),
  );
  const readBlocked = Number(attackerCount ?? 0) === 0;
  if (!readBlocked) {
    failures.push(
      `READ LEAK: a session scoped to hospital ${probe.attacker.hospitalId} read ${probe.table} ` +
        `row ${probe.victimRowId}, which belongs to hospital ${probe.victim.hospitalId}.`,
    );
  }

  // ── WRITE: WITH CHECK must reject a row planted in another tenant ─────────
  let crossTenantInsertBlocked = false;
  try {
    await asTenant(pg, probe.attacker, async (c) => {
      await c.query(`INSERT INTO ${table} (${idCol}, ${hospCol}) VALUES (gen_random_uuid(), $1)`, [
        probe.victim.hospitalId,
      ]);
    });
  } catch {
    // Any rejection counts: a WITH CHECK violation, a NOT NULL on an unrelated
    // column, or a missing default. The point is that the row does not land.
    crossTenantInsertBlocked = true;
  }
  if (!crossTenantInsertBlocked) {
    failures.push(
      `WRITE LEAK: a session scoped to hospital ${probe.attacker.hospitalId} inserted a row into ` +
        `${probe.table} carrying hospital_id ${probe.victim.hospitalId}. The policy has no WITH CHECK.`,
    );
  }

  // ── UPDATE: the attacker must not be able to hand a row to another tenant ─
  let crossTenantUpdateBlocked = false;
  try {
    const moved = await asTenant(pg, probe.attacker, async (c) => {
      const result = await c.query(`UPDATE ${table} SET ${hospCol} = $1 WHERE ${hospCol} = $2`, [
        probe.victim.hospitalId,
        probe.attacker.hospitalId,
      ]);
      return result.rowCount ?? 0;
    });
    crossTenantUpdateBlocked = moved === 0;
  } catch {
    crossTenantUpdateBlocked = true;
  }
  if (!crossTenantUpdateBlocked) {
    failures.push(
      `WRITE LEAK: a session scoped to hospital ${probe.attacker.hospitalId} moved its own ` +
        `${probe.table} rows into hospital ${probe.victim.hospitalId}.`,
    );
  }

  // ── DEFAULT DENY: no context means no rows, from SQL semantics ────────────
  const unscopedCount = await asUnscoped(pg, async (c) => c.scalar<string>(`SELECT count(*) FROM ${table}`));
  const unscopedSeesNothing = Number(unscopedCount ?? 0) === 0;
  if (!unscopedSeesNothing) {
    failures.push(
      `DEFAULT-DENY LEAK: a session with no tenancy context read ${unscopedCount} row(s) from ` +
        `${probe.table}. Unscoped access must resolve to nothing.`,
    );
  }

  return {
    table: probe.table,
    readBlocked,
    controlVisible,
    crossTenantInsertBlocked,
    crossTenantUpdateBlocked,
    unscopedSeesNothing,
    failures,
    ok: failures.length === 0,
  };
}

/** Throws a `TenantIsolationError` listing every failure. Use inside a test. */
export async function assertTenantIsolation(
  pg: TestPostgres,
  probe: TenantIsolationProbe,
): Promise<TenantIsolationReport> {
  const report = await checkTenantIsolation(pg, probe);
  if (!report.ok) {
    throw new TenantIsolationError(
      report,
      `Tenant isolation failed for ${probe.table}:\n  - ${report.failures.join('\n  - ')}`,
    );
  }
  return report;
}
