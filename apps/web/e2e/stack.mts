/**
 * Brings up the full stack for the browser suite and keeps it alive.
 *
 * This runs as its own ESM process rather than inside Playwright's global setup
 * for a mundane but decisive reason: Playwright compiles its TypeScript to
 * CommonJS, and `@vims/testing` and `@vims/db` are ESM that use `import.meta`.
 * Loading them there fails. Running the stack in a real ESM process also matches
 * how these packages run in production, so the setup exercises the same module
 * graph the API does.
 *
 * Writes `.stack.json` when everything is ready, then waits for SIGTERM.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSeed } from '@vims/db/seed';
import { startTestPostgres, type TestPostgres } from '@vims/testing';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const HANDOFF = join(HERE, '.stack.json');

const API_PORT = 3401;
const WEB_PORT = 3400;
const apiOrigin = `http://localhost:${API_PORT}`;
const webOrigin = `http://localhost:${WEB_PORT}`;

let pg: TestPostgres | undefined;
let api: ChildProcess | undefined;
let web: ChildProcess | undefined;

async function waitForHttp(url: string, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${what} did not become ready within ${timeoutMs}ms (last: ${last})`);
}

async function shutdown(code: number): Promise<never> {
  api?.kill('SIGTERM');
  web?.kill('SIGTERM');
  // Let the children close their pool connections before the database goes
  // away, or `pg` prints a wall of "terminating connection due to administrator
  // command" that reads like a test failure and is not one.
  await new Promise((r) => setTimeout(r, 1500));
  try {
    rmSync(HANDOFF, { force: true });
  } catch {
    // Nothing useful to do if the handoff file is already gone.
  }
  await pg?.stop();
  process.exit(code);
}

process.on('SIGTERM', () => void shutdown(0));
process.on('SIGINT', () => void shutdown(0));

pg = await startTestPostgres();

// Seeds run as the schema owner: the application role is subject to RLS and
// cannot write the code-owned catalogues, so it would silently seed nothing.
process.env['DATABASE_MIGRATE_URL'] = pg.connectionString('migrator');
await runSeed(pg.pool('migrator'), 'minimal');

const hospital = await pg
  .pool('migrator')
  .query<{ id: string }>(`SELECT id FROM core.hospitals WHERE code = 'VIMS-BLR'`);
const hospitalId = hospital.rows[0]?.id;
if (hospitalId === undefined) throw new Error('Seed did not create hospital VIMS-BLR');

api = spawn('npx', ['tsx', 'src/main.ts'], {
  cwd: join(REPO_ROOT, 'services', 'api'),
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(API_PORT),
    DATABASE_URL: pg.connectionString('app'),
    REDIS_URL: 'redis://127.0.0.1:6379',
    JWT_ACCESS_SECRET: 'e2e-access-secret-that-is-long-enough-000000',
    JWT_REFRESH_SECRET: 'e2e-refresh-secret-that-is-long-enough-00000',
    LOG_LEVEL: 'error',
  },
  stdio: 'inherit',
});
await waitForHttp(`${apiOrigin}/healthz`, 120_000, 'services/api');

web = spawn('npx', ['next', 'start', '--port', String(WEB_PORT)], {
  cwd: join(REPO_ROOT, 'apps', 'web'),
  env: { ...process.env, NODE_ENV: 'production', API_ORIGIN: apiOrigin },
  stdio: 'inherit',
});
await waitForHttp(`${webOrigin}/login`, 120_000, 'apps/web');

writeFileSync(HANDOFF, JSON.stringify({ apiOrigin, webOrigin, hospitalId }, null, 2));
process.stdout.write(`\n[stack] ready — web ${webOrigin}, api ${apiOrigin}\n`);

// Stay alive until Playwright tears the stack down.
await new Promise(() => undefined);
