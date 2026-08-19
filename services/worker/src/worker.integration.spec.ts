import { newId } from '@vims/contracts';
import { createTenantFixture, startTestPostgres, startTestRedis, type TenantFixture, type TestPostgres, type TestRedis } from '@vims/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { relayOnce } from './relay/outbox-relay.js';
import { sealAuditChains, verifyAuditChain } from './maintenance/audit-chain-sealer.js';

let pg: TestPostgres;
let redis: TestRedis;
let tenants: TenantFixture;

beforeAll(async () => {
  pg = await startTestPostgres();
  redis = await startTestRedis();
  tenants = await createTenantFixture(pg);
}, 300_000);

afterAll(async () => {
  await redis?.stop();
  await pg?.stop();
});

async function insertOutbox(hospitalId: string, eventType: string): Promise<string> {
  const id = newId();
  await pg.pool('migrator').query(
    `INSERT INTO core.outbox_events (id, hospital_id, aggregate, aggregate_id, event_type, payload, correlation_id)
     VALUES ($1, $2, 'patient', $3, $4, '{"k":"v"}'::jsonb, $5)`,
    [id, hospitalId, newId(), eventType, newId()],
  );
  return id;
}

describe('outbox relay', () => {
  it('publishes pending events to a per-tenant Redis stream and marks them published', async () => {
    const eventId = await insertOutbox(tenants.hospitalA, 'patient.registered');
    const client = redis.client();

    const result = await relayOnce(pg.pool('migrator'), client);
    expect(result.published).toBeGreaterThanOrEqual(1);

    const entries = await client.xrange(`hms:events:${tenants.hospitalA}`, '-', '+');
    const flat = entries.flatMap(([, fields]) => fields);
    expect(flat).toContain(eventId);
    expect(flat).toContain('patient.registered');

    const row = await pg.pool('migrator').query<{ published_at: Date | null }>(
      `SELECT published_at FROM core.outbox_events WHERE id = $1`,
      [eventId],
    );
    expect(row.rows[0]?.published_at).not.toBeNull();
  });

  /**
   * The property that makes several worker replicas safe. Without
   * `FOR UPDATE SKIP LOCKED` each replica would read the same rows and publish
   * every event once per replica.
   */
  it('does not republish an already-published event', async () => {
    await insertOutbox(tenants.hospitalA, 'patient.merged');
    const client = redis.client();
    await relayOnce(pg.pool('migrator'), client);

    const second = await relayOnce(pg.pool('migrator'), client);
    expect(second.published).toBe(0);
  });

  it('keeps tenants on separate streams', async () => {
    await insertOutbox(tenants.hospitalB, 'bed.assigned');
    const client = redis.client();
    await relayOnce(pg.pool('migrator'), client);

    const streamB = await client.xrange(`hms:events:${tenants.hospitalB}`, '-', '+');
    const flatB = streamB.flatMap(([, f]) => f);
    expect(flatB).toContain('bed.assigned');

    const streamA = await client.xrange(`hms:events:${tenants.hospitalA}`, '-', '+');
    expect(streamA.flatMap(([, f]) => f)).not.toContain('bed.assigned');
  });
});

describe('audit chain sealer', () => {
  async function insertAudit(hospitalId: string): Promise<void> {
    await pg.pool('migrator').query(
      `INSERT INTO core.audit_log (id, hospital_id, actor_type, action, entity, row_id, data_class)
       VALUES ($1, $2, 'system', 'insert', 'core.test', $3, 'operational')`,
      [newId(), hospitalId, newId()],
    );
  }

  it('seals pending rows and the chain then verifies clean', async () => {
    await insertAudit(tenants.hospitalA);
    await insertAudit(tenants.hospitalA);

    const sealed = await sealAuditChains(pg.pool('migrator'));
    expect(sealed.some((s) => s.hospitalId === tenants.hospitalA)).toBe(true);

    const unsealed = await pg.pool('migrator').query<{ n: string }>(
      `SELECT count(*) AS n FROM core.audit_log WHERE hospital_id = $1 AND sealed_at IS NULL`,
      [tenants.hospitalA],
    );
    expect(Number(unsealed.rows[0]?.n)).toBe(0);

    const findings = await verifyAuditChain(pg.pool('migrator'), tenants.hospitalA);
    expect(findings).toEqual([]);
  });

  it('is idempotent — a second pass seals nothing and still verifies', async () => {
    await sealAuditChains(pg.pool('migrator'));
    const findings = await verifyAuditChain(pg.pool('migrator'), tenants.hospitalA);
    expect(findings).toEqual([]);
  });
});
