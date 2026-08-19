import { createAdapter } from '@socket.io/redis-adapter';
import { startTestRedis, type TestRedis } from '@vims/testing/containers';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimsFor,
  collect,
  connectClient,
  createCapturingLogger,
  delay,
  helloOf,
  IDS,
  signAccessToken,
  testEnv,
  TEST_ISSUER,
  TEST_SECRET,
  type TestClient,
} from '../__tests__/harness.js';
import { createAccessTokenVerifier } from '../auth/access-token.js';
import type { BoardDiff } from '../emit/coalescing-emitter.js';
import { createRedisPresenceStore } from '../presence/presence.js';
import { rooms, type RoomDescriptor } from '../rooms/rooms.js';
import { createGateway, type RealtimeGateway } from './gateway.js';
import type { PresenceListAck, SubscribeAck } from './protocol.js';

/**
 * The whole point of the Redis adapter, proved rather than assumed.
 *
 * `docs/01` §6 says sticky sessions are not required. That claim is only true if
 * a message published on the instance a *domain event* happened to reach comes
 * out of the instance the *client* happens to be connected to. Every other test
 * in this service runs a single in-process gateway and therefore cannot tell the
 * difference between a working adapter and no adapter at all.
 *
 * So: two gateways, one Redis, a client on B, a publish on A.
 */
const { hospitalA, hospitalB, branchA1, userCarol, userDan } = IDS;

const bedboardA: RoomDescriptor = { kind: 'bedboard', hospitalId: hospitalA, branchId: branchA1 };
const bedboardB: RoomDescriptor = { kind: 'bedboard', hospitalId: hospitalB, branchId: branchA1 };

let redis: TestRedis;
let instanceA: RealtimeGateway;
let instanceB: RealtimeGateway;
let portA = 0;
let portB = 0;
const openClients: TestClient[] = [];
const redisClients: Redis[] = [];

async function startInstance(): Promise<{ gateway: RealtimeGateway; port: number }> {
  const pub = redis.client();
  const sub = redis.client();
  const presenceClient = redis.client();
  redisClients.push(pub, sub, presenceClient);

  const gateway = createGateway({
    env: testEnv({ REDIS_URL: redis.connectionString(), REALTIME_PUSH_INTERVAL_MS: '100' }),
    logger: createCapturingLogger().logger,
    verifier: createAccessTokenVerifier({ secret: TEST_SECRET, issuer: TEST_ISSUER }),
    presence: createRedisPresenceStore(presenceClient, { ttlSeconds: 60 }),
    installAdapter: (io) => {
      io.adapter(createAdapter(pub, sub));
    },
  });
  const port = await gateway.listen(0);
  return { gateway, port };
}

async function open(port: number, token: string): Promise<TestClient> {
  const client = await connectClient(port, token);
  openClients.push(client);
  await helloOf(client);
  return client;
}

function subscribe(client: TestClient, room: RoomDescriptor): Promise<SubscribeAck> {
  return new Promise((resolve) => {
    client.emit('subscribe', { subscriptions: [{ room }] }, resolve);
  });
}

beforeAll(async () => {
  redis = await startTestRedis();
  const a = await startInstance();
  const b = await startInstance();
  instanceA = a.gateway;
  instanceB = b.gateway;
  portA = a.port;
  portB = b.port;
  // The adapter subscribes asynchronously; publishing before it has is a race,
  // not a bug in the adapter.
  await delay(500);
});

afterAll(async () => {
  for (const client of openClients.splice(0)) client.close();
  await instanceA.close('test');
  await instanceB.close('test');
  // Let the disconnect handlers finish their presence writes before the
  // connections they need are pulled out from under them.
  await delay(300);
  for (const client of redisClients) client.disconnect();
  await redis.stop();
});

describe('two gateway instances sharing one Redis adapter', () => {
  it('delivers a push made on instance A to a client connected to instance B', async () => {
    const client = await open(portB, await signAccessToken(claimsFor()));
    const ack = await subscribe(client, bedboardA);
    expect(ack.ok).toBe(true);

    // Nobody is connected to instance A at all — if this arrives, it arrived
    // over Redis pub/sub.
    expect(instanceA.io.sockets.sockets.size).toBe(0);
    expect(instanceB.io.sockets.sockets.size).toBe(1);

    const received = collect(client, 'room:push', 800);
    instanceA.publish(bedboardA, { changed: { 'bed-12': { status: 'occupied' } }, removed: [] });
    const pushes = await received;

    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.room).toBe(rooms.bedboard(hospitalA, branchA1));
    expect((pushes[0]?.diff as BoardDiff).changed['bed-12']).toEqual({ status: 'occupied' });
  });

  it('still coalesces across instances — a burst on A is one push on B', async () => {
    const client = await open(portB, await signAccessToken(claimsFor()));
    await subscribe(client, bedboardA);

    const received = collect(client, 'room:push', 800);
    for (let i = 0; i < 60; i += 1) {
      instanceA.publish(bedboardA, { changed: { 'bed-3': { status: `s${i}` } }, removed: [] });
    }
    const pushes = await received;

    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.coalesced).toBe(60);
    expect((pushes[0]?.diff as BoardDiff).changed['bed-3']).toEqual({ status: 's59' });
  });

  it('does not leak another tenant push across instances', async () => {
    const client = await open(portB, await signAccessToken(claimsFor()));
    const denied = await subscribe(client, bedboardB);
    expect(denied.denied[0]?.reason).toBe('cross_tenant');

    const received = collect(client, 'room:push', 600);
    instanceA.publish(bedboardB, { changed: { 'bed-x': { status: 'occupied' } }, removed: [] });
    expect(await received).toHaveLength(0);
  });

  it('shares presence across instances through Redis', async () => {
    // Start from a clean slate: the sockets the earlier cases opened are still
    // connected, and presence is deliberately a live view of *all* of them.
    for (const client of openClients.splice(0)) client.close();
    await delay(400);

    const onA = await open(portA, await signAccessToken(claimsFor({ sub: userCarol })));
    await open(portB, await signAccessToken(claimsFor({ sub: userDan })));
    const asker = openClients[openClients.length - 1] as TestClient;

    const seenFromB = await new Promise<PresenceListAck>((resolve) => {
      asker.emit('presence:list', {}, resolve);
    });
    // A user connected to instance A is visible to a client on instance B only
    // because presence lives in Redis rather than in a process-local map.
    expect([...seenFromB.userIds].sort()).toEqual([userCarol, userDan].sort());

    onA.close();
    await delay(400);

    const afterLeaving = await new Promise<PresenceListAck>((resolve) => {
      asker.emit('presence:list', {}, resolve);
    });
    expect(afterLeaving.userIds).toEqual([userDan]);
  });
});
