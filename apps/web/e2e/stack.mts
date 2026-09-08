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
import { once } from 'node:events';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSeed } from '@vims/db/seed';
import { startTestPostgres, type TestPostgres } from '@vims/testing';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const HANDOFF = join(HERE, '.stack.json');

const API_PORT = 3401;
const WEB_PORT = 3400;
/** Kept out of `.next` so a running `next dev` cannot clobber it. */
const E2E_DIST_DIR = '.next-e2e';
const apiOrigin = `http://localhost:${API_PORT}`;
const webOrigin = `http://localhost:${WEB_PORT}`;

/**
 * Held on one object rather than in three `let`s.
 *
 * `shutdown` closes over these and is registered before any of them exists, so
 * they cannot be `const` bindings — but the object can be, and mutating its
 * properties says what is actually going on: one bag of running things that the
 * signal handlers need a reference to from the start.
 */
const running: {
  pg?: TestPostgres;
  api?: ChildProcess;
  web?: ChildProcess;
} = {};

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
  running.api?.kill('SIGTERM');
  running.web?.kill('SIGTERM');
  // Let the children close their pool connections before the database goes
  // away, or `pg` prints a wall of "terminating connection due to administrator
  // command" that reads like a test failure and is not one.
  await new Promise((r) => setTimeout(r, 1500));
  try {
    rmSync(HANDOFF, { force: true });
  } catch {
    // Nothing useful to do if the handoff file is already gone.
  }
  await running.pg?.stop();
  process.exit(code);
}

process.on('SIGTERM', () => void shutdown(0));
process.on('SIGINT', () => void shutdown(0));

// `@vims/db`'s exports map sends `@vims/db/seed` to `dist/` unless the
// `development` condition is set, and neither this process nor the API child it
// spawns sets it — so this suite seeds from the last *built* copy of the seed
// rather than the source in front of you. A seed change is then silently not
// under test until somebody happens to rebuild, which is how three logins per
// role were added and the suite could not sign in as any of them.
//
// Building it here rather than changing the resolution keeps this process and
// the API child on the same copy, which is the property that actually matters.
process.stdout.write('[stack] building @vims/db so the seed is the current one\n');
await once(
  spawn('pnpm', ['--filter', '@vims/db', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' }),
  'exit',
).then(([code]) => {
  if (code !== 0) throw new Error(`@vims/db build failed with code ${String(code)}`);
});

running.pg = await startTestPostgres();

// Seeds run as the schema owner: the application role is subject to RLS and
// cannot write the code-owned catalogues, so it would silently seed nothing.
process.env['DATABASE_MIGRATE_URL'] = running.pg.connectionString('migrator');

// `demo`, not `minimal`. The minimal tier deliberately skips
// `seedModuleConfiguration`, and that step is what writes `core.lic_entitlements`
// — so a minimally-seeded tenant has no licence document at all, and every
// screen carrying an `entitlement` renders "not licensed" instead of itself.
// Seven tests in this suite assert exactly those screens (the vitals room, the
// consultation, the appointment book, the cash counter), and they had been
// failing against a tenant that could not lawfully open any of them. The
// suite's own queue-console test is the tell: it passes, and its name says
// "and is never licence-gated".
await runSeed(running.pg.pool('migrator'), 'demo');

const hospital = await running.pg
  .pool('migrator')
  .query<{ id: string }>(`SELECT id FROM core.hospitals WHERE code = 'VIMS-BLR'`);
const hospitalId = hospital.rows[0]?.id;
if (hospitalId === undefined) throw new Error('Seed did not create hospital VIMS-BLR');

running.api = spawn('npx', ['tsx', 'src/main.ts'], {
  cwd: join(REPO_ROOT, 'services', 'api'),
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(API_PORT),
    DATABASE_URL: running.pg.connectionString('app'),
    // Database 15, not the default 0. Postgres is isolated per run by
    // Testcontainers but Redis was not, so auth rate-limit windows, lockout
    // counters and sessions were shared with whatever the developer had running
    // — and with the previous run of this very suite.
    REDIS_URL: 'redis://127.0.0.1:6379/15',
    JWT_ACCESS_SECRET: 'e2e-access-secret-that-is-long-enough-000000',
    JWT_REFRESH_SECRET: 'e2e-refresh-secret-that-is-long-enough-00000',
    // `RATE_LIMIT_AUTH_MAX` defaults to 10 sign-ins per minute, which is the
    // right production budget for a credential-stuffing target and the wrong
    // one for a suite that signs in on nearly every test: each test gets a fresh
    // context, and three projects run the same ~60 tests, so the suite trips its
    // own limiter and reports the 429 as "still on /login" — a failure that
    // moves around between runs depending on timing. No test in this suite
    // asserts rate limiting, so nothing is hidden by lifting it here; the limit
    // itself is covered by the API's own integration tests.
    RATE_LIMIT_AUTH_MAX: '10000',
    LOG_LEVEL: 'error',
  },
  stdio: 'inherit',
});
await waitForHttp(`${apiOrigin}/healthz`, 120_000, 'services/api');

// Build into a directory `next dev` does not own (see `distDir` in
// `apps/web/next.config.ts`), so a dev server running alongside this suite
// cannot overwrite the build being served. Building here rather than relying on
// a prior `pnpm --filter @vims/web build` also makes `pnpm test:e2e` correct on
// its own; CI still builds first, and that build is simply not the one used.
// `NODE_ENV` is typed as the literal union on `ProcessEnv`, so the widened
// string from an object literal does not satisfy it under
// `exactOptionalPropertyTypes`. Annotating the constant is the honest fix —
// the value really is one of those three.
const WEB_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'production',
  NEXT_DIST_DIR: E2E_DIST_DIR,
};

process.stdout.write(`[stack] building apps/web into ${E2E_DIST_DIR}\n`);

// `next build` rewrites the tracked `next-env.d.ts` to point its route-types
// reference at whatever `distDir` it was given. Running this suite therefore
// left a modified file in the working tree that the lint rule then refuses to
// commit — a green test run that breaks the next commit. Snapshot it here and
// put it back afterwards.
const NEXT_ENV = join(REPO_ROOT, 'apps', 'web', 'next-env.d.ts');
const nextEnvBefore = readFileSync(NEXT_ENV, 'utf8');

await once(
  spawn('npx', ['next', 'build'], {
    cwd: join(REPO_ROOT, 'apps', 'web'),
    env: WEB_ENV,
    stdio: 'inherit',
  }),
  'exit',
).then(([code]) => {
  if (code !== 0) throw new Error(`apps/web build failed with code ${String(code)}`);
});

writeFileSync(NEXT_ENV, nextEnvBefore);

running.web = spawn('npx', ['next', 'start', '--port', String(WEB_PORT)], {
  cwd: join(REPO_ROOT, 'apps', 'web'),
  // PE-011: the landing page's assistant renders only when it has been told
  // which hospital it speaks for. Read at request time rather than baked into
  // the build, which is why it belongs on `next start` and not on `next build`.
  env: { ...WEB_ENV, API_ORIGIN: apiOrigin, LANDING_HOSPITAL_ID: hospitalId },
  stdio: 'inherit',
});
await waitForHttp(`${webOrigin}/login`, 120_000, 'apps/web');

writeFileSync(HANDOFF, JSON.stringify({ apiOrigin, webOrigin, hospitalId }, null, 2));
process.stdout.write(`\n[stack] ready — web ${webOrigin}, api ${apiOrigin}\n`);

// Stay alive until Playwright tears the stack down.
await new Promise(() => undefined);
