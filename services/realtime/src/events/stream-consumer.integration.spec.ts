import { startTestRedis, type TestRedis } from '@vims/testing/containers';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../logger.js';
import { parseRoom, type RoomName } from '../rooms/rooms.js';
import { createStreamConsumer } from './stream-consumer.js';
import type { StreamEvent } from './event-router.js';

/**
 * The event → screen path, end to end over a real Redis.
 *
 * `services/worker` has relayed committed outbox rows to `hms:events:<hospital>`
 * since Phase 0 and nothing read them, so every board in `docs/01 §6` was a
 * screen that never updated. These assertions are what stops that recurring.
 *
 * Written against a real Redis rather than a mock because the properties under
 * test are Redis properties: consumer groups splitting a backlog across pods,
 * `XACK` after delivery, `SCAN` discovering a stream that appears later.
 */
let redis: TestRedis;
let client: Redis;
const logger = createLogger('fatal');

const HOSPITAL_A = '018f3a20-0000-7000-8000-000000000001';
const HOSPITAL_B = '018f3a20-0000-7000-8000-000000000002';
const BRANCH = '018f3a20-0000-7000-8000-000000001001';
const QUEUE = '018f3a20-0000-7000-8000-000000005001';
const DOCTOR = '018f3a20-0000-7000-8000-000000002001';

interface Delivery {
  readonly room: RoomName;
  readonly event: StreamEvent;
}

function collector() {
  const seen: Delivery[] = [];
  return {
    seen,
    deliver: (room: RoomName, event: StreamEvent): void => {
      seen.push({ room, event });
    },
  };
}

async function publish(
  hospitalId: string,
  type: string,
  payload: Record<string, unknown>,
  containsPhi = false,
): Promise<void> {
  await client.xadd(
    `hms:events:${hospitalId}`,
    '*',
    'id',
    `evt-${type}-${String(Date.now())}-${String(Math.floor(seq++))}`,
    'type',
    type,
    'aggregate',
    'queue_token',
    'aggregateId',
    '018f3a20-0000-7000-8000-000000009001',
    'schemaVersion',
    '1',
    'hospitalId',
    hospitalId,
    'branchId',
    BRANCH,
    'correlationId',
    'test',
    'traceId',
    '',
    'occurredAt',
    new Date(0).toISOString(),
    'containsPhi',
    containsPhi ? '1' : '0',
    'payload',
    JSON.stringify(payload),
  );
}

/** A counter rather than `Math.random()`: `docs/09 §2` bans ambient randomness. */
let seq = 0;

beforeAll(async () => {
  redis = await startTestRedis();
  client = redis.client();
}, 600_000);

afterAll(async () => {
  client?.disconnect();
  await redis?.stop();
});

beforeEach(async () => {
  await client.flushall();
});

describe('realtime stream consumer', () => {
  it('discovers a stream that did not exist when it started', async () => {
    const sink = collector();
    const consumer = createStreamConsumer({
      redis: client,
      logger,
      deliver: sink.deliver,
      consumer: 'pod-1',
    });

    expect(await consumer.discover()).toEqual([]);

    await publish(HOSPITAL_A, 'queue.token.called', { queueId: QUEUE, screenId: 'lobby' });
    // A hospital that starts producing after the pod booted must not be
    // invisible until the next restart.
    expect(await consumer.discover()).toEqual([`hms:events:${HOSPITAL_A}`]);
  });

  it('delivers a called token to its queue room and the lobby display', async () => {
    const sink = collector();
    const consumer = createStreamConsumer({
      redis: client,
      logger,
      deliver: sink.deliver,
      consumer: 'pod-1',
      blockMs: 50,
    });
    await consumer.discover();
    // The group is created at `$`, so it only sees what arrives after it exists.
    await consumer.tick();
    await publish(HOSPITAL_A, 'queue.token.called', { queueId: QUEUE, screenId: 'lobby' });

    const result = await consumer.tick();
    expect(result.delivered).toBe(1);
    expect(sink.seen.map((d) => parseRoom(d.room)?.kind).sort()).toEqual(['display', 'queue']);
  });

  /**
   * `EN-018 §5` over the wire, not just in the router's unit test: a TV in a
   * waiting room must never receive a patient identifier. The router decides it;
   * this proves nothing downstream puts it back.
   */
  it('never delivers a PHI event to a display room', async () => {
    const sink = collector();
    const consumer = createStreamConsumer({
      redis: client,
      logger,
      deliver: sink.deliver,
      consumer: 'pod-1',
      blockMs: 50,
    });
    await consumer.discover();
    await consumer.tick();
    await publish(HOSPITAL_A, 'queue.token.called', { queueId: QUEUE, screenId: 'lobby' }, true);

    const result = await consumer.tick();
    expect(result.withheldFromDisplays).toBe(1);
    expect(sink.seen.map((d) => parseRoom(d.room)?.kind)).not.toContain('display');
    // Withheld from the board, still delivered to the staff room.
    expect(sink.seen.length).toBeGreaterThan(0);
  });

  it('keeps each hospital events inside that hospital rooms', async () => {
    const sink = collector();
    const consumer = createStreamConsumer({
      redis: client,
      logger,
      deliver: sink.deliver,
      consumer: 'pod-1',
      blockMs: 50,
    });
    await publish(HOSPITAL_A, 'queue.token.called', { queueId: QUEUE });
    await publish(HOSPITAL_B, 'queue.token.called', { queueId: QUEUE });
    await consumer.discover();
    await consumer.tick();

    await publish(HOSPITAL_A, 'queue.token.called', { queueId: QUEUE });
    await publish(HOSPITAL_B, 'queue.token.called', { queueId: QUEUE });
    await consumer.tick();

    for (const { room, event } of sink.seen) {
      expect(parseRoom(room)?.hospitalId).toBe(event.hospitalId);
    }
    expect(new Set(sink.seen.map((d) => d.event.hospitalId))).toEqual(new Set([HOSPITAL_A, HOSPITAL_B]));
  });

  /**
   * The property that makes several pods safe. Without a consumer group each pod
   * reads every entry and every board renders each update once per pod.
   */
  it('splits a backlog between pods instead of delivering it to both', async () => {
    const one = collector();
    const two = collector();
    const shared = { redis: client, logger, consumer: '', blockMs: 50 };
    const podOne = createStreamConsumer({ ...shared, deliver: one.deliver, consumer: 'pod-1' });
    const podTwo = createStreamConsumer({ ...shared, deliver: two.deliver, consumer: 'pod-2' });

    await publish(HOSPITAL_A, 'queue.token.called', { queueId: QUEUE });
    await podOne.discover();
    await podTwo.discover();
    await podOne.tick();
    await podTwo.tick();

    for (let i = 0; i < 10; i += 1) {
      await publish(HOSPITAL_A, 'queue.token.called', { queueId: QUEUE, tokenNo: `A-${String(i)}` });
    }
    await podOne.tick();
    await podTwo.tick();

    const ids = [...one.seen, ...two.seen].map((d) => d.event.id);
    // Eleven, not ten: the entry published before either pod discovered the
    // stream is delivered too. That is the no-loss property -- a group created
    // at `'$'` would silently drop it, and this assertion is what would notice
    // if someone changed it back.
    expect(ids.length).toBe(11);
    // Exactly once each: no id appears in both pods' collections.
    expect(new Set(ids).size).toBe(11);
  });

  it('routes a critical alert to the ordering clinician', async () => {
    const sink = collector();
    const consumer = createStreamConsumer({
      redis: client,
      logger,
      deliver: sink.deliver,
      consumer: 'pod-1',
      blockMs: 50,
    });
    await consumer.discover();
    await consumer.tick();
    await publish(HOSPITAL_A, 'lab.result.critical', { orderingDoctorUserId: DOCTOR }, true);

    await consumer.tick();
    const kinds = sink.seen.map((d) => parseRoom(d.room)?.kind).sort();
    expect(kinds).toEqual(['bedboard', 'er', 'user']);
  });

  it('survives a payload that will not parse rather than losing the event', async () => {
    const sink = collector();
    const consumer = createStreamConsumer({
      redis: client,
      logger,
      deliver: sink.deliver,
      consumer: 'pod-1',
      blockMs: 50,
    });
    await consumer.discover();
    await consumer.tick();

    await client.xadd(
      `hms:events:${HOSPITAL_A}`,
      '*',
      'type',
      'lab.result.critical',
      'hospitalId',
      HOSPITAL_A,
      'branchId',
      BRANCH,
      'containsPhi',
      '1',
      'payload',
      '{not json',
    );

    const result = await consumer.tick();
    // Still routed by type. A quoting bug must not silently swallow a critical
    // alert; the rooms that do not need a payload field still get it.
    expect(result.delivered).toBe(1);
    expect(sink.seen.map((d) => parseRoom(d.room)?.kind).sort()).toEqual(['bedboard', 'er']);
  });

  /**
   * The property `XACK`-after-delivery exists for, asserted by actually killing
   * a delivery.
   *
   * Moving the `XACK` to before the push passed all eight of the other tests:
   * on the happy path the two orderings are indistinguishable, so the ordering
   * that loses a critical alert on a crash looked identical to the one that does
   * not. This is the test that separates them, and the reclaim path is what
   * makes the guarantee real rather than notional -- without `XAUTOCLAIM` the
   * entry stays pending for ever and `'>'` never returns it, so acknowledging
   * late would be no better than acknowledging early.
   */
  it('redelivers an entry whose delivery failed, and does not lose it', async () => {
    const survivor = collector();
    let explode = true;
    const dying = createStreamConsumer({
      redis: client,
      logger,
      consumer: 'pod-doomed',
      blockMs: 50,
      deliver: () => {
        if (explode) throw new Error('pod died mid-push');
      },
    });

    await publish(HOSPITAL_A, 'queue.token.called', { queueId: QUEUE });
    await dying.discover();
    await expect(dying.tick()).rejects.toThrow('pod died mid-push');

    // Unacknowledged, because the push never completed.
    const pending = (await client.xpending(`hms:events:${HOSPITAL_A}`, 'realtime')) as [number, ...unknown[]];
    expect(pending[0]).toBe(1);

    // A surviving pod claims it. `reclaimIdleMs: 0` stands in for the minute a
    // real deployment waits before deciding a pod is gone.
    explode = false;
    const healthy = createStreamConsumer({
      redis: client,
      logger,
      consumer: 'pod-healthy',
      blockMs: 50,
      reclaimIdleMs: 0,
      deliver: survivor.deliver,
    });
    await healthy.discover();
    const result = await healthy.tick();

    expect(result.reclaimed).toBe(1);
    expect(survivor.seen.length).toBeGreaterThan(0);
    const after = (await client.xpending(`hms:events:${HOSPITAL_A}`, 'realtime')) as [number, ...unknown[]];
    expect(after[0]).toBe(0);
  });

  it('acknowledges what it delivered, so a restart does not replay it', async () => {
    const sink = collector();
    const consumer = createStreamConsumer({
      redis: client,
      logger,
      deliver: sink.deliver,
      consumer: 'pod-1',
      blockMs: 50,
    });
    await consumer.discover();
    await consumer.tick();
    await publish(HOSPITAL_A, 'queue.token.called', { queueId: QUEUE });
    await consumer.tick();

    const pending = await client.xpending(`hms:events:${HOSPITAL_A}`, 'realtime');
    expect((pending as [number, ...unknown[]])[0]).toBe(0);
  });
});
