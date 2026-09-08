/**
 * API surface sweep.
 *
 * Boots a fresh Postgres, seeds it at the `demo` tier, starts the API, mints a
 * role holding every permission in the catalogue, and issues one request per
 * route. The point is not to assert behaviour — it is to find the routes that
 * crash, which no unit test reaches because no unit test calls every endpoint.
 *
 * A 500 is a bug. A 400 is the schema doing its job. A 403 means the sweep's
 * own grant is wrong, not the route's.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERMISSION_CATALOGUE } from '@vims/contracts';
import { runSeed } from '@vims/db/seed';
import { startTestPostgres, type TestPostgres } from '@vims/testing';

interface Route {
  readonly file: string;
  readonly method: string;
  readonly path: string;
  readonly permission: string | null;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

const API_PORT = 3501;
const origin = `http://localhost:${API_PORT}`;
const ROUTES_FILE = join(REPO_ROOT, 'tools/sweep/routes.json');
const OUT_FILE = join(REPO_ROOT, 'tools/sweep/sweep-results.json');
const routes = JSON.parse(readFileSync(ROUTES_FILE, 'utf8')) as Route[];

let pg: TestPostgres | undefined;
let api: ChildProcess | undefined;

async function waitFor(url: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
      last = `HTTP ${String(r.status)}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`not ready: ${url} (${last})`);
}

async function main(): Promise<void> {
  process.stdout.write('[sweep] starting postgres\n');
  pg = await startTestPostgres();
  process.env['DATABASE_MIGRATE_URL'] = pg.connectionString('migrator');

  process.stdout.write('[sweep] seeding (demo)\n');
  await runSeed(pg.pool('migrator'), 'demo');

  const pool = pg.pool('migrator');
  const hosp = await pool.query<{ id: string; code: string }>(
    `SELECT id, code FROM core.hospitals WHERE code = 'VIMS-BLR'`,
  );
  const hospitalId = hosp.rows[0]?.id;
  if (hospitalId === undefined) throw new Error('no hospital');

  // A role holding every key in the catalogue. The sweep is looking for
  // crashes, and a 403 would just hide one.
  process.stdout.write('[sweep] minting an all-permissions role\n');
  const roleId = await pool
    .query<{ id: string }>(
      `INSERT INTO core.roles (id, hospital_id, key, name, description, home_workspace, category, updated_at)
       VALUES (gen_random_uuid(), $1, 'sweep_all', 'Sweep', 'API sweep', 'dashboard', 'governance', now())
       RETURNING id`,
      [hospitalId],
    )
    .then((r) => r.rows[0]?.id);
  if (roleId === undefined) throw new Error('no role');

  for (const p of PERMISSION_CATALOGUE) {
    await pool.query(
      `INSERT INTO core.role_permissions (role_id, permission_key) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [roleId, p.key],
    );
  }

  // Reuse a seeded user's password hash so we do not need argon2 here.
  const donor = await pool.query<{ password_hash: string; branch_id: string }>(
    `SELECT u.password_hash, ur.branch_id
       FROM core.users u JOIN core.user_roles ur ON ur.user_id = u.id
      WHERE u.hospital_id = $1 AND u.password_hash IS NOT NULL
      LIMIT 1`,
    [hospitalId],
  );
  const hash = donor.rows[0]?.password_hash;
  const branchId = donor.rows[0]?.branch_id;
  if (hash === undefined || branchId === undefined) throw new Error('no donor user');

  const userId = await pool
    .query<{ id: string }>(
      `INSERT INTO core.users (id, hospital_id, group_id, username, email, name, display_name,
                               password_hash, status, type, updated_at)
       VALUES (gen_random_uuid(), $1, (SELECT group_id FROM core.hospitals WHERE id=$1),
               'sweep@vims-blr', 'sweep@example.invalid',
               '{"given":"API","family":"Sweep"}'::jsonb, 'API Sweep', $2, 'active', 'staff', now())
       RETURNING id`,
      [hospitalId, hash],
    )
    .then((r) => r.rows[0]?.id);
  await pool.query(
    `INSERT INTO core.user_roles (id, hospital_id, user_id, role_id, branch_id, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
    [hospitalId, userId, roleId, branchId],
  );

  process.stdout.write('[sweep] starting api\n');
  api = spawn('npx', ['tsx', 'src/main.ts'], {
    cwd: join(REPO_ROOT, 'services', 'api'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(API_PORT),
      DATABASE_URL: pg.connectionString('app'),
      REDIS_URL: 'redis://127.0.0.1:6379/14',
      JWT_ACCESS_SECRET: 'sweep-access-secret-that-is-long-enough-0000',
      JWT_REFRESH_SECRET: 'sweep-refresh-secret-that-is-long-enough-000',
      RATE_LIMIT_AUTH_MAX: '100000',
      LOG_LEVEL: 'error',
    },
    stdio: 'inherit',
  });
  await waitFor(`${origin}/healthz`, 180_000);

  const login = await fetch(`${origin}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hospitalId, identifier: 'sweep@vims-blr', password: 'VimsDev#2026' }),
  });
  const body = (await login.json()) as { accessToken?: string };
  const token = body.accessToken;
  if (token === undefined) throw new Error(`login failed: ${String(login.status)}`);

  const targets = routes.filter((r) => !r.path.includes(':'));
  process.stdout.write(`[sweep] ${String(targets.length)} parameterless routes\n`);

  const results: {
    method: string;
    path: string;
    status: number;
    file: string;
    detail: string;
  }[] = [];

  for (const r of targets) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-reason': 'API surface sweep, checking for crashes.',
    };
    if (r.method !== 'GET') headers['idempotency-key'] = crypto.randomUUID();

    let status = 0;
    let detail = '';
    try {
      const res = await fetch(`${origin}/api/v1${r.path}`, {
        method: r.method,
        headers,
        ...(r.method === 'GET' ? {} : { body: '{}' }),
      });
      status = res.status;
      if (status >= 500) {
        const text = await res.text();
        detail = text.slice(0, 300);
      }
    } catch (e) {
      status = -1;
      detail = e instanceof Error ? e.message : String(e);
    }
    results.push({ method: r.method, path: r.path, status, file: r.file, detail });
  }

  writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));

  const byStatus = new Map<number, number>();
  for (const r of results) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  process.stdout.write('\n[sweep] status distribution\n');
  for (const [s, n] of [...byStatus.entries()].sort((a, b) => a[0] - b[0])) {
    process.stdout.write(`  ${String(s)}: ${String(n)}\n`);
  }

  const broken = results.filter((r) => r.status >= 500 || r.status === -1);
  process.stdout.write(`\n[sweep] ${String(broken.length)} route(s) crashed\n`);
  for (const b of broken) {
    process.stdout.write(`  ${b.method} ${b.path}\n     ${b.detail.replace(/\n/g, ' ')}\n`);
  }

  api.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1000));
  await pg.stop();
  process.exit(0);
}

main().catch(async (e: unknown) => {
  process.stderr.write(`[sweep] ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  api?.kill('SIGTERM');
  await pg?.stop();
  process.exit(1);
});
