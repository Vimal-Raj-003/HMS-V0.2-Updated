import { startTestPostgres, type TestPostgres } from '@vims/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PARTITIONED_TABLES, ensureMonthPartitions } from './partition-maintenance.js';

/**
 * ADR-0008 made the application responsible for partition maintenance so the
 * product still runs on a managed PostgreSQL with no `pg_partman` and no
 * `pg_cron`. That trade is only safe if this job actually covers every
 * partitioned table — a table the job forgets gets a DEFAULT partition that
 * grows quietly until a month cannot be dropped in under a second.
 */
let pg: TestPostgres;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 600_000);

afterAll(async () => {
  await pg?.stop();
});

describe('partition maintenance (ADR-0008)', () => {
  it('maintains exactly the tables the migrations declared partitioned', async () => {
    const { rows } = await pg.pool('migrator').query<{ qualified: string }>(
      `SELECT n.nspname || '.' || c.relname AS qualified
         FROM pg_partitioned_table p
         JOIN pg_class c ON c.oid = p.partrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'p'
        ORDER BY 1`,
    );
    const declared = rows.map((r) => r.qualified);
    const maintained = PARTITIONED_TABLES.map((t) => `${t.schema}.${t.table}`).sort();

    // Both directions. A table in the database that the job does not know about
    // is the dangerous one; a table in the job that the database does not have
    // means a migration was reverted and the list was not.
    expect(maintained).toEqual([...declared].sort());
  });

  it('creates the months the migrations did not premake, and is idempotent', async () => {
    const first = await ensureMonthPartitions(pg.pool('migrator'), {
      monthsAhead: 8,
      monthsBehind: 1,
    });
    expect(first.ensured).toBe(PARTITIONED_TABLES.length * 10);
    // The migrations premake now-1 … now+3, so months +4 … +8 are new here.
    expect(first.created.length).toBeGreaterThan(0);

    const second = await ensureMonthPartitions(pg.pool('migrator'), {
      monthsAhead: 8,
      monthsBehind: 1,
    });
    expect(second.created).toEqual([]);
  }, 300_000);

  it('reports an empty default partition as empty', async () => {
    const result = await ensureMonthPartitions(pg.pool('migrator'), { monthsAhead: 1, monthsBehind: 0 });
    expect(result.nonEmptyDefaults).toEqual([]);
  });

  /**
   * ADR-0008 §1: the DEFAULT partition converts a missed maintenance run from a
   * clinical outage into a monitored anomaly. This is the monitor — and it has
   * to actually notice.
   */
  it('reports a default partition that has caught a row', async () => {
    const pool = pg.pool('migrator');
    const hospitalId = '00000000-0000-7000-8000-0000000000aa';
    await pool.query(
      `INSERT INTO core.hospitals (id, code, legal_name, display_name, timezone, currency, locale, updated_at)
       VALUES ($1, 'DEFPART', 'Default Partition Probe', 'Probe', 'Asia/Kolkata', 'INR', 'en-IN', now())
       ON CONFLICT (id) DO NOTHING`,
      [hospitalId],
    );
    // A timestamp far outside every declared range can only land in DEFAULT.
    await pool.query(
      `INSERT INTO core.audit_log (id, hospital_id, actor_type, action, entity, row_id, data_class, occurred_at)
       VALUES (gen_random_uuid(), $1, 'system', 'insert', 'core.probe', gen_random_uuid(), 'operational',
               timestamptz '2099-01-01 00:00:00+00')`,
      [hospitalId],
    );

    const result = await ensureMonthPartitions(pool, { monthsAhead: 1, monthsBehind: 0 });
    expect(result.nonEmptyDefaults).toContain('core.audit_log_default');
  });
});
