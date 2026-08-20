import { startTestRedis, type TestRedis } from '@vims/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SERVICE_ROOT,
  buildService,
  freePort,
  startService,
  type RunningService,
} from './__tests__/service-process.js';

/**
 * `services/realtime` could not be started from `dist/` at all until
 * `@vims/contracts` gained a build output: `src/rooms/rooms.ts` imports
 * `@vims/contracts/primitives`, the manifest pointed that at a `.ts` file, and
 * Node refused to resolve it. Every unit and integration test in this service
 * passed throughout, because they run under Vite, which compiles TypeScript.
 *
 * This suite closes that gap the only way it can be closed: by building the
 * service and running the artefact as a separate OS process.
 */
let redis: TestRedis;
let service: RunningService;
let port: number;

beforeAll(async () => {
  await buildService();
  redis = await startTestRedis();
  port = await freePort();

  service = startService(SERVICE_ROOT, {
    NODE_ENV: 'test',
    PORT: String(port),
    REDIS_URL: redis.connectionString(),
    // Same secret contract as the API; 32 chars is the schema's floor.
    JWT_ACCESS_SECRET: 'realtime-startup-spec-secret-0123456789',
    JWT_ISSUER: 'vims-hms',
    REALTIME_SHUTDOWN_GRACE_MS: '10000',
    LOG_LEVEL: 'info',
  });

  await service.waitForOutput(
    (out) => out.includes('"event":"realtime.started"'),
    'realtime.started',
    60_000,
  );
}, 600_000);

afterAll(async () => {
  await service?.stop('SIGKILL');
  await redis?.stop();
});

describe('services/realtime starts from its build output', () => {
  it('binds the gateway port it was given', () => {
    expect(service.output()).toContain(`"port":${port}`);
  });

  it('answers its health endpoint', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(response.status).toBe(200);
  });

  it('drains and exits 0 on SIGTERM', async () => {
    const code = await service.stop('SIGTERM');
    const out = service.output();
    expect(out).toContain('"event":"realtime.shutdown.begin"');
    expect(out).toContain('"event":"realtime.shutdown.complete"');
    expect(out).not.toContain('"event":"realtime.shutdown.forced"');
    expect(code).toBe(0);
  }, 60_000);
});
