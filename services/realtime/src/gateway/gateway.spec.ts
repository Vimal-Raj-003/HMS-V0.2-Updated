import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimsFor,
  collect,
  connectClient,
  createCapturingLogger,
  delay,
  IDS,
  helloOf,
  once,
  signAccessToken,
  testEnv,
  TEST_ISSUER,
  TEST_SECRET,
  type CapturedLogger,
  type TestClient,
} from '../__tests__/harness.js';
import { createAccessTokenVerifier } from '../auth/access-token.js';
import type { BoardDiff, RoomPushMessage } from '../emit/coalescing-emitter.js';
import { createMemoryPresenceStore, type PresenceStore } from '../presence/presence.js';
import { rooms, type RoomDescriptor } from '../rooms/rooms.js';
import { createGateway, type RealtimeGateway } from './gateway.js';
import type { PresenceListAck, SubscribeAck, UnsubscribeAck } from './protocol.js';

const { hospitalA, hospitalB, branchA1, branchA2, userAlice, userBob, doctorOrtho } = IDS;

let gateway: RealtimeGateway;
let port: number;
let capture: CapturedLogger;
let presence: PresenceStore;
const clients: TestClient[] = [];

async function open(token: string): Promise<TestClient> {
  const client = await connectClient(port, token);
  clients.push(client);
  return client;
}

function subscribe(
  client: TestClient,
  subscriptions: ReadonlyArray<{ room: RoomDescriptor; since?: string }>,
): Promise<SubscribeAck> {
  return new Promise((resolve) => {
    client.emit('subscribe', { subscriptions }, resolve);
  });
}

const bedboardA: RoomDescriptor = { kind: 'bedboard', hospitalId: hospitalA, branchId: branchA1 };
const bedboardB: RoomDescriptor = { kind: 'bedboard', hospitalId: hospitalB, branchId: branchA1 };
const queueA: RoomDescriptor = {
  kind: 'queue',
  hospitalId: hospitalA,
  branchId: branchA1,
  doctorId: doctorOrtho,
};

const bed = (id: string, status: string): BoardDiff => ({
  changed: { [id]: { status } },
  removed: [],
});

beforeEach(async () => {
  capture = createCapturingLogger();
  presence = createMemoryPresenceStore();
  gateway = createGateway({
    // 200 ms rather than the 1 s default keeps the suite quick; the 1 push/sec
    // guarantee itself is asserted at the emitter level with the real interval.
    env: testEnv({ REALTIME_PUSH_INTERVAL_MS: '200' }),
    logger: capture.logger,
    verifier: createAccessTokenVerifier({ secret: TEST_SECRET, issuer: TEST_ISSUER }),
    presence,
  });
  port = await gateway.listen(0);
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await gateway.close('test');
});

describe('handshake', () => {
  it('accepts a socket presenting a valid access token', async () => {
    const client = await open(await signAccessToken(claimsFor()));
    const hello = await helloOf(client);

    expect(client.connected).toBe(true);
    expect(hello.hospitalId).toBe(hospitalA);
    expect(hello.userId).toBe(userAlice);
    expect(hello.userRoom).toBe(rooms.user(hospitalA, branchA1, userAlice));
    // The reconnect story is served by the server, not by frontend folklore.
    expect(hello.snapshotPath).toBe('/api/v1/realtime/snapshot');
    expect(gateway.io.sockets.sockets.size).toBe(1);
  });

  it('refuses a garbage token and leaves nothing half-connected', async () => {
    await expect(connectClient(port, 'not-a-jwt')).rejects.toThrow('unauthorized');
    await delay(50);
    expect(gateway.io.sockets.sockets.size).toBe(0);
    expect(capture.find('realtime.handshake.rejected')).toHaveLength(1);
  });

  it('refuses an expired token', async () => {
    const token = await signAccessToken(claimsFor(), { expiresInSeconds: -60 });
    await expect(connectClient(port, token)).rejects.toThrow('unauthorized');
    await delay(50);
    expect(gateway.io.sockets.sockets.size).toBe(0);
  });

  it('refuses a token signed with another secret', async () => {
    const token = await signAccessToken(claimsFor(), {
      secret: 'an-attacker-controlled-secret-32-chars',
    });
    await expect(connectClient(port, token)).rejects.toThrow('unauthorized');
    expect(gateway.io.sockets.sockets.size).toBe(0);
  });

  it('refuses a socket with no token at all', async () => {
    await expect(connectClient(port, '')).rejects.toThrow('unauthorized');
    expect(gateway.io.sockets.sockets.size).toBe(0);
  });
});

describe('tenant isolation on rooms', () => {
  it('joins a room in the socket own hospital', async () => {
    const client = await open(await signAccessToken(claimsFor()));
    const ack = await subscribe(client, [{ room: bedboardA }, { room: queueA }]);

    expect(ack.ok).toBe(true);
    expect(ack.denied).toEqual([]);
    expect(ack.joined.map((j) => j.room)).toEqual([
      rooms.bedboard(hospitalA, branchA1),
      rooms.queue(hospitalA, branchA1, doctorOrtho),
    ]);
    expect(ack.joined[0]?.snapshotUrl).toContain('?room=');
    expect(ack.joined[0]?.snapshotUrl).toContain('&since=');
  });

  it('REFUSES to join another hospital room, and says so in the log', async () => {
    const client = await open(await signAccessToken(claimsFor()));
    const ack = await subscribe(client, [{ room: bedboardB }]);

    expect(ack.ok).toBe(false);
    expect(ack.joined).toEqual([]);
    expect(ack.denied).toEqual([
      { room: rooms.bedboard(hospitalB, branchA1), reason: 'cross_tenant' },
    ]);

    const denials = capture.find('realtime.room.join_denied');
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({
      reason: 'cross_tenant',
      tokenHospitalId: hospitalA,
      requestedHospitalId: hospitalB,
      userId: userAlice,
      level: 40, // pino warn — a security event, not a debug line
    });

    // The socket really is not in that room, so the server-side state agrees
    // with the ack it just sent.
    const sockets = await gateway.io.in(rooms.bedboard(hospitalB, branchA1)).fetchSockets();
    expect(sockets).toHaveLength(0);
  });

  it('never delivers another hospital push to a socket that asked for it', async () => {
    const client = await open(await signAccessToken(claimsFor()));
    await subscribe(client, [{ room: bedboardB }, { room: bedboardA }]);

    const received = collect(client, 'room:push', 700);
    gateway.publish(bedboardB, bed('bed-b1', 'occupied'));
    gateway.publish(bedboardA, bed('bed-a1', 'occupied'));
    const pushes = await received;

    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.room).toBe(rooms.bedboard(hospitalA, branchA1));
    expect(pushes[0]?.diff.changed['bed-b1']).toBeUndefined();
  });

  it('refuses another branch for a branch-scoped session', async () => {
    const client = await open(await signAccessToken(claimsFor()));
    const ack = await subscribe(client, [
      { room: { kind: 'bedboard', hospitalId: hospitalA, branchId: branchA2 } },
    ]);
    expect(ack.denied[0]?.reason).toBe('cross_branch');
  });

  it("refuses a colleague's personal room", async () => {
    const client = await open(await signAccessToken(claimsFor()));
    const ack = await subscribe(client, [
      { room: { kind: 'user', hospitalId: hospitalA, branchId: branchA1, userId: userBob } },
    ]);
    expect(ack.denied[0]?.reason).toBe('foreign_user_room');
  });

  it('rejects a malformed descriptor without joining anything', async () => {
    const client = await open(await signAccessToken(claimsFor()));
    const ack = await new Promise<SubscribeAck>((resolve) => {
      client.emit('subscribe', { subscriptions: [{ room: { kind: 'root' } }] }, resolve);
    });
    expect(ack.ok).toBe(false);
    expect(ack.denied).toEqual([{ room: null, reason: 'invalid_descriptor' }]);
  });

  it('unsubscribes only from rooms the socket may address', async () => {
    const client = await open(await signAccessToken(claimsFor()));
    await subscribe(client, [{ room: bedboardA }]);
    const ack = await new Promise<UnsubscribeAck>((resolve) => {
      client.emit('unsubscribe', { rooms: [bedboardA, bedboardB] }, resolve);
    });
    expect(ack.left).toEqual([rooms.bedboard(hospitalA, branchA1)]);
    expect(ack.denied[0]?.reason).toBe('cross_tenant');
  });
});

describe('push delivery and backpressure end to end', () => {
  it('delivers one coalesced push carrying the newest diff', async () => {
    const client = await open(await signAccessToken(claimsFor()));
    await subscribe(client, [{ room: bedboardA }]);

    const received = collect(client, 'room:push', 600);
    for (let i = 0; i < 40; i += 1) gateway.publish(bedboardA, bed('bed-7', `state-${i}`));
    const pushes: RoomPushMessage<BoardDiff>[] = await received;

    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.coalesced).toBe(40);
    expect(pushes[0]?.diff.changed['bed-7']).toEqual({ status: 'state-39' });
    expect(pushes[0]?.cursor).toBe(gateway.cursorFor(bedboardA));
  });

  it('tells a reconnecting client whether its cursor is still current', async () => {
    const first = await open(await signAccessToken(claimsFor()));
    const firstAck = await subscribe(first, [{ room: bedboardA }]);
    const initialCursor = firstAck.joined[0]?.cursor ?? '';
    expect(firstAck.joined[0]?.resyncRequired).toBe(false);

    gateway.publish(bedboardA, bed('bed-7', 'occupied'));
    await delay(400);

    const reconnected = await open(await signAccessToken(claimsFor()));
    const stale = await subscribe(reconnected, [{ room: bedboardA, since: initialCursor }]);
    expect(stale.joined[0]?.resyncRequired).toBe(true);
    expect(stale.joined[0]?.snapshotUrl).toContain(
      `since=${encodeURIComponent(stale.joined[0]?.cursor ?? '')}`,
    );

    const current = await subscribe(reconnected, [
      { room: bedboardA, since: stale.joined[0]?.cursor ?? '' },
    ]);
    expect(current.joined[0]?.resyncRequired).toBe(false);
  });
});

describe('presence', () => {
  it('reports a user online once, across two devices, and offline when both go', async () => {
    const token = await signAccessToken(claimsFor());
    const phone = await open(token);
    await helloOf(phone);
    const desktop = await open(token);
    await helloOf(desktop);

    const list = await new Promise<PresenceListAck>((resolve) => {
      phone.emit('presence:list', {}, resolve);
    });
    expect(list.hospitalId).toBe(hospitalA);
    expect(list.userIds).toEqual([userAlice]);

    desktop.close();
    await delay(150);
    expect(await presence.socketCount(hospitalA, userAlice)).toBe(1);

    phone.close();
    await delay(150);
    expect(await presence.listUsers(hospitalA)).toEqual([]);
  });

  it('announces a colleague coming online to presence subscribers of that tenant only', async () => {
    const watcher = await open(await signAccessToken(claimsFor()));
    await subscribe(watcher, [
      { room: { kind: 'presence', hospitalId: hospitalA, branchId: branchA1 } },
    ]);

    const change = once(watcher, 'presence:changed');
    const colleague = await open(
      await signAccessToken(claimsFor({ sub: userBob, sid: IDS.sessionAlice })),
    );
    await helloOf(colleague);

    const payload = await change;
    expect(payload).toMatchObject({ hospitalId: hospitalA, userId: userBob, status: 'online' });
  });

  it('scopes presence to the caller own hospital, from the token', async () => {
    await open(await signAccessToken(claimsFor()));
    const other = await open(await signAccessToken(claimsFor({ hid: hospitalB, sub: userBob })));
    const list = await new Promise<PresenceListAck>((resolve) => {
      other.emit('presence:list', {}, resolve);
    });
    expect(list.hospitalId).toBe(hospitalB);
    expect(list.userIds).toEqual([userBob]);
  });
});

describe('health and shutdown', () => {
  it('serves /healthz and /readyz and 404s the rest', async () => {
    const live = await fetch(`http://127.0.0.1:${port}/healthz`);
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    const missing = await fetch(`http://127.0.0.1:${port}/nope`);

    expect(live.status).toBe(200);
    expect(ready.status).toBe(200);
    expect(missing.status).toBe(404);
    expect(await ready.json()).toMatchObject({ status: 'ok', service: 'vims-realtime' });
  });

  it('warns connected clients before closing, and stops being ready', async () => {
    const client = await open(await signAccessToken(claimsFor()));
    await helloOf(client);

    const notice = once(client, 'server:shutdown');
    const closed = gateway.close('SIGTERM');
    expect(await notice).toMatchObject({ reason: 'SIGTERM' });
    await closed;

    expect(gateway.isReady()).toBe(false);
  });
});
