import Redis from 'ioredis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

/**
 * Redis 7 with the one setting that matters for correctness.
 *
 * `maxmemory-policy noeviction` matches `infra/docker/docker-compose.dev.yml`:
 * BullMQ job payloads and the refresh-token denylist must never be silently
 * evicted. A test suite running against a default `allkeys-lru` Redis would not
 * reproduce the failure mode we most need to be sure about — a queued
 * critical-result notification quietly disappearing under memory pressure.
 */

const IMAGE = 'redis:7.4-alpine';

export interface TestRedis {
  readonly container: StartedTestContainer;
  readonly host: string;
  readonly port: number;
  connectionString(): string;
  client(): Redis;
  stop(): Promise<void>;
}

export async function startTestRedis(): Promise<TestRedis> {
  const container = await new GenericContainer(IMAGE)
    .withExposedPorts(6379)
    .withCommand(['redis-server', '--maxmemory-policy', 'noeviction', '--appendonly', 'no'])
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(6379);
  const clients: Redis[] = [];

  return {
    container,
    host,
    port,
    connectionString() {
      return `redis://${host}:${port}`;
    },
    client() {
      const client = new Redis({ host, port, maxRetriesPerRequest: null });
      clients.push(client);
      return client;
    },
    async stop() {
      for (const client of clients) client.disconnect();
      await container.stop();
    },
  };
}
