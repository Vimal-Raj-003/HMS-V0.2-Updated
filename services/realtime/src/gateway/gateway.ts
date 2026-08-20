import { createServer, type Server as HttpServer } from 'node:http';
import type { Logger } from 'pino';
import { Server, type Socket } from 'socket.io';
import {
  readHandshakeToken,
  TokenVerificationError,
  type AccessTokenVerifier,
} from '../auth/access-token.js';
import type { RealtimeEnv } from '../config/env.js';
import {
  CoalescingEmitter,
  mergeBoardDiff,
  systemClock,
  type BoardDiff,
  type Clock,
} from '../emit/coalescing-emitter.js';
import { isCursorCurrent } from '../emit/cursor.js';
import { createHealthHandler, type HealthState } from '../health/health.js';
import type { PresenceChange, PresenceStore } from '../presence/presence.js';
import {
  buildRoom,
  canJoinRoom,
  rooms as roomBuilders,
  type RoomDescriptor,
  type RoomName,
} from '../rooms/rooms.js';
import {
  presenceListRequestSchema,
  subscribeRequestSchema,
  unsubscribeRequestSchema,
  type ClientToServerEvents,
  type DeniedRoom,
  type InterServerEvents,
  type JoinedRoom,
  type PresenceListAck,
  type ServerToClientEvents,
  type SocketData,
  type SubscribeAck,
  type UnsubscribeAck,
} from './protocol.js';

export type RealtimeServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;
export type RealtimeSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export interface GatewayDeps {
  readonly env: RealtimeEnv;
  readonly logger: Logger;
  readonly verifier: AccessTokenVerifier;
  readonly presence: PresenceStore;
  /**
   * Installs the Redis adapter. Injected rather than constructed here so the
   * unit suites can run a real gateway with the in-memory adapter, and the
   * integration suite can stand up two instances sharing one Redis.
   */
  readonly installAdapter?: (io: RealtimeServer) => void;
  readonly clock?: Clock;
}

export interface RealtimeGateway {
  readonly io: RealtimeServer;
  readonly httpServer: HttpServer;
  readonly emitter: CoalescingEmitter<BoardDiff>;
  /** Binds and returns the actual port (0 → ephemeral, which is what tests use). */
  listen(port?: number): Promise<number>;
  /** Queue a diff for a room. Coalesced to at most one push per second. */
  publish(descriptor: RoomDescriptor, diff: BoardDiff): number;
  /** The cursor a client should send as `?since=` for this room. */
  cursorFor(descriptor: RoomDescriptor): string;
  isReady(): boolean;
  close(reason?: string): Promise<void>;
}

export function createGateway(deps: GatewayDeps): RealtimeGateway {
  const { env, logger, verifier, presence } = deps;
  const clock = deps.clock ?? systemClock;

  let ready = false;
  let shuttingDown = false;
  const startedAt = clock.now();

  const health: HealthState = {
    isAlive: () => true,
    isReady: () => ready && !shuttingDown,
    details: () => ({
      service: 'vims-realtime',
      uptimeMs: clock.now() - startedAt,
      sockets: io.sockets.sockets.size,
      shuttingDown,
    }),
  };

  const httpServer = createServer(createHealthHandler(health));

  const io: RealtimeServer = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    path: '/socket.io',
    serveClient: false,
    pingInterval: env.REALTIME_PING_INTERVAL_MS,
    pingTimeout: env.REALTIME_PING_TIMEOUT_MS,
    // No sticky sessions (docs/01 §6): a client must be able to upgrade on any
    // pod, so polling must not depend on landing on the same one twice. The
    // Redis adapter is what makes that true; websocket-first keeps it cheap.
    transports: ['websocket', 'polling'],
    cors:
      env.REALTIME_CORS_ORIGINS.length > 0
        ? { origin: [...env.REALTIME_CORS_ORIGINS], credentials: true }
        : { origin: false },
  });

  deps.installAdapter?.(io);

  const emitter = new CoalescingEmitter<BoardDiff>({
    intervalMs: env.REALTIME_PUSH_INTERVAL_MS,
    merge: mergeBoardDiff,
    clock,
    logger,
    publish: (room, message) => {
      io.to(room).emit('room:push', message);
    },
  });

  /**
   * Every socket handler is asynchronous (joins, presence writes) while
   * Socket.IO's listener signature is synchronous. Running them through here
   * means a failed presence write is a logged warning, not an unhandled
   * rejection that takes the gateway — and every socket on it — down.
   */
  const run = (task: string, fn: () => Promise<void>): void => {
    void fn().catch((error: unknown) => {
      logger.warn({
        event: 'realtime.task.failed',
        task,
        message: error instanceof Error ? error.message : 'unknown',
      });
    });
  };

  // ── Handshake ─────────────────────────────────────────────────────────────
  //
  // The same access token the API verifies, verified the same way. A failure
  // here calls `next(err)`, which makes Socket.IO refuse the connection
  // outright — the socket is never added to any namespace, so there is no
  // half-connected state to reason about.
  io.use((socket, next) => {
    void (async (): Promise<void> => {
      const token = readHandshakeToken({
        auth: socket.handshake.auth,
        headers: socket.handshake.headers,
      });
      try {
        const claims = await verifier.verify(token);
        socket.data.claims = claims;
        socket.data.connectedAt = clock.now();
        next();
      } catch (error) {
        const reason = error instanceof TokenVerificationError ? error.reason : 'invalid';
        logger.warn({
          event: 'realtime.handshake.rejected',
          reason,
          socketId: socket.id,
          address: socket.handshake.address,
        });
        // The client is told "unauthorized" and nothing more: the specific
        // failure (expired vs. forged vs. wrong issuer) is an oracle.
        next(new Error('unauthorized'));
      }
    })();
  });

  io.on('connection', (socket) => {
    const claims = socket.data.claims;
    if (claims === undefined) {
      // Unreachable while the middleware above is installed. Kept because the
      // cost of being wrong is an unauthenticated socket in a clinical system.
      logger.error({ event: 'realtime.connection.unauthenticated', socketId: socket.id });
      socket.disconnect(true);
      return;
    }
    if (shuttingDown) {
      socket.emit('server:shutdown', { reason: 'draining', reconnectAfterMs: 1_000 });
      socket.disconnect(true);
      return;
    }

    const ownRoom = roomBuilders.user(claims.hid, claims.bid, claims.sub);

    run('connection.open', async () => {
      await socket.join(ownRoom);
      const sockets = await presence.add(claims.hid, claims.sub, socket.id);
      if (sockets === 1) announcePresence(claims.hid, claims.bid, claims.sub, 'online', sockets);

      logger.info({
        event: 'realtime.connection.opened',
        socketId: socket.id,
        hospitalId: claims.hid,
        branchId: claims.bid,
        userId: claims.sub,
        sessionId: claims.sid,
        sockets,
      });

      socket.emit('hello', {
        socketId: socket.id,
        hospitalId: claims.hid,
        branchId: claims.bid,
        userId: claims.sub,
        userRoom: ownRoom,
        snapshotPath: env.REALTIME_SNAPSHOT_PATH,
        pushIntervalMs: env.REALTIME_PUSH_INTERVAL_MS,
        serverTime: new Date(clock.now()).toISOString(),
      });
    });

    socket.on('subscribe', (payload, ack) => {
      run('subscribe', async () => {
        const parsed = subscribeRequestSchema.safeParse(payload);
        if (!parsed.success) {
          respond<SubscribeAck>(ack, {
            ok: false,
            joined: [],
            denied: [{ room: null, reason: 'invalid_descriptor' }],
          });
          return;
        }

        const joined: JoinedRoom[] = [];
        const denied: DeniedRoom[] = [];

        for (const request of parsed.data.subscriptions) {
          if (socket.rooms.size + joined.length > env.REALTIME_MAX_ROOMS_PER_SOCKET) {
            denied.push({ room: null, reason: 'room_limit_exceeded' });
            break;
          }

          const room = buildRoom(request.room);
          const decision = canJoinRoom(claims, room);
          if (!decision.allowed) {
            // Audit-style line. A cross-tenant attempt is a security event, not
            // a validation error: it names the token's tenant AND the requested
            // one so the two can be correlated in the SIEM (docs/04 §5).
            logger.warn({
              event: 'realtime.room.join_denied',
              reason: decision.reason,
              room,
              tokenHospitalId: claims.hid,
              requestedHospitalId: request.room.hospitalId,
              tokenBranchId: claims.bid,
              userId: claims.sub,
              sessionId: claims.sid,
              socketId: socket.id,
              address: socket.handshake.address,
            });
            denied.push({ room, reason: decision.reason });
            continue;
          }

          await socket.join(room);
          const cursor = emitter.cursorFor(room);
          joined.push({
            room,
            cursor,
            resyncRequired: !isCursorCurrent(request.since, emitter.seqFor(room)),
            snapshotUrl: snapshotUrlFor(env.REALTIME_SNAPSHOT_PATH, room, cursor),
          });
        }

        respond<SubscribeAck>(ack, { ok: denied.length === 0, joined, denied });
      });
    });

    socket.on('unsubscribe', (payload, ack) => {
      run('unsubscribe', async () => {
        const parsed = unsubscribeRequestSchema.safeParse(payload);
        if (!parsed.success) {
          respond<UnsubscribeAck>(ack, {
            ok: false,
            left: [],
            denied: [{ room: null, reason: 'invalid_descriptor' }],
          });
          return;
        }
        const left: string[] = [];
        const denied: DeniedRoom[] = [];
        for (const descriptor of parsed.data.rooms) {
          const room = buildRoom(descriptor);
          const decision = canJoinRoom(claims, room);
          if (!decision.allowed) {
            denied.push({ room, reason: decision.reason });
            continue;
          }
          await socket.leave(room);
          left.push(room);
        }
        respond<UnsubscribeAck>(ack, { ok: denied.length === 0, left, denied });
      });
    });

    socket.on('presence:list', (payload, ack) => {
      run('presence.list', async () => {
        const parsed = presenceListRequestSchema.safeParse(payload ?? {});
        if (!parsed.success) {
          respond<PresenceListAck>(ack, { ok: false, hospitalId: claims.hid, userIds: [] });
          return;
        }
        // Scoped to the caller's own hospital from the *token*, never from the
        // request: there is no way to ask this question about another tenant.
        const userIds = await presence.listUsers(claims.hid);
        respond<PresenceListAck>(ack, { ok: true, hospitalId: claims.hid, userIds });
      });
    });

    socket.on('disconnect', (reason) => {
      run('disconnect', async () => {
        const sockets = await presence.remove(claims.hid, claims.sub, socket.id);
        if (sockets === 0) announcePresence(claims.hid, claims.bid, claims.sub, 'offline', 0);
        logger.info({
          event: 'realtime.connection.closed',
          socketId: socket.id,
          hospitalId: claims.hid,
          userId: claims.sub,
          reason,
        });
      });
    });
  });

  function announcePresence(
    hospitalId: string,
    branchId: string | null,
    userId: string,
    status: PresenceChange['status'],
    sockets: number,
  ): void {
    const change: PresenceChange = {
      hospitalId,
      branchId,
      userId,
      status,
      sockets,
      at: new Date(clock.now()).toISOString(),
    };
    // Tenant-scoped room, so presence cannot cross a hospital boundary either.
    io.to(roomBuilders.presence(hospitalId, branchId)).emit('presence:changed', change);
    io.to(roomBuilders.user(hospitalId, branchId, userId)).emit('presence:changed', change);
  }

  // Presence keys expire (a SIGKILLed pod runs no disconnect handler), so
  // still-connected sockets must refresh them.
  const heartbeat = setInterval(
    () => {
      run('presence.heartbeat', async () => {
        for (const socket of io.sockets.sockets.values()) {
          const claims = socket.data.claims;
          if (claims !== undefined) await presence.heartbeat(claims.hid, claims.sub);
        }
      });
    },
    Math.max(1_000, Math.floor((env.REALTIME_PRESENCE_TTL_SECONDS * 1_000) / 3)),
  );
  heartbeat.unref?.();

  return {
    io,
    httpServer,
    emitter,
    listen(port = env.PORT): Promise<number> {
      return new Promise<number>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        httpServer.once('error', onError);
        httpServer.listen(port, () => {
          httpServer.off('error', onError);
          const address = httpServer.address();
          const bound = typeof address === 'object' && address !== null ? address.port : port;
          ready = true;
          logger.info({ event: 'realtime.listening', port: bound });
          resolve(bound);
        });
      });
    },
    publish(descriptor, diff) {
      return emitter.push(buildRoom(descriptor), diff);
    },
    cursorFor(descriptor) {
      return emitter.cursorFor(buildRoom(descriptor));
    },
    isReady: () => health.isReady(),
    async close(reason = 'shutdown'): Promise<void> {
      shuttingDown = true;
      ready = false;
      clearInterval(heartbeat);
      // Tell clients before the socket dies, so they reconnect on a schedule
      // instead of a thundering herd, and flush anything still queued: a bed
      // release that is one timer tick from being sent should leave with us.
      io.emit('server:shutdown', { reason, reconnectAfterMs: 1_000 });
      emitter.close(true);
      await new Promise<void>((resolve) => {
        void io.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      logger.info({ event: 'realtime.closed', reason });
    },
  };
}

function respond<T>(ack: ((result: T) => void) | undefined, result: T): void {
  if (typeof ack === 'function') ack(result);
}

export function snapshotUrlFor(path: string, room: RoomName, cursor: string): string {
  return `${path}?room=${encodeURIComponent(room)}&since=${encodeURIComponent(cursor)}`;
}
