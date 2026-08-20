import { startTestPostgres, type TestPostgres } from '@vims/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SERVICE_ROOT,
  buildService,
  freePort,
  startService,
  waitForHttp,
  type RunningService,
} from './__tests__/service-process.js';

/**
 * Like `services/realtime`, this service could not run from `dist/` until
 * `@vims/contracts` shipped JavaScript — `hub.ts` imports `newId` from it and
 * `db/database.ts` imports `@vims/db/tenancy`.
 *
 * It also could not be *rolled*: `main()` constructed the hub, logged the
 * adapter catalogue and exited, so there was nothing for an orchestrator's
 * readiness probe to gate a deploy on. The process now stays up, serves
 * `/healthz` and `/readyz`, and drains on SIGTERM — which is what this asserts.
 */
let pg: TestPostgres;
let service: RunningService;
let port: number;

beforeAll(async () => {
  await buildService();
  pg = await startTestPostgres();
  port = await freePort();

  service = startService(SERVICE_ROOT, {
    NODE_ENV: 'test',
    PORT: String(port),
    DATABASE_URL: pg.connectionString('app'),
    IHUB_HEALTH_INTERVAL_MS: '5000',
    IHUB_SHUTDOWN_GRACE_MS: '10000',
    LOG_LEVEL: 'info',
  });

  await service.waitForOutput((out) => out.includes('"event":"ihub.started"'), 'ihub.started', 60_000);
}, 600_000);

afterAll(async () => {
  await service?.stop('SIGKILL');
  await pg?.stop();
});

describe('services/integration-hub starts from its build output', () => {
  it('constructs the hub and reports its adapter catalogue', () => {
    expect(service.output()).toContain('null-echo');
  });

  it('is ready once the database answers', async () => {
    const ready = await waitForHttp(`http://127.0.0.1:${port}/readyz`, [200], 30_000);
    expect(JSON.parse(ready.body)).toMatchObject({ ready: true });
  });

  it('refuses to boot without DATABASE_URL rather than starting half-configured', async () => {
    const orphan = startService(SERVICE_ROOT, { NODE_ENV: 'test', PORT: String(await freePort()) });
    const code = await orphan.exited();
    expect(code).toBe(1);
    expect(orphan.output()).toContain('ihub.boot.failed');
    expect(orphan.output()).toContain('DATABASE_URL');
  }, 60_000);

  it('drains and exits 0 on SIGTERM', async () => {
    const code = await service.stop('SIGTERM');
    const out = service.output();
    expect(out).toContain('"event":"ihub.shutdown.begin"');
    expect(out).toContain('"event":"ihub.shutdown.complete"');
    expect(code).toBe(0);
  }, 60_000);
});
