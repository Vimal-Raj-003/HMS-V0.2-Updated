/**
 * Presence — who is connected, shared across gateway instances.
 *
 * Presence cannot live in a process-local `Map`: with the Redis adapter there is
 * no sticky routing, so a doctor's phone and desktop routinely land on different
 * pods. A local map would report them offline to half the fleet. The store is
 * therefore an interface with a Redis implementation for production and an
 * in-memory one for unit tests, so the *logic* (transitions, refcounting) is
 * tested without Docker and the *wiring* is tested against a real Redis.
 *
 * Keys carry a TTL because a pod killed with SIGKILL never runs its disconnect
 * handler; without expiry, one crash would leave a user permanently "online".
 * Every heartbeat refreshes it.
 */
export interface PresenceStore {
  /** Registers a socket. Returns how many sockets that user now has. */
  add(hospitalId: string, userId: string, socketId: string): Promise<number>;
  /** Deregisters a socket. Returns how many sockets that user has left. */
  remove(hospitalId: string, userId: string, socketId: string): Promise<number>;
  /** Refreshes the TTL for a still-connected socket. */
  heartbeat(hospitalId: string, userId: string): Promise<void>;
  /** User ids currently online in a hospital. Tenant-scoped by construction. */
  listUsers(hospitalId: string): Promise<string[]>;
  socketCount(hospitalId: string, userId: string): Promise<number>;
}

export type PresenceStatus = 'online' | 'offline';

export interface PresenceChange {
  readonly hospitalId: string;
  readonly branchId: string | null;
  readonly userId: string;
  readonly status: PresenceStatus;
  readonly sockets: number;
  readonly at: string;
}

export function createMemoryPresenceStore(): PresenceStore {
  const byHospital = new Map<string, Map<string, Set<string>>>();

  const usersOf = (hospitalId: string): Map<string, Set<string>> => {
    const existing = byHospital.get(hospitalId);
    if (existing !== undefined) return existing;
    const created = new Map<string, Set<string>>();
    byHospital.set(hospitalId, created);
    return created;
  };

  return {
    add(hospitalId, userId, socketId) {
      const users = usersOf(hospitalId);
      const sockets = users.get(userId) ?? new Set<string>();
      sockets.add(socketId);
      users.set(userId, sockets);
      return Promise.resolve(sockets.size);
    },
    remove(hospitalId, userId, socketId) {
      const users = usersOf(hospitalId);
      const sockets = users.get(userId);
      if (sockets === undefined) return Promise.resolve(0);
      sockets.delete(socketId);
      if (sockets.size === 0) users.delete(userId);
      return Promise.resolve(sockets.size);
    },
    heartbeat() {
      return Promise.resolve();
    },
    listUsers(hospitalId) {
      return Promise.resolve([...usersOf(hospitalId).keys()]);
    },
    socketCount(hospitalId, userId) {
      return Promise.resolve(usersOf(hospitalId).get(userId)?.size ?? 0);
    },
  };
}

/**
 * The subset of ioredis this store uses. Narrow on purpose: a store that can
 * only issue five set commands cannot accidentally grow into a second cache.
 */
export interface PresenceRedis {
  sadd(key: string, member: string): Promise<number>;
  srem(key: string, member: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
  scard(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  del(key: string): Promise<number>;
}

export interface RedisPresenceOptions {
  readonly ttlSeconds: number;
  readonly keyPrefix?: string;
}

export function createRedisPresenceStore(
  redis: PresenceRedis,
  options: RedisPresenceOptions,
): PresenceStore {
  const prefix = options.keyPrefix ?? 'rt:pres';
  // Tenant-prefixed, as `docs/07` §4 requires of every Redis key.
  const socketsKey = (hospitalId: string, userId: string): string =>
    `${prefix}:h:${hospitalId}:u:${userId}`;
  const usersKey = (hospitalId: string): string => `${prefix}:h:${hospitalId}:users`;

  return {
    async add(hospitalId, userId, socketId) {
      const key = socketsKey(hospitalId, userId);
      await redis.sadd(key, socketId);
      await redis.expire(key, options.ttlSeconds);
      await redis.sadd(usersKey(hospitalId), userId);
      await redis.expire(usersKey(hospitalId), options.ttlSeconds);
      return redis.scard(key);
    },
    async remove(hospitalId, userId, socketId) {
      const key = socketsKey(hospitalId, userId);
      await redis.srem(key, socketId);
      const remaining = await redis.scard(key);
      if (remaining === 0) {
        await redis.del(key);
        await redis.srem(usersKey(hospitalId), userId);
      }
      return remaining;
    },
    async heartbeat(hospitalId, userId) {
      await redis.expire(socketsKey(hospitalId, userId), options.ttlSeconds);
      await redis.expire(usersKey(hospitalId), options.ttlSeconds);
    },
    async listUsers(hospitalId) {
      const users = await redis.smembers(usersKey(hospitalId));
      // A user whose socket set expired is stale in the index; filter on read
      // rather than trusting the index, and let the next write clean it up.
      const live: string[] = [];
      for (const userId of users) {
        if ((await redis.scard(socketsKey(hospitalId, userId))) > 0) live.push(userId);
        else await redis.srem(usersKey(hospitalId), userId);
      }
      return live;
    },
    socketCount(hospitalId, userId) {
      return redis.scard(socketsKey(hospitalId, userId));
    },
  };
}
