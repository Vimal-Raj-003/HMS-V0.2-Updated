import { newId } from '@vims/contracts';
import type { TenantContext } from '@vims/db/tenancy';
import { createTenantFixture, startTestPostgres, type TenantFixture, type TestPostgres } from '@vims/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Clock } from './adapter/types.js';
import { canAttempt, onFailure } from './circuit/circuit-breaker.js';
import { IntegrationHub } from './hub.js';
import { silentLogger } from './logger.js';
import { InMemoryPayloadStore } from './payload/payload-store.js';
import { nullEchoConnectorConfig, PHI_SAMPLE } from './testing/fixtures.js';

/**
 * The properties asserted here are properties of the *running database*, not of
 * the source: RLS tenant isolation, the append-only grant on `ihub_messages`,
 * the monthly partitions, and the enum types the message log writes into. None
 * of them can be checked against a mock, and a suite that mocked them would go
 * green while production leaked.
 *
 * Everything connects as `hms_app`, which is `NOBYPASSRLS` and owns nothing —
 * the same role a real request uses. Reads that must see *through* RLS to prove
 * a value is genuinely absent from the table use the `migrator` pool, which is
 * the schema owner; that direction is safe because it can only make an
 * absence-assertion harder to pass.
 */

class TestClock implements Clock {
  private t: Date;
  constructor(start: Date) {
    this.t = start;
  }
  now(): Date {
    return new Date(this.t.getTime());
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
}

let pg: TestPostgres;
let tenants: TenantFixture;
let hub: IntegrationHub;
let payloads: InMemoryPayloadStore;
let clock: TestClock;
let ctxA: TenantContext;
let ctxB: TenantContext;

beforeAll(async () => {
  pg = await startTestPostgres();
  tenants = await createTenantFixture(pg);
  clock = new TestClock(new Date());
  payloads = new InMemoryPayloadStore();
  hub = new IntegrationHub({
    pool: pg.pool('app'),
    clock,
    logger: silentLogger,
    newId,
    payloads,
  });
  ctxA = { hospitalId: tenants.hospitalA, userId: newId(), scope: 'branch', branchIds: [tenants.branchA] };
  ctxB = { hospitalId: tenants.hospitalB, userId: newId(), scope: 'branch', branchIds: [tenants.branchB] };
}, 300_000);

afterAll(async () => {
  await hub?.shutdown();
  await pg?.stop();
});

/** Registers and activates a connector, returning its record. */
async function liveConnector(
  ctx: TenantContext,
  config: ReturnType<typeof nullEchoConnectorConfig>,
): Promise<{ readonly id: string; readonly key: string }> {
  const owner = newId();
  const record = await hub.connectors.register(ctx, { config, ownerUserId: owner });
  await hub.connectors.activate(ctx, record.key, { approvedBy: owner });
  return { id: record.id, key: record.key };
}

describe('connector registry', () => {
  it('registers a connector and reads it back with its operations and DPDP block', async () => {
    const owner = newId();
    const registered = await hub.connectors.register(ctxA, {
      config: nullEchoConnectorConfig({ key: 'reg-readback' }),
      ownerUserId: owner,
    });

    expect(registered.status).toBe('draft');
    expect(registered.version).toBe(1);
    expect(registered.adapter).toBe('vims.null-echo@0.1.0');

    const readBack = await hub.connectors.get(ctxA, 'reg-readback');
    expect(readBack?.id).toBe(registered.id);
    expect(readBack?.operations.map((op) => op.key)).toEqual(['echo']);
    expect(readBack?.config.dpdp.containsPhi).toBe(true);
    expect(readBack?.config.circuit.failureThreshold).toBe(3);
    expect(readBack?.containsPhi).toBe(true);
    expect(readBack?.crossBorder).toBe(false);

    // The health check EN-017 §5 requires before activation is created with the
    // connector rather than left to a later screen nobody visits.
    const health = await pg
      .pool('migrator')
      .query<{ kind: string }>(`SELECT kind FROM integration.ihub_health_checks WHERE connector_id = $1`, [
        registered.id,
      ]);
    expect(health.rows[0]?.kind).toBe('ping');
  });

  it('refuses to activate a connector that has no owner', async () => {
    const record = await hub.connectors.register(ctxA, {
      config: nullEchoConnectorConfig({ key: 'reg-no-owner' }),
    });
    await expect(hub.connectors.activate(ctxA, record.key)).rejects.toThrow(/no owner assigned/);
  });

  it('refuses to activate a PHI-carrying connector without admin approval', async () => {
    const record = await hub.connectors.register(ctxA, {
      config: nullEchoConnectorConfig({ key: 'reg-no-approval' }),
      ownerUserId: newId(),
    });
    await expect(hub.connectors.activate(ctxA, record.key)).rejects.toThrow(/Hospital Admin approval/);
  });

  it('enables and disables a connector per hospital', async () => {
    const connector = await liveConnector(ctxA, nullEchoConnectorConfig({ key: 'reg-toggle' }));

    const paused = await hub.connectors.setEnabled(ctxA, connector.key, false);
    expect(paused.status).toBe('paused');

    // A paused connector parks its traffic rather than losing it (EN-017 §3.1.7).
    const parked = await hub.dispatcher.dispatch(ctxA, {
      connectorKey: connector.key,
      operationKey: 'echo',
      payload: { ping: true },
    });
    expect(parked.status).toBe('blocked');

    const resumed = await hub.connectors.setEnabled(ctxA, connector.key, true);
    expect(resumed.status).toBe('active');
  });

  it('creates a new version rather than mutating an existing connector', async () => {
    // EN-017 §3.1.6: `ihub_messages.connector_version` is how a message logged
    // six weeks ago stays interpretable, so a config change may not overwrite.
    await hub.connectors.register(ctxA, {
      config: nullEchoConnectorConfig({ key: 'reg-versioned' }),
      ownerUserId: newId(),
    });
    const v2 = await hub.connectors.register(ctxA, {
      config: nullEchoConnectorConfig({ key: 'reg-versioned', coolDownSec: 120 }),
      ownerUserId: newId(),
    });

    expect(v2.version).toBe(2);
    const rows = await pg
      .pool('migrator')
      .query<{ version: number; status: string }>(
        `SELECT version, status FROM integration.ihub_connectors WHERE key = 'reg-versioned' AND hospital_id = $1 ORDER BY version`,
        [tenants.hospitalA],
      );
    expect(rows.rows).toEqual([
      { version: 1, status: 'retired' },
      { version: 2, status: 'draft' },
    ]);
    expect((await hub.connectors.get(ctxA, 'reg-versioned'))?.version).toBe(2);
  });
});

describe('message log — PHI redaction', () => {
  it('stores a redacted copy and keeps the raw identifiers out of the table entirely', async () => {
    const connector = await liveConnector(ctxA, nullEchoConnectorConfig({ key: 'log-phi' }));

    const outcome = await hub.dispatcher.dispatch(ctxA, {
      connectorKey: connector.key,
      operationKey: 'echo',
      payload: PHI_SAMPLE,
      refType: 'patient',
      refId: newId(),
    });
    expect(outcome.status).toBe('acknowledged');

    // Read through the schema owner, which is *not* subject to RLS: if the raw
    // identifier were anywhere in this row, this read would find it.
    const row = await pg.pool('migrator').query<{
      payload: string;
      response: string | null;
      contains_phi: boolean;
      size_bytes: number;
    }>(
      `SELECT payload_redacted::text AS payload, response_redacted::text AS response,
              contains_phi, size_bytes
         FROM integration.ihub_messages WHERE id = $1`,
      [outcome.messageId],
    );
    const stored = row.rows[0];
    expect(stored).toBeDefined();
    const haystack = `${stored?.payload ?? ''}\n${stored?.response ?? ''}`;

    // The assertions that matter are the absences.
    expect(haystack).not.toContain(PHI_SAMPLE.abhaNumber);
    expect(haystack).not.toContain('11223344556677');
    expect(haystack).not.toContain(PHI_SAMPLE.mobile);
    expect(haystack).not.toContain('9876543210');
    expect(haystack).not.toContain(PHI_SAMPLE.aadhaar);
    expect(haystack).not.toContain('Ramesh');
    expect(haystack).not.toContain('Nehru Nagar');
    expect(haystack).not.toContain('chest pain');
    expect(haystack).not.toContain(PHI_SAMPLE.email);

    // …and that the typed tokens EN-017 §5 specifies are what took their place.
    expect(haystack).toContain('«abha:6677»');
    expect(haystack).toContain('«phone:3210»');
    expect(stored?.contains_phi).toBe(true);
    expect(stored?.size_bytes).toBeGreaterThan(0);

    // The full payload is retrievable only through the payload store, which is
    // where the encryption and the `ihub.payload.read` gate live.
    expect(payloads.size).toBeGreaterThan(0);
  });

  it('returns the original message id on a duplicate dispatch instead of sending twice', async () => {
    const connector = await liveConnector(ctxA, nullEchoConnectorConfig({ key: 'log-idempotent' }));
    const refId = newId();

    const first = await hub.dispatcher.dispatch(ctxA, {
      connectorKey: connector.key,
      operationKey: 'echo',
      payload: { order: 1 },
      refType: 'order',
      refId,
    });
    const second = await hub.dispatcher.dispatch(ctxA, {
      connectorKey: connector.key,
      operationKey: 'echo',
      payload: { order: 1 },
      refType: 'order',
      refId,
    });

    expect(second.status).toBe('duplicate');
    expect(second.messageId).toBe(first.messageId);
  });

  it('is append-only to the application role', async () => {
    // `REVOKE DELETE ON integration.ihub_messages FROM hms_app`. Only
    // `hms_retention` prunes, and only by detaching a whole month.
    await expect(
      hub.db.withTenant(ctxA, (tx) => tx.query('DELETE FROM integration.ihub_messages')),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('dead-letter queue and replay', () => {
  it('sends a non-retryable failure straight to the DLQ, then replays it successfully', async () => {
    const connector = await liveConnector(
      ctxA,
      nullEchoConnectorConfig({
        key: 'dlq-replay',
        // 422-class: EN-017 §3.2 forbids retrying a semantic error. `times: 1`
        // means the partner recovers once the mapping is "fixed".
        failures: [{ operationKey: 'echo', errorClass: 'semantic_4xx', code: 'BAD_FIELD', times: 1 }],
      }),
    );

    const failed = await hub.dispatcher.dispatch(ctxA, {
      connectorKey: connector.key,
      operationKey: 'echo',
      payload: { mobile: '9876543210', order: 'ORD-1' },
      refType: 'order',
      refId: newId(),
    });

    expect(failed.status).toBe('dead_lettered');
    if (failed.status !== 'dead_lettered') throw new Error('unreachable');
    expect(failed.errorClass).toBe('semantic_4xx');
    // Not retried: one attempt, and the retry budget untouched.
    expect(failed.attempts).toBe(1);

    const open = await hub.openDeadLetters(ctxA);
    const item = open.find((i) => i.id === failed.dlqItemId);
    expect(item?.status).toBe('open');
    expect(item?.occurrences).toBe(1);
    expect(item?.sampleMessageId).toBe(failed.messageId);

    const replayed = await hub.dispatcher.replayDlqItem(ctxA, failed.dlqItemId);
    expect(replayed.status).toBe('acknowledged');
    expect(replayed.messageId).not.toBe(failed.messageId);

    const rows = await pg.pool('migrator').query<{ id: string; status: string; parent: string | null }>(
      `SELECT id, status::text AS status, parent_message_id AS parent
         FROM integration.ihub_messages
        WHERE id = ANY($1::uuid[]) ORDER BY created_at`,
      [[failed.messageId, replayed.messageId]],
    );
    const original = rows.rows.find((r) => r.id === failed.messageId);
    const retry = rows.rows.find((r) => r.id === replayed.messageId);
    // Append-only: the original is *marked* replayed, not rewritten, and the
    // new attempt points back at it so the chain is reconstructible.
    expect(original?.status).toBe('replayed');
    expect(retry?.status).toBe('acknowledged');
    expect(retry?.parent).toBe(failed.messageId);

    const afterReplay = await hub.db.withTenant(ctxA, (tx) => hub.dlq.get(tx, failed.dlqItemId));
    expect(afterReplay?.status).toBe('resolved');
  });

  it('groups repeated identical failures under one fingerprint rather than one item each', async () => {
    const connector = await liveConnector(
      ctxA,
      nullEchoConnectorConfig({
        key: 'dlq-fingerprint',
        failures: [{ operationKey: 'echo', errorClass: 'validation', code: 'MISSING_MRN', times: 'always' }],
      }),
    );

    const outcomes = [];
    for (let i = 0; i < 3; i += 1) {
      outcomes.push(
        await hub.dispatcher.dispatch(ctxA, {
          connectorKey: connector.key,
          operationKey: 'echo',
          payload: { n: i },
          refType: 'order',
          refId: newId(),
        }),
      );
    }

    const ids = new Set(outcomes.map((o) => (o.status === 'dead_lettered' ? o.dlqItemId : 'other')));
    expect(ids.size).toBe(1);

    const [dlqItemId] = [...ids];
    const item = await hub.db.withTenant(ctxA, (tx) => hub.dlq.get(tx, dlqItemId ?? ''));
    expect(item?.occurrences).toBe(3);
  });

  it('refuses to replay a message whose payload is past its retention window', async () => {
    const connector = await liveConnector(
      ctxA,
      nullEchoConnectorConfig({
        key: 'dlq-purged',
        failures: [{ operationKey: 'echo', errorClass: 'validation', code: 'GONE', times: 'always' }],
      }),
    );
    const failed = await hub.dispatcher.dispatch(ctxA, {
      connectorKey: connector.key,
      operationKey: 'echo',
      payload: { note: 'x' },
      refType: 'order',
      refId: newId(),
    });
    if (failed.status !== 'dead_lettered') throw new Error('expected a dead letter');

    // Simulate the 30-day payload retention job having run. Replaying the
    // redacted copy would deliver `«phone:9876»` to the partner, so the only
    // correct behaviour is a loud refusal.
    payloads.purgeAll();

    const outcome = await hub.dispatcher.replayDlqItem(ctxA, failed.dlqItemId);
    expect(outcome.status).toBe('dead_lettered');
    if (outcome.status !== 'dead_lettered') throw new Error('unreachable');
    expect(outcome.errorClass).toBe('payload_purged');
  });
});

describe('circuit breaker', () => {
  it('opens after the configured failures, parks traffic, then recovers through a half-open probe', async () => {
    const connector = await liveConnector(
      ctxA,
      nullEchoConnectorConfig({
        key: 'circuit-recovery',
        // Fails three times, then the partner is back.
        failures: [{ operationKey: 'echo', errorClass: 'network', times: 3 }],
        failureThreshold: 3,
        coolDownSec: 60,
        maxAttempts: 1,
      }),
    );

    for (let i = 0; i < 3; i += 1) {
      const outcome = await hub.dispatcher.dispatch(ctxA, {
        connectorKey: connector.key,
        operationKey: 'echo',
        payload: { n: i },
        refType: 'order',
        refId: newId(),
      });
      expect(outcome.status).toBe('dead_lettered');
    }

    const opened = await pg
      .pool('migrator')
      .query<{ state: string; consecutive_failures: number; next_probe_at: Date | null }>(
        `SELECT state::text AS state, consecutive_failures, next_probe_at
           FROM integration.ihub_circuit_state WHERE connector_id = $1`,
        [connector.id],
      );
    expect(opened.rows[0]?.state).toBe('open');
    expect(opened.rows[0]?.consecutive_failures).toBe(3);
    expect(opened.rows[0]?.next_probe_at).not.toBeNull();

    // While open, nothing is attempted: the message is parked as `blocked`
    // rather than spending another 30-second timeout on a dead partner.
    const blocked = await hub.dispatcher.dispatch(ctxA, {
      connectorKey: connector.key,
      operationKey: 'echo',
      payload: { n: 'while-open' },
      refType: 'order',
      refId: newId(),
    });
    expect(blocked.status).toBe('blocked');
    if (blocked.status !== 'blocked') throw new Error('unreachable');
    expect(blocked.reason).toMatch(/circuit open until/);

    const blockedRow = await pg
      .pool('migrator')
      .query<{ status: string; attempts: number }>(
        `SELECT status::text AS status, attempts FROM integration.ihub_messages WHERE id = $1`,
        [blocked.messageId],
      );
    expect(blockedRow.rows[0]?.status).toBe('blocked');
    expect(blockedRow.rows[0]?.attempts).toBe(0);

    // The half-open transition is durable, not just in-process: a worker that
    // restarts mid cool-down must not send the whole backlog at the partner.
    clock.advance(61_000);
    await hub.db.withTenant(ctxA, async (tx) => {
      const key = {
        hospitalId: tenants.hospitalA,
        connectorId: connector.id,
        operationId: (await hub.connectors.get(ctxA, connector.key))?.operations[0]?.id ?? '',
      };
      const snapshot = await hub.circuits.load(tx, key);
      const decision = canAttempt(
        snapshot,
        { failureThreshold: 3, errorRatePct: 50, coolDownSec: 60, halfOpenMaxProbes: 1 },
        clock.now(),
      );
      expect(decision.allowed).toBe(true);
      expect(decision.snapshot.state).toBe('half_open');
      await hub.circuits.save(tx, key, decision.snapshot, clock.now());
    });

    const halfOpen = await pg
      .pool('migrator')
      .query<{ state: string }>(
        `SELECT state::text AS state FROM integration.ihub_circuit_state WHERE connector_id = $1`,
        [connector.id],
      );
    expect(halfOpen.rows[0]?.state).toBe('half_open');

    // The partner has recovered; the probe succeeds and the circuit closes.
    const recovered = await hub.dispatcher.dispatch(ctxA, {
      connectorKey: connector.key,
      operationKey: 'echo',
      payload: { n: 'probe' },
      refType: 'order',
      refId: newId(),
    });
    expect(recovered.status).toBe('acknowledged');

    const closed = await pg.pool('migrator').query<{ state: string; consecutive_failures: number }>(
      `SELECT state::text AS state, consecutive_failures
           FROM integration.ihub_circuit_state WHERE connector_id = $1`,
      [connector.id],
    );
    expect(closed.rows[0]?.state).toBe('closed');
    expect(closed.rows[0]?.consecutive_failures).toBe(0);
  });

  it('persists its transitions, so a restart does not hammer a dead partner', async () => {
    const connector = await liveConnector(ctxA, nullEchoConnectorConfig({ key: 'circuit-durable' }));
    const record = await hub.connectors.get(ctxA, connector.key);
    const operationId = record?.operations[0]?.id ?? '';
    const key = { hospitalId: tenants.hospitalA, connectorId: connector.id, operationId };
    const policy = { failureThreshold: 3, errorRatePct: 50, coolDownSec: 60, halfOpenMaxProbes: 1 };

    await hub.db.withTenant(ctxA, async (tx) => {
      let snapshot = await hub.circuits.load(tx, key);
      for (let i = 0; i < 3; i += 1) {
        snapshot = onFailure(snapshot, policy, clock.now(), 'partner_5xx');
      }
      await hub.circuits.save(tx, key, snapshot, clock.now());
    });

    const reloaded = await hub.db.withTenant(ctxA, (tx) => hub.circuits.load(tx, key));
    expect(reloaded.state).toBe('open');
    expect(reloaded.consecutiveFailures).toBe(3);
    expect(reloaded.errorRate).toBeGreaterThan(0);
    expect(reloaded.nextProbeAt).not.toBeNull();
  });
});

describe('health checks', () => {
  it('records a probe result, its latency and its uptime estimate', async () => {
    const connector = await liveConnector(ctxA, nullEchoConnectorConfig({ key: 'health-pass' }));

    const outcome = await hub.health.run(ctxA, connector.key);
    expect(outcome.status).toBe('pass');
    expect(outcome.consecutiveFailures).toBe(0);
    expect(outcome.transitioned).toBe(true);

    const row = await pg
      .pool('migrator')
      .query<{ last_status: string; uptime_24h: string; last_run_at: Date | null }>(
        `SELECT last_status, uptime_24h, last_run_at
           FROM integration.ihub_health_checks WHERE connector_id = $1`,
        [connector.id],
      );
    expect(row.rows[0]?.last_status).toBe('pass');
    expect(row.rows[0]?.last_run_at).not.toBeNull();
    expect(Number(row.rows[0]?.uptime_24h ?? '0')).toBeGreaterThan(0);
  });

  it('counts consecutive failures so a silently dead connector turns red', async () => {
    const connector = await liveConnector(
      ctxA,
      nullEchoConnectorConfig({ key: 'health-fail', healthStatus: 'fail' }),
    );

    await hub.health.run(ctxA, connector.key);
    const second = await hub.health.run(ctxA, connector.key);
    expect(second.status).toBe('fail');
    expect(second.consecutiveFailures).toBe(2);
  });
});

describe('tenant isolation', () => {
  it('hides a hospital A connector from a session scoped to hospital B', async () => {
    const inA = await liveConnector(ctxA, nullEchoConnectorConfig({ key: 'iso-shared-key' }));
    // Hospital B has its own connector under the *same* key, so the assertion
    // cannot pass merely because B is empty (`docs/09` §3.1).
    const inB = await liveConnector(ctxB, nullEchoConnectorConfig({ key: 'iso-shared-key' }));
    expect(inB.id).not.toBe(inA.id);

    const seenByB = await hub.connectors.get(ctxB, 'iso-shared-key');
    expect(seenByB?.id).toBe(inB.id);

    const listedByB = await hub.connectors.list(ctxB);
    expect(listedByB.map((c) => c.id)).not.toContain(inA.id);

    const listedByA = await hub.connectors.list(ctxA);
    expect(listedByA.map((c) => c.id)).toContain(inA.id);
    expect(listedByA.map((c) => c.id)).not.toContain(inB.id);
  });

  it('hides hospital A messages and circuit state from hospital B', async () => {
    const connector = await liveConnector(ctxA, nullEchoConnectorConfig({ key: 'iso-messages' }));
    const sent = await hub.dispatcher.dispatch(ctxA, {
      connectorKey: connector.key,
      operationKey: 'echo',
      payload: { mobile: '9876543210' },
      refType: 'order',
      refId: newId(),
    });
    expect(sent.status).toBe('acknowledged');

    // No `WHERE hospital_id = …` anywhere in these reads. If row-level security
    // were not doing the work, they would return A's rows.
    const fromB = await hub.db.withTenant(ctxB, async (tx) => ({
      message: await hub.messages.get(tx, sent.messageId),
      messageCount: await tx.rows<{ n: string }>('SELECT count(*)::text AS n FROM integration.ihub_messages'),
      circuits: await tx.rows<{ n: string }>(
        'SELECT count(*)::text AS n FROM integration.ihub_circuit_state WHERE connector_id = $1',
        [connector.id],
      ),
    }));
    expect(fromB.message).toBeUndefined();
    expect(fromB.circuits[0]?.n).toBe('0');

    const fromA = await hub.db.withTenant(ctxA, (tx) => hub.messages.get(tx, sent.messageId));
    expect(fromA?.id).toBe(sent.messageId);

    // And the same query from A does see it, so the read itself is sound.
    const countFromA = await hub.db.withTenant(ctxA, (tx) =>
      tx.rows<{ n: string }>('SELECT count(*)::text AS n FROM integration.ihub_messages'),
    );
    expect(Number(countFromA[0]?.n ?? '0')).toBeGreaterThan(Number(fromB.messageCount[0]?.n ?? '0'));
  });

  it('a session with no tenancy scope reads nothing at all', async () => {
    // Default-deny arrives from `core.accessible_hospital_ids()` returning an
    // empty array when `app.hospital_id` is unset — not from remembering a guard.
    const client = await pg.pool('app').connect();
    try {
      const result = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM integration.ihub_connectors',
      );
      expect(result.rows[0]?.n).toBe('0');
    } finally {
      client.release();
    }
  });
});
