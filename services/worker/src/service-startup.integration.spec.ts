import { newId } from '@vims/contracts';
import {
  createTenantFixture,
  startTestPostgres,
  startTestRedis,
  type TenantFixture,
  type TestPostgres,
  type TestRedis,
} from '@vims/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SERVICE_ROOT,
  buildService,
  freePort,
  startService,
  until,
  waitForHttp,
  type RunningService,
} from './__tests__/service-process.js';

/**
 * The gate this file exists for: **`node dist/main.js` actually runs.**
 *
 * Everything else in `services/worker` was already tested by calling its
 * functions directly — `relayOnce()`, `sealAuditChains()`, `processPrintJob()`
 * — and all of it passed while the service could not be started at all, first
 * because `src/main.ts` did not exist and then because `@vims/contracts`
 * published raw TypeScript that Node could not resolve. A unit test cannot
 * catch either. So this one builds the service, starts the built artefact as a
 * separate OS process with nothing but the environment a container would give
 * it, and asserts on what that process *does*:
 *
 *  - it reaches readiness (database + schema + Redis),
 *  - an outbox row inserted while it runs becomes a Redis stream entry,
 *  - an unsealed audit row becomes sealed,
 *  - partitions the migrations never premade get created,
 *  - and SIGTERM exits 0 after a clean drain.
 *
 * Nothing here calls `relayOnce` or `sealAuditChains`. If the wiring in
 * `main.ts` is removed, this suite fails and the direct-call suite does not.
 */
let pg: TestPostgres;
let redis: TestRedis;
let tenants: TenantFixture;
let service: RunningService;
let healthPort: number;

/** Short enough that a scheduled job runs inside the test, long enough to be a schedule. */
const SEAL_INTERVAL_MS = 2_000;
const PARTITION_INTERVAL_MS = 60_000;
/** The migrations premake 3 months ahead; 6 proves the running worker made the rest. */
const PREMAKE_MONTHS = 6;

beforeAll(async () => {
  await buildService();
  pg = await startTestPostgres();
  redis = await startTestRedis();
  tenants = await createTenantFixture(pg);
  healthPort = await freePort();

  service = startService(SERVICE_ROOT, {
    NODE_ENV: 'test',
    PORT: String(healthPort),
    DATABASE_URL: pg.connectionString('app'),
    DATABASE_MAINTENANCE_URL: pg.connectionString('migrator'),
    REDIS_URL: redis.connectionString(),
    OUTBOX_POLL_INTERVAL_MS: '250',
    AUDIT_SEAL_INTERVAL_MS: String(SEAL_INTERVAL_MS),
    PARTITION_MAINTENANCE_INTERVAL_MS: String(PARTITION_INTERVAL_MS),
    PARTITION_PREMAKE_MONTHS: String(PREMAKE_MONTHS),
    // No Chromium in this suite, and the print path has its own integration
    // spec. Mounting it here would only prove Playwright is installed.
    PRINT_WORKER_ENABLED: 'false',
    WORKER_SHUTDOWN_GRACE_MS: '15000',
    LOG_LEVEL: 'info',
  });

  await service.waitForOutput((out) => out.includes('"event":"worker.started"'), 'worker.started', 60_000);
}, 600_000);

afterAll(async () => {
  await service?.stop('SIGKILL');
  await redis?.stop();
  await pg?.stop();
});

describe('services/worker starts from its build output', () => {
  it('mounts the relay, the sealer and partition maintenance', () => {
    const out = service.output();
    expect(out).toContain('outbox-relay(standard)');
    expect(out).toContain('audit-chain-sealer(maintenance');
    expect(out).toContain('partition-maintenance(maintenance');
    // The five priority classes of docs/07 §4, with their §4 concurrency.
    expect(out).toContain('critical:p1/c20');
    expect(out).toContain('interactive:p2/c16');
    expect(out).toContain('standard:p3/c32');
    expect(out).toContain('bulk:p4/c4');
    expect(out).toContain('maintenance:p5/c2');
  });

  it('reports ready once the database, the schema and Redis are all reachable', async () => {
    expect(healthPort).toBeGreaterThan(0);
    const ready = await waitForHttp(`http://127.0.0.1:${healthPort}/readyz`, [200], 30_000);
    const body: unknown = JSON.parse(ready.body);
    expect(body).toMatchObject({ ready: true, database: true, redis: true, migrations: true });

    const live = await waitForHttp(`http://127.0.0.1:${healthPort}/healthz`, [200], 5_000);
    expect(JSON.parse(live.body)).toMatchObject({ status: 'ok' });
  });

  /**
   * The decisive relay assertion. The row is inserted by the *test*, and the
   * stream entry can only have been written by the *running process*.
   */
  it('relays an outbox row inserted while it is running to the tenant Redis stream', async () => {
    const eventId = newId();
    await pg.pool('migrator').query(
      `INSERT INTO core.outbox_events (id, hospital_id, aggregate, aggregate_id, event_type, payload, correlation_id)
       VALUES ($1, $2, 'patient', $3, 'patient.registered', '{"k":"v"}'::jsonb, $4)`,
      [eventId, tenants.hospitalA, newId(), newId()],
    );

    const client = redis.client();
    const entry = await until(
      async () => {
        const entries = await client.xrange(`hms:events:${tenants.hospitalA}`, '-', '+');
        return entries.find(([, fields]) => fields.includes(eventId));
      },
      `event ${eventId} on hms:events:${tenants.hospitalA}`,
      30_000,
    );

    expect(entry?.[1]).toContain('patient.registered');

    const row = await pg
      .pool('migrator')
      .query<{ published_at: Date | null }>(`SELECT published_at FROM core.outbox_events WHERE id = $1`, [
        eventId,
      ]);
    expect(row.rows[0]?.published_at).not.toBeNull();
  }, 60_000);

  /** The sealer is a scheduled BullMQ job, so this proves the schedule fires too. */
  it('seals an audit row written while it is running', async () => {
    const auditId = newId();
    await pg.pool('migrator').query(
      `INSERT INTO core.audit_log (id, hospital_id, actor_type, action, entity, row_id, data_class)
       VALUES ($1, $2, 'system', 'insert', 'core.test', $3, 'operational')`,
      [auditId, tenants.hospitalB, newId()],
    );

    const sealed = await until(
      async () => {
        const { rows } = await pg
          .pool('migrator')
          .query<{ sealed_at: Date | null; seq: string | null }>(
            `SELECT sealed_at, seq FROM core.audit_log WHERE id = $1`,
            [auditId],
          );
        return rows[0]?.sealed_at === null || rows[0]?.sealed_at === undefined ? undefined : rows[0];
      },
      `audit row ${auditId} to be sealed`,
      SEAL_INTERVAL_MS * 15,
    );

    expect(sealed.sealed_at).not.toBeNull();
    expect(sealed.seq).not.toBeNull();

    const findings = await pg
      .pool('migrator')
      .query(`SELECT * FROM core.verify_audit_chain($1::uuid, $2::timestamptz, $3::timestamptz)`, [
        tenants.hospitalB,
        new Date(0).toISOString(),
        new Date(Date.now() + 60_000).toISOString(),
      ]);
    expect(findings.rows).toEqual([]);
  }, 120_000);

  /**
   * ADR-0008: the worker owns partition maintenance. The migrations premake
   * three months ahead, so a partition five months out can only exist because
   * this process created it.
   */
  it('premakes partitions the migrations never created (ADR-0008)', async () => {
    const now = new Date();
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + PREMAKE_MONTHS - 1, 1));
    const suffix = `${target.getUTCFullYear()}${String(target.getUTCMonth() + 1).padStart(2, '0')}`;

    const found = await until(
      async () => {
        const { rows } = await pg.pool('migrator').query<{ relname: string }>(
          `SELECT c.relname FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'core' AND c.relname = $1`,
          [`audit_log_${suffix}`],
        );
        return rows[0];
      },
      `core.audit_log_${suffix} to be created by the running worker`,
      60_000,
    );

    expect(found.relname).toBe(`audit_log_${suffix}`);
  }, 90_000);

  it('drains and exits 0 on SIGTERM', async () => {
    const code = await service.stop('SIGTERM');
    const out = service.output();
    expect(out).toContain('"event":"worker.shutdown.begin"');
    expect(out).toContain('"event":"worker.outbox-relay.stopped"');
    expect(out).toContain('"event":"worker.shutdown.complete"');
    expect(out).not.toContain('"event":"worker.shutdown.forced"');
    expect(code).toBe(0);
  }, 60_000);

  it('logs no PHI-bearing field', () => {
    // The redaction paths of `logger.ts` are a belt to the braces of "nothing
    // passes a payload to a log call". This asserts the braces held.
    const out = service.output();
    for (const forbidden of ['"payload"', '"patientId"', '"uhid"', '"phone"', '"data"']) {
      expect(out).not.toContain(forbidden);
    }
  });
});
